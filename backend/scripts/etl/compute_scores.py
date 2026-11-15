"""ETL step 13 - ``hs6_scores`` and ``alerts`` (docs/SPEC.md sections 3 and 4; docs/METHODOLOGY.md). Owner: C2.

For every HS6 in ``hs6_metrics`` (latest year 2024):

* export potential score, untapped export potential (US$), import dependency score, supply-chain
  vulnerability score, import substitution score, rule-based archetype (formulas in ``app.services.scoring``);
* k-means product cluster ``ml_cluster`` (k = 6, ``random_state=42``, ``n_init=10``, standardised features);
* 2025-2026 export / import forecasts with 95 % bands (``app.services.forecast``) -> ``forecast_json``;

and the automated alerts (import surge, export drop, concentrated sourcing, China dependence) with
``created_at`` = the time of this run. Both tables are fully replaced; ``meta.scores_built_at`` records the run
(the API caches key on it). The step also adds the covering indexes of :data:`ANALYTICS_INDEXES` (if missing)
that keep the per-country policy queries within the API's 1.5 s budget.

Usage
-----
* Inside the build: ``python -m scripts.build_db`` calls :func:`run` on the build connection (the build commits).
* In place on an existing database (one transaction; the API keeps serving reads thanks to WAL)::

      python -m scripts.etl.compute_scores                 # data/atlas.db (or $ATLAS_DB)
      python -m scripts.etl.compute_scores --db C:/tmp/atlas.db
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from scripts.etl import DATA_DIR, FIRST_TREND_YEAR, LATEST_YEAR

BACKEND_DIR = Path(__file__).resolve().parents[2]
if str(BACKEND_DIR) not in sys.path:  # app.services.* hold the formulas (shared with the API)
    sys.path.insert(0, str(BACKEND_DIR))

from app.services import forecast as fc  # noqa: E402
from app.services import scoring  # noqa: E402

#: Covering indexes for the per-country aggregates of the policy / value-chain endpoints (negotiation analyser,
#: bilateral totals). SQLite otherwise walks ``ix_*_country`` and fetches every table row for ``value`` (seconds
#: on the full database); with these the same queries read the index only. Tables and columns are unchanged
#: (docs/SPEC.md section 9: "add indexes / precompute instead").
ANALYTICS_INDEXES: tuple[tuple[str, str], ...] = (
    ("ix_ip_country_cov", "india_partners(country_id, flow, hs6, value)"),
    ("ix_ws_country_cov", "world_suppliers(country_id, hs6, value)"),
    ("ix_wm_country_cov", "world_markets(country_id, hs6, value)"),
)

_METRIC_COLUMNS = ("hs6", "india_exports", "india_imports", "world_trade", "rca", "world_supplier_hhi",
                   "india_import_hhi", "china_import_share", "top_import_source", "top_import_source_share",
                   "export_cagr", "import_cagr", "world_cagr", "export_yoy", "import_yoy")


def _tuples(conn: sqlite3.Connection, sql: str, params=()) -> list[tuple]:
    """Rows as tuples whatever the connection's ``row_factory`` (the API uses dict rows)."""
    cur = conn.cursor()
    cur.row_factory = None
    return cur.execute(sql, params).fetchall()


def load_records(conn: sqlite3.Connection) -> list[dict]:
    """One record per ``hs6_metrics`` row with chapter, description, 2023 values and top-source name."""
    cols = ", ".join(f"m.{c}" for c in _METRIC_COLUMNS)
    data = _tuples(conn, f"""
        SELECT {cols}, COALESCE(hp.hs2, substr(m.hs6, 1, 2)),
               COALESCE(hp.description, n.description, 'HS ' || m.hs6), c.name,
               t23.india_exports, t23.india_imports
        FROM hs6_metrics m
        LEFT JOIN hs6_products hp ON hp.hs6 = m.hs6
        LEFT JOIN hs_nodes n ON n.code = m.hs6
        LEFT JOIN countries c ON c.id = m.top_import_source
        LEFT JOIN trade_hs6 t23 ON t23.hs6 = m.hs6 AND t23.year = ?
        ORDER BY m.hs6""", (LATEST_YEAR - 1,))
    names = _METRIC_COLUMNS + ("hs2", "description", "top_import_source_name", "exports_2023", "imports_2023")
    return [dict(zip(names, r)) for r in data]


def load_series(conn: sqlite3.Connection) -> tuple[dict, dict]:
    """``({hs6: {year: exports}}, {hs6: {year: imports}})`` over 2018..2024."""
    ex: dict[str, dict[int, float]] = defaultdict(dict)
    im: dict[str, dict[int, float]] = defaultdict(dict)
    for hs6, year, x, m in _tuples(conn, "SELECT hs6, year, india_exports, india_imports FROM trade_hs6 "
                                         "WHERE year BETWEEN ? AND ?", (FIRST_TREND_YEAR, LATEST_YEAR)):
        ex[hs6][year] = x
        im[hs6][year] = m
    return ex, im


def ensure_analytics_indexes(conn: sqlite3.Connection) -> list[str]:
    """Create the :data:`ANALYTICS_INDEXES` that are missing; returns the names created."""
    existing = {r[0] for r in _tuples(conn, "SELECT name FROM sqlite_master WHERE type = 'index'")}
    created = []
    for name, target in ANALYTICS_INDEXES:
        if name not in existing:
            conn.execute(f"CREATE INDEX IF NOT EXISTS {name} ON {target}")
            created.append(name)
    return created


def _round(value, digits: int = 4):
    return None if value is None else round(float(value), digits)


def run(conn: sqlite3.Connection) -> dict:
    """Recompute ``hs6_scores`` and ``alerts`` on ``conn`` (no commit - the caller commits). Returns stats."""
    t0 = time.perf_counter()
    created_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    records = load_records(conn)
    if not records:
        conn.execute("DELETE FROM hs6_scores")
        conn.execute("DELETE FROM alerts")
        return {"hs6_scores": 0, "alerts": 0, "note": "hs6_metrics is empty - nothing scored"}

    scores = scoring.score_products(records)
    clusters = scoring.cluster_products(records)
    labels = clusters["labels"]
    ex, im = load_series(conn)

    pli_prefixes = {r[0] for r in _tuples(conn, "SELECT sp.hs_prefix FROM scheme_products sp JOIN schemes sc ON sc.id = sp.scheme_id WHERE sc.kind = 'PLI'")}
    qco_prefixes = {r[0] for r in _tuples(conn, "SELECT sp.hs_prefix FROM scheme_products sp JOIN schemes sc ON sc.id = sp.scheme_id WHERE sc.kind = 'QCO'")}
    map_status = dict(_tuples(conn, "SELECT hs6, mapping_status FROM products GROUP BY hs6"))

    rows = []
    n_forecast = 0
    for rec, sc in zip(records, scores):
        h = rec["hs6"]
        fset = fc.forecast_set(ex.get(h, {}), im.get(h, {}))
        if fset["exports"] or fset["imports"]:
            n_forecast += 1
        fset = {k: [{"year": p["year"], "value": _round(p["value"], 2), "lo": _round(p["lo"], 2),
                     "hi": _round(p["hi"], 2)} for p in v] for k, v in fset.items()}

        # Compute Product Readiness Index (PRI)
        arch = sc["archetype"]
        arch_weights = {'Champion': 92, 'Established': 80, 'Emerging': 65, 'Marginal': 40, 'Dependent': 25}
        cap_score = arch_weights.get(arch, 35)
        rca = rec.get("rca")
        if rca and rca >= 1:
            cap_score = min(100, cap_score + min(12, (rca - 1) * 4))
        opp_score = sc["export_potential_score"] if sc["export_potential_score"] is not None else 30
        pol_score = 45 if map_status.get(h) == 'accepted' else 15
        if any(h.startswith(pfx) for pfx in pli_prefixes):
            pol_score += 35
        sub = sc["substitution_score"]
        if sub and sub > 50:
            pol_score += 20
        pol_score = min(100, pol_score)
        vul_val = sc["vulnerability_score"] if sc["vulnerability_score"] is not None else 50
        std_score = (100 - vul_val) * 0.7
        if any(h.startswith(pfx) for pfx in qco_prefixes):
            std_score += 30
        std_score = min(100, max(0, std_score))
        pri = round(0.35 * cap_score + 0.25 * opp_score + 0.20 * pol_score + 0.20 * std_score, 1)
        tier = (
            'Tier 1: Export Champion' if pri >= 75 else
            'Tier 2: Scale-Ready' if pri >= 50 else
            'Tier 3: Substitution Target' if pri >= 25 else
            'Tier 4: Nascent / Policy-Lag'
        )

        rows.append((h, _round(sc["export_potential_score"]), _round(sc["untapped_potential_usd"], 2),
                     _round(sc["import_dependency_score"]), _round(sc["vulnerability_score"]),
                     _round(sc["substitution_score"]), sc["archetype"], labels.get(h),
                     json.dumps(fset, separators=(",", ":")), pri, tier))
    alerts = scoring.detect_alerts(records, created_at)

    conn.execute("DELETE FROM hs6_scores")
    conn.executemany("INSERT INTO hs6_scores(hs6, export_potential_score, untapped_potential_usd, "
                     "import_dependency_score, vulnerability_score, substitution_score, archetype, ml_cluster, "
                     "forecast_json, product_readiness_index, readiness_tier) VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)
    conn.execute("DELETE FROM alerts")
    conn.executemany("INSERT INTO alerts(kind, hs6, severity, title, detail, value, created_at) "
                     "VALUES (?,?,?,?,?,?,?)",
                     [(a["kind"], a["hs6"], a["severity"], a["title"], a["detail"], _round(a["value"]),
                       a["created_at"]) for a in alerts])
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('scores_built_at', ?)", (created_at,))
    indexes = ensure_analytics_indexes(conn)

    by_arch: dict[str, int] = defaultdict(int)
    for sc in scores:
        by_arch[sc["archetype"]] += 1
    by_kind: dict[str, int] = defaultdict(int)
    for a in alerts:
        by_kind[f"{a['kind']}:{a['severity']}"] += 1
    return {
        "hs6_scores": len(rows),
        "substitution_candidates": sum(1 for s in scores if s["substitution_score"] is not None),
        "total_untapped_usd": round(sum(s["untapped_potential_usd"] or 0 for s in scores), 0),
        "archetypes": dict(sorted(by_arch.items())),
        "clusters": {c["id"]: c["n"] for c in clusters["clusters"]},
        "forecasts": n_forecast,
        "alerts": len(alerts),
        "alerts_by_kind": dict(sorted(by_kind.items())),
        "indexes_created": indexes,
        "seconds": round(time.perf_counter() - t0, 2),
    }


def default_db_path() -> Path:
    env = os.environ.get("ATLAS_DB")
    return Path(env) if env else DATA_DIR / "atlas.db"


def main(argv: list[str] | None = None) -> int:
    """CLI: recompute scores + alerts in place in one transaction."""
    ap = argparse.ArgumentParser(prog="python -m scripts.etl.compute_scores",
                                 description="Recompute hs6_scores and alerts in place")
    ap.add_argument("--db", default=None, help="database path (default: $ATLAS_DB or data/atlas.db)")
    args = ap.parse_args(argv)
    db = Path(args.db) if args.db else default_db_path()
    if not db.exists():
        print(f"database {db} not found - run 'python -m scripts.build_db' from backend/ first")
        return 1
    conn = sqlite3.connect(str(db), timeout=60)
    try:
        conn.execute("PRAGMA busy_timeout = 60000")
        conn.execute("BEGIN IMMEDIATE")
        try:
            stats = run(conn)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    finally:
        conn.close()
    try:
        sys.stdout.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass
    print(f"compute_scores on {db}:")
    for key, value in stats.items():
        print(f"  {key}: {value}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
