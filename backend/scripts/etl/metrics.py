"""ETL step 6 — ``hs6_metrics``: precomputed latest-year (2024) trade indicators per HS6 (SPEC section 4).

Notation for y = 2024: X_p India's exports of HS6 p, M_p India's imports, W_p world trade (sum of all
exporters), X = sum_p X_p, W = sum_p W_p (over every HS6 with a 2024 row in ``trade_hs6``).

* ``rca``                 (X_p / X) / (W_p / W); NULL when W_p = 0 or missing.
* ``india_world_share``   X_p / W_p.
* ``india_supplier_rank`` India's rank among ``world_suppliers`` of p (1 = largest); NULL if India absent.
* ``n_suppliers``         number of exporting countries; ``world_supplier_hhi`` = sum of their squared shares.
* ``india_import_hhi``    sum of squared shares of India's sources (NULL when India imports nothing);
  ``n_import_sources``, ``top_import_source`` (+ share), ``china_import_share`` (0 when India imports p
  but not from China, NULL when it imports nothing); ``top_destination`` (+ share) from India's exports.
* CAGR = (v_2024 / v_first)^(1/(2024 - first)) - 1 with first = earliest year >= 2018 with v > 0;
  NULL with fewer than two points or when an end value is <= 0. ``first_year`` is the first year of the
  **export** series (the one behind ``export_cagr``).
* YoY = v_2024 / v_2023 - 1 (NULL when v_2023 <= 0 or missing).
* ``trade_balance`` = X_p - M_p.
"""
from __future__ import annotations

import sqlite3
from collections import defaultdict

from scripts.etl import CHINA, FIRST_TREND_YEAR, INDIA, LATEST_YEAR


def cagr(series: dict[int, float | None], last_year: int = LATEST_YEAR,
         first_allowed: int = FIRST_TREND_YEAR) -> tuple[float | None, int | None]:
    """Return ``(cagr, first_year)`` for a ``{year: value}`` series per the SPEC rule."""
    v_last = series.get(last_year)
    if v_last is None or v_last <= 0:
        return None, None
    years = sorted(y for y, v in series.items() if first_allowed <= y < last_year and v is not None and v > 0)
    if not years:
        return None, None
    first = years[0]
    return (v_last / series[first]) ** (1.0 / (last_year - first)) - 1.0, first


def yoy(series: dict[int, float | None], year: int = LATEST_YEAR) -> float | None:
    """Year-on-year growth v_year / v_(year-1) - 1, NULL when the previous value is missing or <= 0."""
    prev, cur = series.get(year - 1), series.get(year)
    if prev is None or prev <= 0 or cur is None:
        return None
    return cur / prev - 1.0


def run(conn: sqlite3.Connection) -> dict:
    """Compute and insert ``hs6_metrics`` for every HS6 with a latest-year row in ``trade_hs6``."""
    ex: dict[str, dict[int, float | None]] = defaultdict(dict)
    im: dict[str, dict[int, float | None]] = defaultdict(dict)
    wd: dict[str, dict[int, float | None]] = defaultdict(dict)
    for hs6, year, x, m, w in conn.execute(
            "SELECT hs6, year, india_exports, india_imports, world_trade FROM trade_hs6"):
        ex[hs6][year], im[hs6][year], wd[hs6][year] = x, m, w
    latest = sorted(h for h in (set(wd) | set(ex) | set(im)) if LATEST_YEAR in ex[h] or LATEST_YEAR in im[h]
                    or LATEST_YEAR in wd[h])
    X = sum(v for h in latest if (v := ex[h].get(LATEST_YEAR)) is not None)
    W = sum(v for h in latest if (v := wd[h].get(LATEST_YEAR)) is not None)

    sup = {h: (n, hhi, rank) for h, n, hhi, rank in conn.execute(
        "SELECT hs6, COUNT(*), SUM(share * share), MAX(CASE WHEN country_id = ? THEN rank END) "
        "FROM world_suppliers GROUP BY hs6", (INDIA,))}
    imp = {h: (n, hhi, cn) for h, n, hhi, cn in conn.execute(
        "SELECT hs6, COUNT(*), SUM(share * share), SUM(CASE WHEN country_id = ? THEN share ELSE 0 END) "
        "FROM india_partners WHERE flow = 'M' GROUP BY hs6", (CHINA,))}
    top_src = {h: (c, s) for h, c, s in conn.execute(
        "SELECT hs6, country_id, share FROM india_partners WHERE flow = 'M' AND rank = 1")}
    top_dst = {h: (c, s) for h, c, s in conn.execute(
        "SELECT hs6, country_id, share FROM india_partners WHERE flow = 'X' AND rank = 1")}

    rows = []
    for h in latest:
        x = ex[h].get(LATEST_YEAR)
        m = im[h].get(LATEST_YEAR)
        w = wd[h].get(LATEST_YEAR)
        has_w = w is not None and w > 0
        has_x = x is not None
        rca = (x / X) / (w / W) if has_x and has_w and X > 0 and W > 0 else None
        n_sup, w_hhi, india_rank = sup.get(h, (0, None, None))
        n_src, m_hhi, china = imp.get(h, (0, None, None))
        src, src_share = top_src.get(h, (None, None))
        dst, dst_share = top_dst.get(h, (None, None))
        e_cagr, first_year = cagr(ex[h])
        rows.append((
            h, LATEST_YEAR, x, m, w, (x - m) if x is not None and m is not None else None, rca,
            (x / w) if has_x and has_w else None, india_rank, n_sup or 0, w_hhi,
            m_hhi if n_src else None, n_src or 0, src, src_share, china if n_src else None, dst, dst_share,
            e_cagr, cagr(im[h])[0], cagr(wd[h])[0], yoy(ex[h]), yoy(im[h]), yoy(wd[h]), first_year))
    conn.executemany(
        "INSERT INTO hs6_metrics(hs6, year, india_exports, india_imports, world_trade, trade_balance, rca,"
        " india_world_share, india_supplier_rank, n_suppliers, world_supplier_hhi, india_import_hhi,"
        " n_import_sources, top_import_source, top_import_source_share, china_import_share, top_destination,"
        " top_destination_share, export_cagr, import_cagr, world_cagr, export_yoy, import_yoy, world_yoy,"
        " first_year) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    return {
        "hs6_metrics": len(rows),
        "india_total_exports": X,
        "world_total": W,
        "india_world_share": X / W if W else None,
        "rca_gt_1": sum(1 for r in rows if r[6] is not None and r[6] >= 1),
    }
