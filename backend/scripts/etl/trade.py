"""ETL step 4 — trade from CEPII BACI (served by the OEC tesseract API, see scripts/fetch_sources.py).

Tables written
--------------
* ``countries``        every OEC country id seen in the trade files. ``iso3`` = last 3 chars upper-cased;
                       continent from the id prefix (af/as/eu/na/sa/oc, else 'Other').
* ``country_totals``   exports 2018-2021 (HS2017 cube) and 2022-2024 (HS2022 cube); imports 2022-2024.
                       BACI has no import-totals file for 2018-2021, so those are NULL — except India's,
                       which are the sum of India's HS6 imports in the HS2017 cube (a derived total).
* ``trade_hs6``        yearly HS6 series: 2018-2021 from the ``*_hs17`` files, 2022-2024 from ``*_hs22``.
                       ``world_trade`` = sum of all exporters (``oec_world_hs6_*``). Where BACI has world
                       trade but no India flow, India's value is 0 (BACI records every reported flow).
* ``hs6_products``     every HS6 with trade or nomenclature: description from ``hs_nodes`` else the OEC name;
                       sector via ``curated/sectors.json`` (heading overrides win); ``n_lines`` = 8-digit lines.
* ``india_partners``   2024, ALL partner countries per HS6 and flow ('X' India's destinations, 'M' India's
                       sources) with share of India's flow and rank (1 = largest).
* ``world_suppliers``  2024, ALL exporters of each HS6 with share of world exports and rank.
* ``world_markets``    2024, ALL importers of each HS6 with share of world imports and rank.

Caveat: an HS6 code that exists in both revisions is joined across 2021/2022 as one series; codes whose
scope changed in HS2022 may show a break. BACI publishes HS 2710 only as the aggregate 271000.
"""
from __future__ import annotations

import csv
import gzip
import sqlite3
from collections import defaultdict
from typing import Iterable, Iterator

from scripts.etl import FIRST_TREND_YEAR, HS22_FIRST_YEAR, INDIA, LATEST_YEAR, RAW_DIR
from scripts.etl.mapping_rules import load_sector_index, sector_for

CONTINENTS = {"af": "Africa", "as": "Asia", "eu": "Europe", "na": "North America", "sa": "South America",
              "oc": "Oceania"}

YEARLY = {  # kind -> (HS2022 file stem used for 2022-2024, HS2017 file stem used for 2018-2021)
    "world": ("oec_world_hs6_hs22", "oec_world_hs6_hs17"),
    "exports": ("oec_india_exp_hs6_hs22", "oec_india_exp_hs6_hs17"),
    "imports": ("oec_india_imp_hs6_hs22", "oec_india_imp_hs6_hs17"),
}


# --------------------------------------------------------------------------- readers

def read_gz(stem: str) -> Iterator[list[str]]:
    """Yield data rows (header skipped) of ``raw/<stem>.csv.gz``."""
    with gzip.open(RAW_DIR / f"{stem}.csv.gz", "rt", encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        next(reader, None)
        yield from reader


def _year_in_window(year: int, hs22: bool) -> bool:
    return (HS22_FIRST_YEAR <= year <= LATEST_YEAR) if hs22 else (FIRST_TREND_YEAR <= year < HS22_FIRST_YEAR)


def load_yearly(kind: str, names: dict[str, str]) -> dict[tuple[str, int], float]:
    """``{(hs6, year): value}`` for 'world' | 'exports' | 'imports', spliced HS2017 (<2022) + HS2022 (>=2022).

    Also fills ``names`` (hs6 -> OEC product name), HS2022 names taking precedence.
    """
    out: dict[tuple[str, int], float] = {}
    for stem, hs22 in zip(YEARLY[kind], (True, False)):
        for hs6, name, year, value in read_gz(stem):
            y = int(year)
            if not _year_in_window(y, hs22):
                continue
            out[(hs6, y)] = out.get((hs6, y), 0.0) + float(value)
            names.setdefault(hs6, name.strip())  # HS2022 file is read first, so its names win
    return out


def continent_of(country_id: str) -> str:
    return CONTINENTS.get(country_id[:2], "Other")


def ranked(rows_by_key: dict, key_cols: int) -> Iterator[tuple]:
    """Turn ``{key: [(country_id, value), ...]}`` into rows ``key + (country_id, value, share, rank)``."""
    for key in sorted(rows_by_key):
        items = rows_by_key[key]
        total = sum(v for _c, v in items)
        items.sort(key=lambda cv: (-cv[1], cv[0]))
        prefix = key if isinstance(key, tuple) else (key,)
        for rank, (cid, value) in enumerate(items, start=1):
            yield (*prefix[:key_cols], cid, value, (value / total) if total > 0 else None, rank)


def load_partners(stem: str, countries: dict[str, str]) -> dict[str, list[tuple[str, float]]]:
    """``{hs6: [(country_id, value)]}`` from a 2024 partner file; also records country names."""
    out: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for hs6, cid, cname, value in read_gz(stem):
        v = float(value)
        countries.setdefault(cid, cname.strip())
        if v > 0:
            out[hs6].append((cid, v))
    return out


# --------------------------------------------------------------------------- step

def run(conn: sqlite3.Connection) -> dict:
    """Load countries, totals, yearly HS6 series, HS6 products and all 2024 partner tables."""
    countries: dict[str, str] = {}
    totals: dict[tuple[str, int], list] = defaultdict(lambda: [None, None])
    for stem, idx, hs22 in (("oec_country_exp_totals_hs22", 0, True), ("oec_country_exp_totals_hs17", 0, False),
                            ("oec_country_imp_totals_hs22", 1, True)):
        for cid, cname, year, value in read_gz(stem):
            countries.setdefault(cid, cname.strip())
            y = int(year)
            if _year_in_window(y, hs22):
                totals[(cid, y)][idx] = float(value)

    names: dict[str, str] = {}
    world = load_yearly("world", names)
    exports = load_yearly("exports", names)
    imports = load_yearly("imports", names)
    for (hs6, y), v in imports.items():  # India's 2018-2021 import totals (derived from HS6 detail)
        if y < HS22_FIRST_YEAR:
            t = totals[(INDIA, y)]
            t[1] = (t[1] or 0.0) + v

    # ---- 2024 partner detail
    exp_partners = load_partners(f"oec_india_exp_partners_{LATEST_YEAR}", countries)
    imp_partners = load_partners(f"oec_india_imp_partners_{LATEST_YEAR}", countries)
    suppliers = load_partners(f"oec_world_exporters_{LATEST_YEAR}", countries)
    markets = load_partners(f"oec_world_importers_{LATEST_YEAR}", countries)

    conn.executemany("INSERT INTO countries(id, iso3, name, continent) VALUES (?,?,?,?)",
                     [(cid, cid[-3:].upper(), name, continent_of(cid)) for cid, name in sorted(countries.items())])
    conn.executemany("INSERT INTO country_totals(country_id, year, exports, imports) VALUES (?,?,?,?)",
                     [(cid, y, ex, im) for (cid, y), (ex, im) in sorted(totals.items())])

    # ---- yearly series
    keys = sorted(set(world) | set(exports) | set(imports))
    series_rows = []
    for key in keys:
        w = world.get(key)
        base = 0.0 if w is not None else None
        series_rows.append((key[0], key[1], exports.get(key, base), imports.get(key, base), w))
    conn.executemany("INSERT INTO trade_hs6(hs6, year, india_exports, india_imports, world_trade) VALUES (?,?,?,?,?)",
                     series_rows)

    # ---- hs6_products
    _sectors, by_chapter, by_heading = load_sector_index()
    node_desc = dict(conn.execute("SELECT code, description FROM hs_nodes WHERE level = 6"))
    n_lines = dict(conn.execute("SELECT hs6, COUNT(*) FROM products GROUP BY hs6"))
    all_hs6 = sorted(set(node_desc) | {k[0] for k in keys})
    conn.executemany(
        "INSERT INTO hs6_products(hs6, hs4, hs2, description, sector_id, n_lines) VALUES (?,?,?,?,?,?)",
        [(h, h[:4], h[:2], node_desc.get(h) or names.get(h) or h, sector_for(h, by_chapter, by_heading),
          n_lines.get(h, 0)) for h in all_hs6])

    # ---- partner tables (all rows, share + rank)
    ip_rows = list(ranked({(h, "X"): v for h, v in exp_partners.items()} |
                          {(h, "M"): v for h, v in imp_partners.items()}, key_cols=2))
    _insert_many(conn, "INSERT INTO india_partners(hs6, flow, country_id, value, share, rank) VALUES (?,?,?,?,?,?)",
                 ip_rows)
    ws_rows = list(ranked(dict(suppliers), key_cols=1))
    _insert_many(conn, "INSERT INTO world_suppliers(hs6, country_id, value, share, rank) VALUES (?,?,?,?,?)", ws_rows)
    wm_rows = list(ranked(dict(markets), key_cols=1))
    _insert_many(conn, "INSERT INTO world_markets(hs6, country_id, value, share, rank) VALUES (?,?,?,?,?)", wm_rows)

    latest = [r for r in series_rows if r[1] == LATEST_YEAR]
    return {
        "countries": len(countries),
        "country_totals": len(totals),
        "trade_hs6": len(series_rows),
        "hs6_products": len(all_hs6),
        "hs6_with_latest_trade": len(latest),
        "india_partners": len(ip_rows),
        "world_suppliers": len(ws_rows),
        "world_markets": len(wm_rows),
        "india_exports_latest": sum(r[2] or 0 for r in latest),
        "india_imports_latest": sum(r[3] or 0 for r in latest),
        "world_trade_latest": sum(r[4] or 0 for r in latest),
    }


def _insert_many(conn: sqlite3.Connection, sql: str, rows: Iterable[tuple], chunk: int = 200_000) -> None:
    """executemany in chunks (keeps memory flat for the ~0.9 M-row partner tables)."""
    buf: list[tuple] = []
    for r in rows:
        buf.append(r)
        if len(buf) >= chunk:
            conn.executemany(sql, buf)
            buf.clear()
    if buf:
        conn.executemany(sql, buf)
