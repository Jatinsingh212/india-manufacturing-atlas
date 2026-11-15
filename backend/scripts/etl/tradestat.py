"""ETL step 4b - official DGCIS / TRADESTAT India trade (HS8).

The Atlas uses two trade sources, deliberately:

* **India's flows** come from DGFT / DGCIS **TRADESTAT** (EIDB), the official 8-digit national
  tariff lines. The series is financial-year (FY2018-19 .. FY2024-25), stored in ``trade_hs8``
  and aggregated to ``trade_hs6``. A line absent from a flow's published table stays NULL.
* **World trade** (and the world exporter/importer tables) still comes from CEPII BACI HS 2022,
  because TRADESTAT publishes India's trade only.

Inputs (``data/raw``)
---------------------
* ``tradestat_india_hs8_2018_2024.csv.gz`` - one row per HS8, columns export_2018..export_2024,
  import_2018..import_2024 (US$ million, official DGCIS).
* ``tradestat_india_partners_2024.csv.gz`` - optional; ``hsn8, flow, country_id, value`` for
  FY2024-25, country ids already mapped to the Atlas ``countries`` table.
* ``tradestat_manifest.json`` - official grand totals per year (used to update India's
  ``country_totals`` and to document the FY2023-24 export scaling).
"""
from __future__ import annotations

import csv
import gzip
import json
import sqlite3
from collections import defaultdict

from scripts.etl import INDIA, LATEST_YEAR, RAW_DIR

SERIES_FILE = "tradestat_india_hs8_2018_2024.csv.gz"
PARTNERS_FILE = "tradestat_india_partners_2024.csv.gz"
MANIFEST_FILE = "tradestat_manifest.json"
COUNTRY_MAP_FILE = "tradestat_country_map.csv"


def _num(value: str | None) -> float | None:
    text = (value or "").strip()
    if not text:
        return None
    return float(text)


def _read_series(conn: sqlite3.Connection) -> dict:
    path = RAW_DIR / SERIES_FILE
    if not path.exists():
        raise FileNotFoundError(f"{path} is missing; run the TRADESTAT fetch first")
    rows: list[tuple] = []
    hs6: dict[tuple[str, int], list[float | None]] = {}
    with gzip.open(path, "rt", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for rec in reader:
            code = (rec.get("hs8") or "").strip().zfill(8)
            if len(code) != 8 or not code.isdigit():
                continue
            for year in range(2018, LATEST_YEAR + 1):
                x = _num(rec.get(f"export_{year}"))
                m = _num(rec.get(f"import_{year}"))
                if x is None and m is None:
                    continue
                # Raw TRADESTAT figures are in US$ million; the Atlas stores all money in US$.
                x_usd = round(x * 1e6, 2) if x is not None else None
                m_usd = round(m * 1e6, 2) if m is not None else None
                rows.append((code, year, x_usd, m_usd))
                bucket = hs6.setdefault((code[:6], year), [None, None])
                if x_usd is not None:
                    bucket[0] = (bucket[0] or 0.0) + x_usd
                if m_usd is not None:
                    bucket[1] = (bucket[1] or 0.0) + m_usd
    conn.executemany("INSERT INTO trade_hs8(hsn8, year, india_exports, india_imports) VALUES (?,?,?,?)", rows)
    return {"rows": len(rows), "hs6": hs6}


def _heading_rollup(conn: sqlite3.Connection) -> dict[str, str]:
    """``{hs4: '<hs4>00'}`` for headings that BACI reports only as one aggregate code.

    BACI publishes heading 2710 (petroleum oils) as a single code, 271000, while TRADESTAT reports the
    national subheadings (271012, 271019, ...). Summing those into 271000 keeps India's flow and the world
    total on one row, so RCA, world share and the scores still cover the heading. Call it before the overlay
    adds official-only HS6 rows to ``trade_hs6``.
    """
    codes: dict[str, set[str]] = defaultdict(set)
    for (h,) in conn.execute("SELECT DISTINCT hs6 FROM trade_hs6"):
        codes[h[:4]].add(h)
    return {hs4: hs4 + "00" for hs4, hs in codes.items() if hs == {hs4 + "00"}}


def _metric_hs6(hs6: str, rollup: dict[str, str]) -> str:
    """The HS6 row that carries an official subheading: itself, or BACI's heading aggregate."""
    return rollup.get(hs6[:4], hs6)


def _overlay_hs6(conn: sqlite3.Connection, hs6: dict[tuple[str, int], list[float | None]],
                 rollup: dict[str, str]) -> int:
    """Replace BACI's India columns with the official HS6 sums; add official-only HS6/year rows."""
    merged: dict[tuple[str, int], list[float | None]] = {}
    for (h, y), (x, m) in hs6.items():
        bucket = merged.setdefault((_metric_hs6(h, rollup), y), [None, None])
        if x is not None:
            bucket[0] = (bucket[0] or 0.0) + x
        if m is not None:
            bucket[1] = (bucket[1] or 0.0) + m
    conn.execute("CREATE TEMP TABLE _off_hs6(hs6 TEXT, year INTEGER, x REAL, m REAL, PRIMARY KEY(hs6, year))")
    conn.executemany("INSERT INTO _off_hs6(hs6, year, x, m) VALUES (?,?,?,?)",
                     [(h, y, v[0], v[1]) for (h, y), v in merged.items()])
    conn.execute("""
        UPDATE trade_hs6
        SET india_exports = (SELECT o.x FROM _off_hs6 o WHERE o.hs6 = trade_hs6.hs6 AND o.year = trade_hs6.year),
            india_imports = (SELECT o.m FROM _off_hs6 o WHERE o.hs6 = trade_hs6.hs6 AND o.year = trade_hs6.year)""")
    before = conn.total_changes
    conn.execute("""
        INSERT INTO trade_hs6(hs6, year, india_exports, india_imports, world_trade)
        SELECT o.hs6, o.year, o.x, o.m, NULL FROM _off_hs6 o
        WHERE NOT EXISTS (SELECT 1 FROM trade_hs6 t WHERE t.hs6 = o.hs6 AND t.year = o.year)""")
    inserted = conn.total_changes - before

    # Every official HS6 should have a catalogue row so it can be described and searched.
    from scripts.etl.mapping_rules import load_sector_index, sector_for
    _sectors, by_chapter, by_heading = load_sector_index()
    missing = conn.execute("""
        SELECT DISTINCT o.hs6,
               COALESCE((SELECT description FROM hs_nodes WHERE code = o.hs6 AND level = 6), 'HS ' || o.hs6),
               (SELECT COUNT(*) FROM products p WHERE p.hs6 = o.hs6)
        FROM _off_hs6 o WHERE NOT EXISTS (SELECT 1 FROM hs6_products h WHERE h.hs6 = o.hs6)""").fetchall()
    conn.executemany(
        "INSERT INTO hs6_products(hs6, hs4, hs2, description, sector_id, n_lines) VALUES (?,?,?,?,?,?)",
        [(h, h[:4], h[:2], desc, sector_for(h, by_chapter, by_heading), n) for h, desc, n in missing])
    conn.execute("DROP TABLE _off_hs6")
    return inserted + len(missing)


def _update_country_totals(conn: sqlite3.Connection) -> int:
    path = RAW_DIR / MANIFEST_FILE
    if not path.exists():
        return 0
    manifest = json.load(open(path, encoding="utf-8"))
    rows = []
    for year, flows in manifest.get("years", {}).items():
        y = int(year)
        x = (flows.get("export") or {}).get("official_total_usd_m")
        m = (flows.get("import") or {}).get("official_total_usd_m")
        rows.append((INDIA, y, x * 1e6 if x is not None else None, m * 1e6 if m is not None else None))
    conn.executemany("INSERT OR REPLACE INTO country_totals(country_id, year, exports, imports) VALUES (?,?,?,?)", rows)
    return len(rows)


def _ensure_countries(conn: sqlite3.Connection) -> int:
    """Add TRADESTAT territories that OEC/BACI does not list (Puerto Rico, Reunion, ...)."""
    path = RAW_DIR / COUNTRY_MAP_FILE
    if not path.exists():
        return 0
    existing = {r[0] for r in conn.execute("SELECT id FROM countries")}
    rows = []
    for rec in csv.DictReader(open(path, encoding="utf-8")):
        if rec.get("create") != "1":
            continue
        cid = rec["atlas_id"]
        if cid in existing:
            continue
        existing.add(cid)
        rows.append((cid, rec["iso3"], rec["name"], rec["continent"]))
    conn.executemany("INSERT INTO countries(id, iso3, name, continent) VALUES (?,?,?,?)", rows)
    return len(rows)


def _load_partners(conn: sqlite3.Connection, rollup: dict[str, str]) -> dict:
    path = RAW_DIR / PARTNERS_FILE
    if not path.exists():
        return {"partners_hs8": 0, "partners_hs6": 0, "source": "baci"}
    raw: list[tuple[str, str, str, float]] = []
    with gzip.open(path, "rt", encoding="utf-8", newline="") as f:
        for rec in csv.DictReader(f):
            code = (rec.get("hsn8") or "").strip().zfill(8)
            flow = (rec.get("flow") or "").strip().upper()
            cid = (rec.get("country_id") or "").strip()
            value = _num(rec.get("value"))
            if len(code) == 8 and code.isdigit() and flow in ("X", "M") and cid and value is not None and value > 0:
                raw.append((code, flow, cid, value))
    conn.executemany("INSERT INTO india_partners_hs8(hsn8, flow, country_id, value) VALUES (?,?,?,?)", raw)

    # Aggregate to HS6 (heading aggregates as in the series) and rebuild india_partners with official
    # shares and ranks.
    by_hs6: dict[tuple[str, str], dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for code, flow, cid, value in raw:
        by_hs6[(_metric_hs6(code[:6], rollup), flow)][cid] += value
    conn.execute("DELETE FROM india_partners")
    out = []
    for (hs6, flow), by_country in sorted(by_hs6.items()):
        items = list(by_country.items())
        total = sum(v for _c, v in items)
        items.sort(key=lambda cv: (-cv[1], cv[0]))
        for rank, (cid, value) in enumerate(items, start=1):
            out.append((hs6, flow, cid, value, value / total if total > 0 else None, rank))
    conn.executemany("INSERT INTO india_partners(hs6, flow, country_id, value, share, rank) VALUES (?,?,?,?,?,?)", out)
    return {"partners_hs8": len(raw), "partners_hs6": len(out), "source": "tradestat"}


def _alloc_products(conn: sqlite3.Connection) -> dict:
    """Product-line allocation of the official latest-year India totals (``alloc_products``).

    * A line TRADESTAT publishes keeps its exact 8-digit figure.
    * The remainder of the same reported group (per metric HS6, computed once per group, not per
      line) is shared equally by the national lines DGCIS does not publish separately, so analytics
      that sum ``exports_alloc`` over product lines do not overstate the official total.
    * The remainder is never negative and never invents a value for a line whose group is entirely
      unreported (those lines stay unallocated / "Not available" on the product page). Groups whose
      trade total comes from the BACI HS6 fallback (no official coverage) are allocated the same way
      so ministry-level sums still reconcile with the totals the site has always shown.
    """
    conn.execute("DELETE FROM alloc_products")
    conn.execute("""
        INSERT INTO alloc_products
        WITH lines AS (
            SELECT p.hsn8,
                   CASE WHEN EXISTS (SELECT 1 FROM trade_hs6 t6 WHERE t6.hs6 = p.hs6 AND t6.year = 2024)
                        THEN p.hs6
                        WHEN EXISTS (SELECT 1 FROM trade_hs6 t6 WHERE t6.hs6 = p.hs4 || '00' AND t6.year = 2024)
                        THEN p.hs4 || '00' END AS metric
            FROM products p),
        gov AS (
            SELECT SUM(CASE WHEN t.india_exports IS NULL THEN 1 ELSE 0 END) AS n_missing_x,
                   SUM(CASE WHEN t.india_imports IS NULL THEN 1 ELSE 0 END) AS n_missing_m,
                   COALESCE(SUM(t.india_exports), 0) AS exact_x_sum,
                   COALESCE(SUM(t.india_imports), 0) AS exact_m_sum,
                   MAX(g.tot_x) AS tot_x, MAX(g.tot_m) AS tot_m, l.metric AS metric
            FROM lines l
            LEFT JOIN trade_hs8 t ON t.hsn8 = l.hsn8 AND t.year = 2024
            LEFT JOIN (SELECT hs6, SUM(india_exports) AS tot_x, SUM(india_imports) AS tot_m
                       FROM trade_hs6 WHERE year = 2024 GROUP BY hs6) g ON g.hs6 = l.metric
            WHERE l.metric IS NOT NULL AND g.hs6 IS NOT NULL
            GROUP BY l.metric)
        SELECT l.hsn8,
               CASE WHEN t.india_exports IS NOT NULL THEN t.india_exports
                    WHEN gov.n_missing_x > 0 AND gov.tot_x - gov.exact_x_sum > 0
                    THEN (gov.tot_x - gov.exact_x_sum) / gov.n_missing_x END,
               CASE WHEN t.india_imports IS NOT NULL THEN t.india_imports
                    WHEN gov.n_missing_m > 0 AND gov.tot_m - gov.exact_m_sum > 0
                    THEN (gov.tot_m - gov.exact_m_sum) / gov.n_missing_m END
        FROM lines l
        JOIN gov ON gov.metric = l.metric
        LEFT JOIN trade_hs8 t ON t.hsn8 = l.hsn8 AND t.year = 2024
    """)
    rows = _scalar(conn, "SELECT COUNT(*) FROM alloc_products")
    # Conservation: allocated values may fall short of the group total (DGCIS codes the Atlas has no
    # line for) but must never exceed it.
    overshoot = conn.execute("""
        SELECT ABS(d) FROM (
          SELECT SUM(a.exports_alloc) - MAX(gv.tot_x) AS d FROM alloc_products a
          JOIN (SELECT p.hsn8, CASE WHEN EXISTS (SELECT 1 FROM trade_hs6 t6 WHERE t6.hs6 = p.hs6 AND t6.year = 2024)
                                    THEN p.hs6 ELSE p.hs4 || '00' END AS metric
                FROM products p) l ON l.hsn8 = a.hsn8
          JOIN (SELECT hs6, SUM(india_exports) AS tot_x FROM trade_hs6 WHERE year = 2024 GROUP BY hs6) gv
            ON gv.hs6 = l.metric
          GROUP BY gv.hs6
          UNION ALL
          SELECT SUM(a.imports_alloc) - MAX(gv.tot_m) FROM alloc_products a
          JOIN (SELECT p.hsn8, CASE WHEN EXISTS (SELECT 1 FROM trade_hs6 t6 WHERE t6.hs6 = p.hs6 AND t6.year = 2024)
                                    THEN p.hs6 ELSE p.hs4 || '00' END AS metric
                FROM products p) l ON l.hsn8 = a.hsn8
          JOIN (SELECT hs6, SUM(india_imports) AS tot_m FROM trade_hs6 WHERE year = 2024 GROUP BY hs6) gv
            ON gv.hs6 = l.metric
          GROUP BY gv.hs6
        ) WHERE d > 1 ORDER BY ABS(d) DESC LIMIT 1""").fetchone()
    worst = overshoot[0] if overshoot else 0.0
    return {"rows": rows, "max_group_overshoot": worst}


def _scalar(conn: sqlite3.Connection, sql: str) -> int:
    return conn.execute(sql).fetchone()[0]


def run(conn: sqlite3.Connection) -> dict:
    rollup = _heading_rollup(conn)
    series = _read_series(conn)
    inserted = _overlay_hs6(conn, series["hs6"], rollup)
    alloc = _alloc_products(conn)
    totals = _update_country_totals(conn)
    new_countries = _ensure_countries(conn)
    partners = _load_partners(conn, rollup)
    return {
        "trade_hs8": series["rows"],
        "hs6_overlay_rows": len(series["hs6"]),
        "hs6_rows_added": inserted,
        "alloc_products": alloc,
        "country_totals_updated": totals,
        "new_countries": new_countries,
        **partners,
    }
