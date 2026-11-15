"""``oec`` connector - refresh India's HS6 exports and imports 2022-2024 (CEPII BACI via the OEC tesseract API).

Source: ``https://api-v2.oec.world/tesseract/data.jsonrecords``, cube ``trade_i_baci_a_22`` (HS 2022 revision,
2022-2024), drilldowns ``HS6,Year``, measure ``Trade Value``, cut ``Exporter Country=asind`` (India's exports)
and ``Importer Country=asind`` (India's imports) - the same queries ``scripts/fetch_sources.py`` runs for
``oec_india_exp_hs6_hs22`` / ``oec_india_imp_hs6_hs22``. OEC HS6 ids carry a section prefix (``7401110``); the
last six digits are the HS6 code.

What is updated (one transaction; nothing is written if a fetch fails or looks truncated)
---------------------------------------------------------------------------------------
* ``trade_hs6`` rows of 2022-2024: ``india_exports`` / ``india_imports`` = the fetched values. As in the ETL, an
  HS6 with world trade but no India flow gets 0 (BACI records every reported flow) and one without world trade
  keeps NULL; (hs6, year) pairs new to the table are inserted with ``world_trade`` NULL.
* ``hs6_metrics`` - the India columns of the latest year (SPEC section 4): ``india_exports``,
  ``india_imports``, ``trade_balance``, ``rca`` (Balassa, with X = sum of India's HS6 exports and W = sum of world
  trade over the latest year), ``india_world_share``, ``export_cagr`` / ``import_cagr`` (earliest year >= 2018
  with v > 0), ``export_yoy`` / ``import_yoy`` and ``first_year`` - the same formulas as
  ``scripts/etl/metrics.py``. World-side columns (world trade, suppliers, HHI, partner shares) are untouched:
  they come from the 2024 partner files, which a full ETL rebuild refreshes.
* ``meta.oec_refreshed_at``.

Guard (DGFT/DGCIS TRADESTAT policy)
-----------------------------------
Once a database carries India's trade from the ministry source (``scripts/etl/tradestat.py``: every non-NULL
India figure is official DGCIS data, everything else stays NULL), a BACI write-back is *not* allowed to touch
it - mixing sources would corrupt the official-or-NULL invariant. The connector then stops after the fetch,
reports how many lines a legacy write would have touched, and changes nothing (no ``meta.oec_refreshed_at``).
The legacy path above only runs on databases that still have no official India data (e.g. ``--core-only``).

Model scores (``hs6_scores``) are not recomputed here - re-run the ETL's ``compute_scores`` step afterwards.
"""
from __future__ import annotations

import sqlite3
from collections import defaultdict

from app.config import LATEST_YEAR
from app.services.audit import utc_now
from app.services.connectors import base
from app.services.connectors.base import ConnectorError, ConnectorResult, Progress

OEC_URL = "https://api-v2.oec.world/tesseract/data.jsonrecords"
CUBE = "trade_i_baci_a_22"
YEARS = (2022, 2023, 2024)
FIRST_TREND_YEAR = 2018
INDIA = "asind"
PAGE = 100_000
#: A refresh returning fewer HS6 x year rows than this is treated as truncated (full pulls have ~16 000).
MIN_ROWS = 5_000


def cagr(series: dict[int, float | None], last_year: int = LATEST_YEAR,
         first_allowed: int = FIRST_TREND_YEAR) -> tuple[float | None, int | None]:
    """``(cagr, first_year)`` per SPEC section 4 (mirrors ``scripts/etl/metrics.cagr``)."""
    v_last = series.get(last_year)
    if v_last is None or v_last <= 0:
        return None, None
    years = sorted(y for y, v in series.items() if first_allowed <= y < last_year and v is not None and v > 0)
    if not years:
        return None, None
    first = years[0]
    return (v_last / series[first]) ** (1.0 / (last_year - first)) - 1.0, first


def yoy(series: dict[int, float | None], year: int = LATEST_YEAR) -> float | None:
    """v_year / v_(year-1) - 1; None when the previous value is missing or <= 0 (mirrors the ETL)."""
    prev, cur = series.get(year - 1), series.get(year)
    if prev is None or prev <= 0 or cur is None:
        return None
    return cur / prev - 1.0


class OecConnector:
    """Re-fetch India's 2022-2024 HS6 trade and recompute the India columns of ``hs6_metrics``."""

    name = "oec"
    source_id = "oec_baci"
    title = "CEPII BACI via OEC - India HS6 exports & imports 2022-2024"

    def is_configured(self) -> tuple[bool, str]:
        return True, "public API, no key required"

    # ------------------------------------------------------------------ fetch
    def fetch_flow(self, side: str, progress: Progress) -> dict[tuple[str, int], float]:
        """``{(hs6, year): US$}`` of India's exports (``side='Exporter'``) or imports (``'Importer'``)."""
        out: dict[tuple[str, int], float] = defaultdict(float)
        offset, seen = 0, 0
        while True:
            params = {"cube": CUBE, "drilldowns": "HS6,Year", "measures": "Trade Value",
                      "limit": f"{PAGE},{offset}", f"{side} Country": INDIA}
            payload = base.http_get_json(OEC_URL, params, timeout=180)
            if not isinstance(payload, dict) or payload.get("error"):
                raise ConnectorError(f"OEC API error: {str(payload)[:300]}")
            batch = payload.get("data") or []
            for rec in batch:
                try:
                    hs6 = str(rec["HS6 ID"])[-6:]
                    year = int(rec["Year"])
                    value = float(rec["Trade Value"] or 0.0)
                except (KeyError, TypeError, ValueError) as exc:
                    raise ConnectorError(f"unexpected OEC record {rec!r}") from exc
                if year in YEARS and hs6.isdigit() and len(hs6) == 6:
                    out[(hs6, year)] += value
            seen += len(batch)
            total = int((payload.get("page") or {}).get("total") or seen)
            progress(f"OEC {side.lower()} rows {seen}/{total}")
            offset += PAGE
            if not batch or seen >= total:
                break
        if len(out) < MIN_ROWS:
            raise ConnectorError(f"OEC returned only {len(out)} India {side.lower()} rows - refusing to apply "
                                 f"a possibly truncated refresh (expected > {MIN_ROWS})")
        return dict(out)

    # ------------------------------------------------------------------ guard
    @staticmethod
    def india_is_official(conn: sqlite3.Connection) -> bool:
        """True when the database carries India's trade from the DGCIS TRADESTAT overlay.

        A full build writes the official fiscal-year series into ``trade_hs8`` and keeps ``trade_hs6``
        India columns official-or-NULL; such a database must never be touched by a BACI write-back.
        Core-only builds and scratch databases without India data (legacy mode) return False.
        """
        try:
            r = conn.execute("SELECT EXISTS (SELECT 1 FROM trade_hs8) AS ex").fetchone()
            if bool(r["ex"] if hasattr(r, "keys") else r[0]):
                return True
            return bool(conn.execute(
                "SELECT EXISTS (SELECT 1 FROM trade_hs6 "
                "WHERE india_exports IS NOT NULL OR india_imports IS NOT NULL)").fetchone()[0])
        except sqlite3.OperationalError:        # scratch DB missing the trade tables
            return False

    # ------------------------------------------------------------------ apply
    @staticmethod
    def apply(conn: sqlite3.Connection, exports: dict[tuple[str, int], float],
              imports: dict[tuple[str, int], float]) -> dict:
        """Write the fetched flows into ``trade_hs6`` and recompute India's ``hs6_metrics`` columns.

        Refuses (raises :class:`ConnectorError`) on a database that carries official DGCIS India data -
        the guard policy in the module docstring. ``OecConnector.run`` turns that state into a clean
        no-op result before calling this, so the raise only guards direct callers.
        """
        if OecConnector.india_is_official(conn):
            raise ConnectorError("refusing BACI write-back: the database carries official "
                                 "DGFT/DGCIS India data (official-or-NULL policy)")
        cur = conn.cursor()
        cur.row_factory = None  # plain tuples for the bulk work, whatever the connection's row factory
        before_x, before_m = cur.execute("SELECT SUM(india_exports), SUM(india_imports) FROM hs6_metrics").fetchone()
        existing = {(h, y): w for h, y, w in cur.execute(
            "SELECT hs6, year, world_trade FROM trade_hs6 WHERE year BETWEEN ? AND ?", (YEARS[0], YEARS[-1]))}
        updates, inserts = [], []
        for key, world in existing.items():
            base_value = 0.0 if world is not None else None
            updates.append((exports.get(key, base_value), imports.get(key, base_value), key[0], key[1]))
        for key in (set(exports) | set(imports)) - set(existing):
            inserts.append((key[0], key[1], exports.get(key, 0.0), imports.get(key, 0.0)))
        cur.executemany("UPDATE trade_hs6 SET india_exports = ?, india_imports = ? WHERE hs6 = ? AND year = ?",
                        updates)
        cur.executemany("INSERT INTO trade_hs6 (hs6, year, india_exports, india_imports, world_trade) "
                        "VALUES (?, ?, ?, ?, NULL)", inserts)

        # ---- recompute the India columns of hs6_metrics (latest year)
        ex: dict[str, dict[int, float | None]] = defaultdict(dict)
        im: dict[str, dict[int, float | None]] = defaultdict(dict)
        wd: dict[str, dict[int, float | None]] = defaultdict(dict)
        for hs6, year, x, m, w in cur.execute(
                "SELECT hs6, year, india_exports, india_imports, world_trade FROM trade_hs6"):
            ex[hs6][year], im[hs6][year], wd[hs6][year] = x, m, w
        latest = [h for h in wd if LATEST_YEAR in wd[h]]
        total_x = sum(ex[h].get(LATEST_YEAR) or 0.0 for h in latest)
        total_w = sum(wd[h].get(LATEST_YEAR) or 0.0 for h in latest)
        have_metrics = {r[0] for r in cur.execute("SELECT hs6 FROM hs6_metrics")}
        metric_updates, metric_inserts = [], []
        for h in latest:
            x = ex[h].get(LATEST_YEAR) or 0.0
            m = im[h].get(LATEST_YEAR) or 0.0
            w = wd[h].get(LATEST_YEAR)
            has_w = w is not None and w > 0
            rca = (x / total_x) / (w / total_w) if has_w and total_x > 0 and total_w > 0 else None
            e_cagr, first_year = cagr(ex[h])
            values = (x, m, x - m, rca, (x / w) if has_w else None, e_cagr, cagr(im[h])[0], yoy(ex[h]), yoy(im[h]),
                      first_year)
            if h in have_metrics:
                metric_updates.append((*values, h))
            else:
                metric_inserts.append((h, LATEST_YEAR, *values, w))
        cur.executemany(
            "UPDATE hs6_metrics SET india_exports = ?, india_imports = ?, trade_balance = ?, rca = ?, "
            "india_world_share = ?, export_cagr = ?, import_cagr = ?, export_yoy = ?, import_yoy = ?, "
            "first_year = ? WHERE hs6 = ?", metric_updates)
        cur.executemany(
            "INSERT INTO hs6_metrics (hs6, year, india_exports, india_imports, trade_balance, rca, "
            "india_world_share, export_cagr, import_cagr, export_yoy, import_yoy, first_year, world_trade) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", metric_inserts)
        cur.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('oec_refreshed_at', ?)", (utc_now(),))
        return {"trade_rows_updated": len(updates), "trade_rows_inserted": len(inserts),
                "metrics_updated": len(metric_updates), "metrics_inserted": len(metric_inserts),
                "india_exports_latest": total_x, "india_imports_latest": sum(im[h].get(LATEST_YEAR) or 0.0
                                                                            for h in latest),
                "india_exports_before": before_x, "india_imports_before": before_m}

    def run(self, conn: sqlite3.Connection, progress: Progress) -> ConnectorResult:
        exports = self.fetch_flow("Exporter", progress)
        imports = self.fetch_flow("Importer", progress)
        res = conn.execute("SELECT COUNT(*) AS n FROM trade_hs6 WHERE year BETWEEN ? AND ?", (YEARS[0], YEARS[-1])).fetchone()
        touched = int(res["n"] if hasattr(res, "keys") else res[0])
        if self.india_is_official(conn):
            # Guard policy: validate connectivity (the fetches above straighten out any API/network
            # problem) but never write BACI over official-or-NULL India figures.
            progress("official DGFT/DGCIS India data present - skipping the BACI write-back")
            return ConnectorResult(
                records=0,
                message=(f"Skipped: the database carries India's trade from DGFT/DGCIS (TRADESTAT); a "
                         f"CEPII BACI write-back must not overwrite official figures ({touched:,} "
                         f"trade_hs6 rows in {YEARS[0]}-{YEARS[-1]} were left untouched). "
                         "Refresh India data through the ETL's TRADESTAT step instead."),
                details={"skipped": True, "trade_hs6_rows_would_touch": touched,
                         "fetched_exporters": len(exports), "fetched_importers": len(imports)})
        progress("applying to trade_hs6 / hs6_metrics")
        try:
            stats = self.apply(conn, exports, imports)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        records = stats["trade_rows_updated"] + stats["trade_rows_inserted"]
        message = (f"Updated {records} India HS6 x year rows ({YEARS[0]}-{YEARS[-1]}) and "
                   f"{stats['metrics_updated'] + stats['metrics_inserted']} hs6_metrics rows. "
                   f"India {LATEST_YEAR}: exports {base.fmt_usd(stats['india_exports_latest'])} "
                   f"(was {base.fmt_usd(stats['india_exports_before'])}), imports "
                   f"{base.fmt_usd(stats['india_imports_latest'])} (was {base.fmt_usd(stats['india_imports_before'])}). "
                   "Re-run compute_scores to refresh model scores.")
        return ConnectorResult(records=records, message=message, details=stats)


connector = OecConnector()
