"""``wits`` connector - refresh India's MFN applied tariffs from World Bank WITS / UNCTAD TRAINS.

Source: the WITS SDMX REST API (no key)::

    https://wits.worldbank.org/API/V1/SDMX/V21/datasource/TRN/reporter/356/partner/000/product/all/
        year/<year>/datatype/reported?format=JSON

(reporter 356 = India, partner 000 = World/MFN), the same query ``scripts/fetch_sources.py`` uses for
``raw/wits_india_mfn_2022.csv``. The year defaults to 2022 (the HS 2022 vintage the Atlas uses); set
``ATLAS_WITS_YEAR`` to pull another year once TRAINS publishes it.

Parsing follows the fetch script: WITS' series keys do not honour the declared key positions, so the product
dimension is located as the key part that varies; each observation's attributes (``NBR_MFN_LINES``,
``NBR_NA_LINES``, ``MIN_RATE``, ``MAX_RATE``, ``TOTALNOOFLINES`` ...) are decoded through the attribute value
lists. Rows are mapped exactly like ``scripts/etl/tariffs.py``: ``mfn_avg`` = simple average; NULL average / min /
max when every line is non-ad-valorem (``NBR_MFN_LINES`` = 0 and ``NBR_NA_LINES`` > 0).

``tariffs`` rows are upserted (``INSERT OR REPLACE``) in one transaction; HS6 codes missing from the new pull keep
their previous row. A pull with fewer than :data:`MIN_ROWS` products is rejected as truncated.
"""
from __future__ import annotations

import os
import re
import sqlite3

from app.services.connectors import base
from app.services.connectors.base import ConnectorError, ConnectorResult, Progress

WITS_URL = ("https://wits.worldbank.org/API/V1/SDMX/V21/datasource/TRN/reporter/356/partner/000/"
            "product/all/year/{year}/datatype/reported")
DEFAULT_YEAR = 2022
MIN_ROWS = 3_000


def _num(value) -> float | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _int(value) -> int:
    v = _num(value)
    return int(v) if v is not None else 0


def parse_sdmx(payload: dict) -> list[dict]:
    """Flatten a WITS SDMX-JSON payload into ``[{hs6, name, value, <ATTRIBUTE>: ...}]``."""
    try:
        structure = payload["structure"]
        series_dims = structure["dimensions"]["series"]
        products = next(d for d in series_dims if d["id"] == "PRODUCTCODE")["values"]
        obs_attrs = structure.get("attributes", {}).get("observation", [])
        series = payload["dataSets"][0]["series"]
    except (KeyError, IndexError, StopIteration, TypeError) as exc:
        raise ConnectorError(f"unexpected WITS payload structure: {exc}") from exc
    if not series:
        return []
    attr_names = [a["id"] for a in obs_attrs]
    parts = [k.split(":") for k in series]
    prod_pos = max(range(len(parts[0])), key=lambda i: len({p[i] for p in parts}))
    out = []
    for key, s in series.items():
        product = products[int(key.split(":")[prod_pos])]
        for ob in (s.get("observations") or {}).values():
            rec = {"hs6": product["id"], "name": product.get("name"), "value": ob[0] if ob else None}
            for name, aidx in zip(attr_names, ob[1:]):
                values = obs_attrs[attr_names.index(name)].get("values", [])
                rec[name] = values[aidx]["name"] if isinstance(aidx, int) and aidx < len(values) else aidx
            out.append(rec)
    return out


def tariff_row(rec: dict, year: int) -> tuple | None:
    """Map one parsed WITS record to a ``tariffs`` row (``scripts/etl/tariffs.parse_row`` rules)."""
    hs6 = str(rec.get("hs6") or "").strip()
    if not re.fullmatch(r"\d{6}", hs6):
        return None
    n_mfn, n_na = _int(rec.get("NBR_MFN_LINES")), _int(rec.get("NBR_NA_LINES"))
    non_ad_valorem = n_mfn == 0 and n_na > 0
    avg = None if non_ad_valorem else _num(rec.get("value"))
    lo = None if non_ad_valorem else _num(rec.get("MIN_RATE"))
    hi = None if non_ad_valorem else _num(rec.get("MAX_RATE"))
    return (hs6, avg, lo, hi, _int(rec.get("TOTALNOOFLINES")), n_na, year, "wits")


class WitsConnector:
    """Re-fetch the WITS TRAINS India MFN applied tariff averages into ``tariffs``."""

    name = "wits"
    source_id = "wits_trains"
    title = "WITS / UNCTAD TRAINS - India MFN applied tariffs"

    def is_configured(self) -> tuple[bool, str]:
        return True, "public API, no key required"

    @staticmethod
    def year() -> int:
        try:
            return int(os.environ.get("ATLAS_WITS_YEAR") or DEFAULT_YEAR)
        except ValueError:
            return DEFAULT_YEAR

    def run(self, conn: sqlite3.Connection, progress: Progress) -> ConnectorResult:
        year = self.year()
        progress(f"downloading WITS TRAINS India MFN {year}")
        payload = base.http_get_json(WITS_URL.format(year=year), {"format": "JSON"}, timeout=300, tries=3)
        records = parse_sdmx(payload)
        rows = [t for t in (tariff_row(r, year) for r in records) if t]
        if len(rows) < MIN_ROWS:
            raise ConnectorError(f"WITS returned only {len(rows)} HS6 tariff rows for {year} - refusing to apply "
                                 f"a possibly truncated pull (expected > {MIN_ROWS})")
        progress(f"writing {len(rows)} tariff rows")
        cur = conn.cursor()
        cur.row_factory = None
        try:
            n_before = cur.execute("SELECT COUNT(*) FROM tariffs").fetchone()[0]
            cur.executemany(
                "INSERT OR REPLACE INTO tariffs (hs6, mfn_avg, mfn_min, mfn_max, n_lines, n_na_lines, year, source) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)
            n_after = cur.execute("SELECT COUNT(*) FROM tariffs").fetchone()[0]
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        non_adv = sum(1 for r in rows if r[1] is None)
        message = (f"Upserted {len(rows)} HS6 MFN tariff rows for {year} ({non_adv} non-ad-valorem); "
                   f"tariffs table {n_before} -> {n_after} rows.")
        return ConnectorResult(records=len(rows), message=message, source_records=n_after,
                               details={"year": year, "rows": len(rows), "non_ad_valorem": non_adv})


connector = WitsConnector()
