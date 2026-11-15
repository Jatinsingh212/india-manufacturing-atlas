"""ETL step 5 — India's applied MFN tariffs from World Bank WITS / UNCTAD TRAINS.

Source: ``raw/wits_india_mfn_2022.csv`` (HS2022 subheadings, reported MFN applied duties, 2022), one row per
HS6 with the simple average of India's national tariff lines (``value``), the min/max line rate, the
number of lines and how many of them are non-ad-valorem (``NBR_NA_LINES``).

Rules
-----
* ``mfn_avg`` = ``value`` (percent, simple average over ad-valorem lines).
* When ``NBR_MFN_LINES`` = 0 and ``NBR_NA_LINES`` > 0 every line is specific / compound (e.g. T-shirts
  6109.10, cashew 0802.11): ``mfn_avg``, ``mfn_min`` and ``mfn_max`` are NULL (= non-ad-valorem, shown as
  "Not available").
* ``n_lines`` = ``TOTALNOOFLINES``, ``n_na_lines`` = ``NBR_NA_LINES``, ``year`` = 2022, ``source`` = 'wits'.

The rates are the MFN basic customs duty as reported to TRAINS; they exclude AIDC, SWS, IGST and
preferential (FTA) rates.
"""
from __future__ import annotations

import csv
import re
import sqlite3

from scripts.etl import RAW_DIR

TARIFF_YEAR = 2022
TARIFF_CSV = RAW_DIR / f"wits_india_mfn_{TARIFF_YEAR}.csv"


def _num(value: str | None) -> float | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _int(value: str | None) -> int:
    v = _num(value)
    return int(v) if v is not None else 0


def parse_row(r: dict) -> tuple | None:
    """Map one WITS row to a ``tariffs`` row, or None when the HS6 code is malformed."""
    hs6 = (r.get("hs6") or "").strip()
    if not re.fullmatch(r"\d{6}", hs6):
        return None
    n_mfn, n_na = _int(r.get("NBR_MFN_LINES")), _int(r.get("NBR_NA_LINES"))
    non_ad_valorem = n_mfn == 0 and n_na > 0
    avg = None if non_ad_valorem else _num(r.get("value"))
    lo = None if non_ad_valorem else _num(r.get("MIN_RATE"))
    hi = None if non_ad_valorem else _num(r.get("MAX_RATE"))
    return (hs6, avg, lo, hi, _int(r.get("TOTALNOOFLINES")), n_na, TARIFF_YEAR, "wits")


def run(conn: sqlite3.Connection) -> dict:
    """Load ``tariffs`` from the WITS CSV."""
    with open(TARIFF_CSV, encoding="utf-8-sig", newline="") as f:
        rows = [t for t in (parse_row(r) for r in csv.DictReader(f)) if t]
    conn.executemany(
        "INSERT OR REPLACE INTO tariffs(hs6, mfn_avg, mfn_min, mfn_max, n_lines, n_na_lines, year, source)"
        " VALUES (?,?,?,?,?,?,?,?)", rows)
    return {
        "tariffs": len(rows),
        "non_ad_valorem": sum(1 for r in rows if r[1] is None),
        "avg_of_averages": round(sum(r[1] for r in rows if r[1] is not None) /
                                 max(1, sum(1 for r in rows if r[1] is not None)), 2),
    }
