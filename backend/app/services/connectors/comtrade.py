"""``comtrade`` connector - cross-validate CEPII BACI against UN Comtrade (India's own reported trade).

Source: the UN Comtrade **public preview** API (no key, rate-limited, at most 500 records per call)::

    https://comtradeapi.un.org/public/v1/preview/C/A/HS?reporterCode=699&period=2023&partnerCode=0
        &flowCode=X,M&cmdCode=<comma list>&includeDesc=false

``reporterCode=699`` is India in Comtrade, ``partnerCode=0`` the World. Codes are sent in batches of
:data:`BATCH_SIZE` (<= 250, so the X + M rows of a batch stay under the 500-record cap), with a pause between
calls. Only the aggregate rows are used (``partner2Code`` 0, ``customsCode`` C00, ``motCode`` 0);
``primaryValue`` is the US$ value (FOB for exports, CIF for India's imports - so imports are expected to sit a few
per cent above BACI, which reconciles values to FOB).

Scope: the HS6 codes of the curated value chains (``vc_items`` codes and curated ``vc_edges``; 8-digit
codes are cut to their HS6, 4-digit codes expand to the HS6 subheadings with trade data), year ``2023`` by default
(``ATLAS_COMTRADE_YEAR`` overrides). Each matched (hs6, year, flow) becomes a ``comtrade_checks`` row with the
BACI value from ``trade_hs6`` and ``diff_pct = (comtrade - baci) / baci`` (NULL when BACI is 0 / missing); older
rows for the same keys are replaced.
"""
from __future__ import annotations

import os
import sqlite3
import time

from app.services.audit import utc_now
from app.services.connectors import base
from app.services.connectors.base import ConnectorError, ConnectorResult, Progress

COMTRADE_URL = "https://comtradeapi.un.org/public/v1/preview/C/A/HS"
INDIA_REPORTER = "699"
DEFAULT_YEAR = 2023
BATCH_SIZE = 120            # <= 250 (SPEC); 2 flows x 120 codes stays well under the 500-record cap
PAUSE_S = 1.5               # between calls - the public preview endpoint is rate-limited


def chain_hs6_codes(conn: sqlite3.Connection) -> list[str]:
    """Distinct HS6 codes of the curated value chains (see module docstring), sorted."""
    cur = conn.cursor()
    cur.row_factory = None
    raw = {r[0] for r in cur.execute(
        "SELECT hs_code FROM vc_items WHERE hs_code IS NOT NULL "
        "UNION SELECT src FROM vc_edges WHERE source = 'curated' "
        "UNION SELECT dst FROM vc_edges WHERE source = 'curated'")}
    codes: set[str] = set()
    for code in raw:
        code = (code or "").strip()
        if not code.isdigit():
            continue
        if len(code) >= 6:
            codes.add(code[:6])
        elif len(code) == 4:
            codes.update(r[0] for r in cur.execute("SELECT hs6 FROM hs6_metrics WHERE hs6 GLOB ?", (code + "*",)))
    return sorted(codes)


def _is_aggregate(rec: dict) -> bool:
    return (rec.get("partnerCode") in (0, "0", None) and rec.get("partner2Code") in (0, "0", None)
            and rec.get("customsCode") in ("C00", None) and rec.get("motCode") in (0, "0", None))


class ComtradeConnector:
    """Fetch India's reported X/M for the value-chain HS6 codes and compare them with BACI."""

    name = "comtrade"
    source_id = "un_comtrade"
    title = "UN Comtrade public preview - BACI cross-check"

    def is_configured(self) -> tuple[bool, str]:
        return True, "public preview API, no key required"

    @staticmethod
    def year() -> int:
        try:
            return int(os.environ.get("ATLAS_COMTRADE_YEAR") or DEFAULT_YEAR)
        except ValueError:
            return DEFAULT_YEAR

    def fetch(self, codes: list[str], year: int, progress: Progress) -> dict[tuple[str, str], float]:
        """``{(hs6, flow): US$}`` reported by India for ``codes`` (aggregate rows only)."""
        values: dict[tuple[str, str], float] = {}
        batches = [codes[i:i + BATCH_SIZE] for i in range(0, len(codes), BATCH_SIZE)]
        for n, batch in enumerate(batches, start=1):
            if n > 1:
                time.sleep(PAUSE_S)
            params = {"reporterCode": INDIA_REPORTER, "period": str(year), "partnerCode": "0",
                      "flowCode": "X,M", "cmdCode": ",".join(batch), "includeDesc": "false"}
            payload = base.http_get_json(COMTRADE_URL, params, timeout=90)
            if not isinstance(payload, dict):
                raise ConnectorError(f"unexpected Comtrade payload: {str(payload)[:200]}")
            if payload.get("error"):
                raise ConnectorError(f"Comtrade API error: {payload['error']}")
            for rec in payload.get("data") or []:
                if not _is_aggregate(rec):
                    continue
                code, flow, value = str(rec.get("cmdCode") or ""), rec.get("flowCode"), rec.get("primaryValue")
                if flow in ("X", "M") and code in batch and value is not None:
                    values[(code, flow)] = values.get((code, flow), 0.0) + float(value)
            progress(f"Comtrade batch {n}/{len(batches)}: {len(values)} values so far")
        return values

    def run(self, conn: sqlite3.Connection, progress: Progress) -> ConnectorResult:
        year = self.year()
        codes = chain_hs6_codes(conn)
        if not codes:
            raise ConnectorError("no value-chain HS6 codes to check (value chains not loaded?)")
        progress(f"checking {len(codes)} value-chain HS6 codes for {year}")
        reported = self.fetch(codes, year, progress)
        if not reported:
            raise ConnectorError(f"UN Comtrade returned no India {year} values for {len(codes)} codes")
        cur = conn.cursor()
        cur.row_factory = None
        baci = {hs6: (x, m) for hs6, x, m in cur.execute(
            "SELECT hs6, india_exports, india_imports FROM trade_hs6 WHERE year = ?", (year,))}
        checked_at = utc_now()
        out_rows = []
        for (hs6, flow), value in sorted(reported.items()):
            x, m = baci.get(hs6, (None, None))
            baci_value = x if flow == "X" else m
            diff = (value - baci_value) / baci_value if baci_value else None
            out_rows.append((hs6, year, flow, value, baci_value, diff, checked_at))
        try:
            cur.executemany("INSERT OR REPLACE INTO comtrade_checks (hs6, year, flow, comtrade_value, baci_value, "
                            "diff_pct, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)", out_rows)
            total = cur.execute("SELECT COUNT(*) FROM comtrade_checks").fetchone()[0]
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        diffs = sorted(abs(r[5]) for r in out_rows if r[5] is not None)
        median = diffs[len(diffs) // 2] if diffs else None
        within_10 = sum(1 for d in diffs if d <= 0.10)
        missing = len(codes) * 2 - len(out_rows)
        message = (f"Cross-checked {len(out_rows)} India {year} HS6 x flow values against BACI "
                   f"({len(codes)} value-chain codes; {missing} code x flow pairs not reported by Comtrade). "
                   + (f"Median |difference| {median * 100:.1f}%, {within_10} of {len(diffs)} within 10%."
                      if median is not None else ""))
        return ConnectorResult(records=len(out_rows), message=message.strip(), source_records=total,
                               details={"year": year, "codes": len(codes), "rows": len(out_rows),
                                        "median_abs_diff": median, "within_10pct": within_10})


connector = ComtradeConnector()
