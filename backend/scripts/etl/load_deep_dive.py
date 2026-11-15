"""Product deep-dive inputs: markets, standards, Cluster Observatory clusters and market MFN tariffs.

* ``markets`` and ``product_standards`` come from ``data/curated/deep_dive.json``.
* ``co_clusters`` comes from ``data/raw/cluster_observatory.json`` and ``market_tariffs`` from
  ``data/raw/market_tariffs.json``: the raw caches the ``cluster_observatory`` and ``market_tariffs`` Data Hub
  connectors write on each refresh (``python -m scripts.refresh_sources`` runs them from the command line).
  A missing cache leaves the table empty and the deep-dive shows "Not available".
* ``iilb_parks`` comes from ``data/raw/iilb_parks.json`` once the IILB connector has run with a token.

Market country ids that are not in ``countries`` are dropped with a warning (they would never match trade rows).
"""
from __future__ import annotations

import json
import sqlite3

from app.services.connectors import deep_dive as dd

STANDARD_STATUSES = ("mandatory", "voluntary", "not_applicable", "none_found")
DUTY_STATUSES = ("none", "verified", "user_input")


def load_markets(conn: sqlite3.Connection, curated: dict) -> int:
    cur = conn.cursor()
    cur.row_factory = None
    known = {r[0] for r in cur.execute("SELECT id FROM countries")}
    conn.execute("DELETE FROM markets")
    for order, m in enumerate(curated.get("markets") or [], start=1):
        if m.get("extra_duty_status", "none") not in DUTY_STATUSES:
            raise ValueError(f"deep_dive.json market {m.get('id')}: bad extra_duty_status")
        ids = [c for c in m["country_ids"] if not known or c in known]
        dropped = sorted(set(m["country_ids"]) - set(ids))
        if dropped:
            print(f"  ! market {m['id']}: unknown country ids {dropped} dropped")
        conn.execute(
            "INSERT INTO markets (id, name, wits_code, country_ids_json, agreement, pref_rate_pct, extra_duty_pct, "
            "extra_duty_basis, extra_duty_status, source, as_of, note, sort_order) VALUES "
            "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (m["id"], m["name"], m["wits_code"], json.dumps(ids), m.get("agreement"), m.get("pref_rate_pct"),
             float(m.get("extra_duty_pct") or 0), m.get("extra_duty_basis"), m.get("extra_duty_status", "none"),
             m.get("source"), m.get("as_of") or curated.get("as_of"), m.get("note"), order))
    return len(curated.get("markets") or [])


def load_standards(conn: sqlite3.Connection, curated: dict) -> int:
    conn.execute("DELETE FROM product_standards")
    rows = []
    for s in curated.get("standards") or []:
        if s["status"] not in STANDARD_STATUSES:
            raise ValueError(f"deep_dive.json standard {s['name']!r}: bad status {s['status']!r}")
        rows.append((s["hs_prefix"], s["market_id"], s["scheme"], s["name"], s["status"], s.get("body"),
                     s.get("url"), s.get("note"), 1 if s.get("verified") else 0, s.get("as_of") or curated.get("as_of")))
    conn.executemany("INSERT INTO product_standards (hs_prefix, market_id, scheme, name, status, body, url, note, "
                     "verified, as_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
    return len(rows)


def load_baskets(conn: sqlite3.Connection, curated: dict) -> int:
    conn.execute("DELETE FROM basket_codes")
    conn.execute("DELETE FROM baskets")
    n = 0
    for order, b in enumerate(curated.get("baskets") or [], start=1):
        conn.execute("INSERT INTO baskets (id, name, description, source, sort_order) VALUES (?, ?, ?, ?, ?)",
                     (b["id"], b["name"], b.get("description"), b.get("source"), order))
        for pos, c in enumerate(b["codes"], start=1):
            if not (len(c["hs6"]) == 6 and c["hs6"].isdigit()):
                raise ValueError(f"deep_dive.json basket {b['id']}: bad hs6 {c['hs6']!r}")
            bn = c.get("study_world_exports_bn")
            conn.execute("INSERT INTO basket_codes (basket_id, hs6, category, study_world_exports, study_year, note, "
                         "sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
                         (b["id"], c["hs6"], c["category"], bn * 1e9 if bn is not None else None,
                          b.get("study_year"), c.get("note"), pos))
            n += 1
    return n


def _read_cache(path, hint: str) -> dict | None:
    if not path.exists():
        if hint:
            print(f"  ! {path.name} not found - {hint}")
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def load_cluster_cache(conn: sqlite3.Connection, curated: dict) -> int:
    snap = _read_cache(dd.CO_CACHE, "co_clusters left empty (refresh the cluster_observatory source)")
    return dd.apply_cluster_snapshot(conn, snap, curated) if snap else 0


def load_tariff_cache(conn: sqlite3.Connection) -> int:
    snap = _read_cache(dd.MT_CACHE, "market_tariffs left empty (refresh the wits_markets source)")
    return dd.apply_tariff_snapshot(conn, snap) if snap else 0


def load_iilb_cache(conn: sqlite3.Connection) -> int:
    snap = _read_cache(dd.IILB_CACHE, "")
    return dd.apply_iilb_snapshot(conn, snap) if snap else 0


def run(conn: sqlite3.Connection) -> dict:
    curated = dd.load_curated()
    return {
        "markets": load_markets(conn, curated),
        "standards": load_standards(conn, curated),
        "basket_codes": load_baskets(conn, curated),
        "co_clusters": load_cluster_cache(conn, curated),
        "market_tariffs": load_tariff_cache(conn),
        "iilb_parks": load_iilb_cache(conn),
    }
