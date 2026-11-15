"""Build the Atlas database end-to-end (docs/SPEC.md section 3).

Usage (run from ``backend/``)::

    python -m scripts.build_db                    # full build -> data/atlas.db
    python -m scripts.build_db --core-only        # ETL core only: steps 1-7 + meta
    python -m scripts.build_db --skip load_policy,seed_ops
    python -m scripts.build_db --db C:/tmp/atlas.db

The database is built into ``<db>.tmp`` with ``journal_mode=OFF`` / ``synchronous=OFF`` (fast bulk load),
switched to WAL when finished, and then atomically moved over ``<db>`` with ``os.replace``. If the target
is in use (Windows file lock, e.g. a running API server) the new database is kept as ``<db>.tmp`` and a
clear message explains what to do.

Steps (each module in ``scripts/etl`` exposes ``run(conn) -> dict``):

    1 schema               apply scripts/etl/schema.sql
    2 nomenclature         sections, hs_nodes, products                         (core)
    3 mapping_rules        ministries, sectors, provisional mapping, FTS       (core)
    4 load_official_mapping official DPIIT Guidebook mapping, audit table, FTS (core)
    5 trade                countries, totals, trade_hs6, hs6_products, partners (core)
    6 tariffs              tariffs                                              (core)
    7 metrics              hs6_metrics                                          (core)
    8 load_dgft_itc        DGFT ITC-HS import / export policy (public portal)    (optional)
   10 load_value_chains    value chains, clusters, chain production             (optional, B1)
   10b load_supply_tiers   supplier tiers (how deep the supply chain runs)      (optional, B1)
   11 derive_part_links    HS-text 'parts_of' edges                             (optional, B1)
   12 load_policy          schemes, agreements, councils, info, roadmap, risks  (optional, B2)
   12b load_deep_dive      markets, standards, Cluster Observatory clusters      (optional)
   13 seed_ops             demo users, data sources, sample tickets/claims      (optional, B2)
   14 compute_scores       hs6_scores, alerts                                   (optional, C2)
   15 meta                 built_at, latest_year, n_products, schema_version

A core step that is missing or fails aborts the build. An optional step whose module does not exist (or
cannot be imported because of an ImportError) is skipped with a warning; one that raises while running
aborts the build with its traceback. A sanity gate refuses to replace the live database when the new one
has an empty catalogue (e.g. after ``--skip nomenclature``).

Exit codes: 0 replaced, 1 a step failed, 2 bad arguments, 3 built but target locked (kept as ``.tmp``),
4 built but failed the sanity gate (kept as ``.tmp``).
"""
from __future__ import annotations

import argparse
import importlib
import importlib.util
import json
import os
import sqlite3
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

from scripts.etl import DATA_DIR, LATEST_YEAR, SCHEMA_PATH

CORE_STEPS = ("nomenclature", "mapping_rules", "load_official_mapping", "trade", "tradestat", "tariffs", "metrics")
OPTIONAL_STEPS = ("load_dgft_itc", "load_value_chains", "load_supply_tiers", "derive_part_links",
                  "load_policy", "load_deep_dive", "seed_ops", "compute_scores")
SCHEMA_VERSION = "1"


class BuildError(RuntimeError):
    """Raised when the build must stop; the message is shown to the user."""


# --------------------------------------------------------------------------- helpers

def default_db_path() -> Path:
    env = os.environ.get("ATLAS_DB")
    return Path(env) if env else DATA_DIR / "atlas.db"


def _remove(path: Path) -> None:
    if path.exists():
        path.unlink()


def _connect_build(tmp: Path) -> sqlite3.Connection:
    for suffix in ("", "-wal", "-shm", "-journal"):
        p = Path(str(tmp) + suffix)
        try:
            _remove(p)
        except OSError as exc:
            raise BuildError(f"cannot remove stale build file {p} ({exc}); is another build running?") from exc
    conn = sqlite3.connect(tmp)
    conn.execute("PRAGMA journal_mode=OFF")
    conn.execute("PRAGMA synchronous=OFF")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA cache_size=-262144")  # 256 MB page cache during the bulk load
    conn.execute("PRAGMA foreign_keys=OFF")
    return conn


def _fmt_stats(stats) -> str:
    if not isinstance(stats, dict):
        return repr(stats)
    parts = []
    for k, v in stats.items():
        if isinstance(v, float):
            v = f"{v:,.4g}" if abs(v) < 1e4 else f"{v:,.0f}"
        elif isinstance(v, (dict, list)):
            v = json.dumps(v, ensure_ascii=True)
            v = v if len(v) <= 160 else v[:157] + "..."
        parts.append(f"{k}={v}")
    return ", ".join(parts)


def _load_step(name: str, core: bool):
    """Import ``scripts.etl.<name>``; return the module or None (optional module unavailable)."""
    full = f"scripts.etl.{name}"
    try:
        spec = importlib.util.find_spec(full)
    except ImportError:
        spec = None
    if spec is None:
        if core:
            raise BuildError(f"core step module {full} not found")
        print(f"  ! {name}: module not found - skipped")
        return None
    try:
        module = importlib.import_module(full)
    except ImportError as exc:
        if core:
            raise
        print(f"  ! {name}: import failed ({exc.__class__.__name__}: {exc}) - skipped")
        return None
    if not callable(getattr(module, "run", None)):
        if core:
            raise BuildError(f"{full} has no run(conn)")
        print(f"  ! {name}: no run(conn) function - skipped")
        return None
    return module


def run_steps(conn: sqlite3.Connection, steps: list[tuple[str, bool]], skip: set[str]) -> dict[str, str]:
    """Run ETL steps in order; return ``{step: status}``. Raises on a failing step."""
    status: dict[str, str] = {}
    for i, (name, core) in enumerate(steps, start=2):
        if name in skip:
            print(f"[{i:>2}] {name}: skipped (--skip)")
            status[name] = "skipped"
            continue
        module = _load_step(name, core)
        if module is None:
            status[name] = "unavailable"
            continue
        t0 = time.perf_counter()
        print(f"[{i:>2}] {name} ...", flush=True)
        try:
            stats = module.run(conn)
            conn.commit()
        except Exception:
            traceback.print_exc()
            raise BuildError(f"step '{name}' failed - build aborted (database not replaced)")
        print(f"     done in {time.perf_counter() - t0:.1f}s: {_fmt_stats(stats)}", flush=True)
        status[name] = "ok"
    return status


def write_meta(conn: sqlite3.Connection, status: dict[str, str], mode: str) -> None:
    n_products = conn.execute("SELECT COUNT(*) FROM products").fetchone()[0]
    n_current = conn.execute("SELECT COUNT(*) FROM products WHERE is_current = 1").fetchone()[0]
    meta = {
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "latest_year": str(LATEST_YEAR),
        "n_products": str(n_products),
        "n_current_products": str(n_current),
        "schema_version": SCHEMA_VERSION,
        "build_mode": mode,
        "build_steps": json.dumps(status),
    }
    conn.executemany("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", list(meta.items()))
    conn.commit()


# --------------------------------------------------------------------------- summary

def _scalar(conn, sql: str, params=()):
    try:
        row = conn.execute(sql, params).fetchone()
        return row[0] if row else None
    except sqlite3.Error:
        return None


def _bn(v) -> str:
    return "n/a" if v is None else f"{v / 1e9:,.3f} bn"


def print_summary(conn: sqlite3.Connection) -> None:
    """Row counts, ministry distribution, and trade sanity figures."""
    print("\nRow counts")
    tables = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' "
        "AND name NOT LIKE 'products_fts_%' ORDER BY name")]
    for t in tables:
        n = conn.execute('SELECT COUNT(*) FROM "%s"' % t.replace('"', '""')).fetchone()[0]
        print(f"  {t:<20} {n:>10,}")

    total = _scalar(conn, "SELECT COUNT(*) FROM products WHERE is_current = 1") or 0
    if total:
        print(f"\nMinistry distribution of {total:,} current lines")
        print(f"  {'ministry':<9} {'codes':>6} {'share':>7}")
        rows = conn.execute(
            "SELECT m.id, m.short_name, COUNT(p.hsn8) FROM ministries m LEFT JOIN products p "
            "ON p.ministry_id = m.id AND p.is_current = 1 GROUP BY m.id ORDER BY COUNT(p.hsn8) DESC").fetchall()
        for mid, short, n in rows:
            print(f"  {short[:9]:<9} {n:>6,} {n / total:>7.2%}")
        owners = sum(1 for mid, _s, n in rows if mid != "residual" and n > 0)
        print(f"  ministries owning >= 1 current line: {owners} / {sum(1 for r in rows if r[0] != 'residual')}")

    if _scalar(conn, "SELECT COUNT(*) FROM hs6_metrics"):
        print(f"\nSanity figures ({LATEST_YEAR}; India: DGCIS TRADESTAT FY{LATEST_YEAR}-{str(LATEST_YEAR + 1)[-2:]}, "
              f"world: CEPII BACI via OEC)")
        for label, prefix in (("Tyres (4011)", "4011"), ("Natural rubber (4001)", "4001")):
            w, x, m = conn.execute(
                "SELECT SUM(world_trade), SUM(india_exports), SUM(india_imports) FROM hs6_metrics "
                "WHERE hs6 LIKE ?", (prefix + "%",)).fetchone()
            rank = _scalar(conn,
                           "SELECT r FROM (SELECT country_id, RANK() OVER (ORDER BY SUM(value) DESC) r "
                           "FROM world_suppliers WHERE hs6 LIKE ? GROUP BY country_id) WHERE country_id='asind'",
                           (prefix + "%",))
            share = (x / w) if w and x is not None else None
            print(f"  {label:<22} world {_bn(w)}, India exports {_bn(x)} "
                  f"(share {share:.2%}), imports {_bn(m)}, India supplier rank {rank}")
        x_tot = _scalar(conn, "SELECT SUM(india_exports) FROM hs6_metrics")
        x_ct = _scalar(conn, "SELECT exports FROM country_totals WHERE country_id='asind' AND year=?",
                       (LATEST_YEAR,))
        w_tot = _scalar(conn, "SELECT SUM(world_trade) FROM hs6_metrics")
        print(f"  India total exports    {_bn(x_tot)} (country_totals {_bn(x_ct)}), "
              f"world {_bn(w_tot)}, India share {(x_tot / w_tot if w_tot else 0):.2%}")


# --------------------------------------------------------------------------- finalise

GATE_TABLES = ("hs_nodes", "products", "ministries", "products_fts")


def sanity_gate(conn: sqlite3.Connection) -> list[str]:
    """Problems that make the new database unfit to replace the live one (empty list = OK).

    Guards against e.g. ``--skip nomenclature`` silently replacing a good atlas.db with an empty catalogue.
    """
    problems = []
    for table in GATE_TABLES:
        n = _scalar(conn, f"SELECT COUNT(*) FROM {table}")
        if not n:
            problems.append(f"table '{table}' is empty")
    return problems


def finalise(conn: sqlite3.Connection, tmp: Path, db: Path) -> bool:
    """ANALYZE, switch to WAL, close, then replace the live DB. Returns True when db was replaced."""
    conn.execute("ANALYZE")
    conn.commit()
    mode = conn.execute("PRAGMA journal_mode=WAL").fetchone()[0]
    conn.close()
    if mode.lower() != "wal":
        print(f"  ! journal_mode is {mode!r}, expected 'wal'")
    for suffix in ("-wal", "-shm"):
        stale = Path(str(db) + suffix)
        try:
            _remove(stale)
        except OSError as exc:
            print(f"\n!! {db.name} is in use ({stale.name} is locked: {exc}).\n"
                  f"   Stop the process holding it (e.g. the API server) and move the new database into place:\n"
                  f"   the freshly built database was kept at {tmp}")
            return False
    try:
        os.replace(tmp, db)
    except OSError as exc:
        print(f"\n!! could not replace {db} ({exc}).\n"
              f"   It is probably open in another process (Windows file lock). The new database was kept at\n"
              f"   {tmp} - stop that process and rename it, or rerun the build.")
        return False
    return True


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="python -m scripts.build_db", description=__doc__.splitlines()[0])
    ap.add_argument("--core-only", action="store_true", help="run only the ETL core (steps 1-6) + meta")
    ap.add_argument("--skip", default="", help="comma-separated step names to skip, e.g. load_policy,seed_ops")
    ap.add_argument("--db", default=None, help="target database path (default: $ATLAS_DB or data/atlas.db)")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(errors="replace")  # country names etc. on a cp1252 console
    except (AttributeError, ValueError):
        pass
    args = parse_args(argv)
    db = Path(args.db).resolve() if args.db else default_db_path().resolve()
    db.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(str(db) + ".tmp")
    skip = {s.strip() for s in args.skip.split(",") if s.strip()}
    known = set(CORE_STEPS) | set(OPTIONAL_STEPS)
    unknown = skip - known
    if unknown:
        print(f"unknown step(s) in --skip: {sorted(unknown)}; steps are {list(CORE_STEPS + OPTIONAL_STEPS)}")
        return 2
    steps = [(s, True) for s in CORE_STEPS] + ([] if args.core_only else [(s, False) for s in OPTIONAL_STEPS])
    mode = "core" if args.core_only else "full"

    t_start = time.perf_counter()
    print(f"Building {db} ({mode}) via {tmp.name}")
    conn = None
    try:
        conn = _connect_build(tmp)
        print("[ 1] schema ...", flush=True)
        conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        status = run_steps(conn, steps, skip)
        print(f"[{len(steps) + 2:>2}] meta ...", flush=True)
        write_meta(conn, status, mode)
        print_summary(conn)
        problems = sanity_gate(conn)
        if problems:
            conn.close()
            conn = None
            print(f"\n!! not replacing {db.name}: {'; '.join(problems)}.\n"
                  f"   The incomplete database was kept at {tmp} for inspection.")
            return 4
        replaced = finalise(conn, tmp, db)
        conn = None
    except BuildError as exc:
        print(f"\nBUILD FAILED: {exc}")
        return 1
    finally:
        if conn is not None:
            conn.close()
    elapsed = time.perf_counter() - t_start
    if not replaced:
        print(f"\nBuild finished in {elapsed:.0f}s but {db.name} was NOT replaced (see above).")
        return 3
    print(f"\nBuild finished in {elapsed:.0f}s -> {db}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
