"""Downloadable reports - PDF, XLSX and CSV (docs/SPEC.md section 6.12; "Download Report").

Endpoints
---------
* ``GET /api/reports/{kind}/{id}?format=pdf|xlsx|csv[&table=<key>]`` for ``kind`` in

  ``product``     an 8-digit line (``ProductDetail`` of ``app.routers.hsn.build_product_detail``): hierarchy,
                  ownership + mapping provenance, KPI tiles (trade, RCA, share, rank, tariff, model scores), trade
                  trend, forecast, partner / supplier / market tables, value-chain links, schemes, production,
                  sibling lines, alerts.
  ``ministry``    a ministry dashboard (``app.routers.ministries.build_entity_dashboard``) plus the complete
                  "Ministry wise HS code" table (every line it owns, ``entity_products`` with ``page_size=None``).
  ``sector``      the same for a sector.
  ``valuechain``  the sector deep-dive (``app.routers.valuechains.value_chain``, C2): KPI strip with live and
                  real sourced production figures, the ministry-wise mapping table, supplier / market / partner
                  tables, top export categories, risk flags, manufacturers, clusters, schemes. If that builder is
                  unavailable a reduced report is built from the curated tables directly.

  ``table=<key>`` with ``format=csv`` returns exactly one table as a plain machine-readable CSV (the keys are
  listed on the XLSX ``Summary`` sheet; e.g. ``products``, ``top_exports``, ``series``, ``mapping``; an unknown key
  -> 400 naming the valid ones).
* ``GET /api/reports/search?<the /api/hsn/search filters>&format=csv|xlsx`` - every row of the current search /
  explorer table (``app.common.search_products(..., page_size=None)``); CSV is the plain table. The unfiltered
  export (the whole catalogue, ~13 000 rows) is rendered once per data fingerprint and kept in the analytics
  cache (``app.services.scoring.cached``), and :func:`warm_export_async` pre-renders it at start-up, so the
  download stays inside the 1.5 s budget; filtered exports are rendered on demand.

Rendering lives in :mod:`app.services.reports_pdf` (one format-neutral ``ReportDoc`` -> PDF / XLSX / CSV, so the
three downloads never disagree). Every response is ``Content-Disposition: attachment``; the bytes are rendered
before the response is returned (the request's database connection closes when the request ends).

Access (SPEC section 5): product, ministry and value-chain reports are public; sector reports and the search
export need a signed-in user ("industry: + ... all reports").
"""
from __future__ import annotations

import logging
import sqlite3
import threading
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from app.common import (country_values, hs6_trade_totals, ministry_ref, parse_json, prefix_hs6_list, provenance,
                        search_products)
from app.config import LATEST_YEAR
from app.db import connection, get_db, row, rows
from app.routers.hsn import build_product_detail
from app.routers.ministries import build_entity_dashboard, entity_products
from app.security import require_user
from app.services.reports_pdf import Column, Kpi, ReportDoc, Table, format_value, render
from app.services.scoring import cached

log = logging.getLogger("atlas.reports")

router = APIRouter(prefix="/api/reports", tags=["reports"])

ReportKind = Literal["product", "ministry", "sector", "valuechain"]
ReportFormat = Literal["pdf", "xlsx", "csv"]
TableFormat = Literal["csv", "xlsx"]
SortParam = Literal["relevance", "exports", "imports", "rca", "code", "world_trade"]

MODEL_NOTE = "Model estimate - method at /about#methodology"
MAPPING_NOTE = ("Ministry mapping: the DPIIT Guidebook on HSN Code Mapping (16.12.2025 revision) is applied "
                "directly. Residual or Guidebook-unlisted lines have no accepted owner and are not verified; "
                "'official_upload' / 'manual' mappings are confirmed through the Data Hub or the Residual "
                "Workbench. 2/4/6-digit ownership is derived from accepted 8-digit lines and labelled as such.")

# --------------------------------------------------------------------------- column sets

PRODUCT_COLUMNS = [
    Column("hsn8", "HSN code", "code", 0.85),
    Column("description", "Product", "text", 3.2),
    Column("ministry_short", "Ministry", "text", 0.85),
    Column("ministry_name", "Ministry (full name)", "text", 2.0),
    Column("sector_name", "Sector", "text", 1.3),
    Column("mapping_status", "Mapping status", "text", 0.9),
    Column("mapping_source", "Mapping source", "text", 0.9),
    Column("exports", "India exports", "usd", 0.95),
    Column("imports", "India imports", "usd", 0.95),
    Column("world_trade", "World trade", "usd", 0.95),
    Column("rca", "RCA", "ratio", 0.55),
    Column("mfn_tariff", "MFN tariff %", "pct_value", 0.7),
    Column("bcd_display", "BCD", "text", 0.6),
    Column("hs6", "HS6", "code", 0.7),
    Column("lines_in_hs6", "Lines in HS6", "int", 0.6),
]
PRODUCT_PDF = ["hsn8", "description", "ministry_short", "exports", "imports", "bcd_display", "rca"]

COUNTRY_COLUMNS = [
    Column("rank", "Rank", "int", 0.5),
    Column("country", "Country", "text", 2.2),
    Column("iso3", "ISO3", "code", 0.6),
    Column("value", "Value", "usd", 1.1),
    Column("share", "Share", "pct", 0.8),
]

SERIES_COLUMNS = [
    Column("year", "Year", "year", 0.6),
    Column("exports", "India exports", "usd", 1.0),
    Column("imports", "India imports", "usd", 1.0),
    Column("world_trade", "World trade", "usd", 1.0),
]

SCHEME_COLUMNS = [Column("id", "Scheme id", "code", 1.0), Column("name", "Scheme", "text", 4.0),
                  Column("kind", "Kind", "text", 0.6)]


def _num(value) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def fmt_code(code: str | None) -> str:
    """``40111010 -> 4011.10.10``, ``401110 -> 4011.10``; other codes unchanged."""
    code = code or ""
    if code.isdigit() and len(code) in (6, 8):
        return ".".join([code[:4], *(code[i:i + 2] for i in range(4, len(code), 2))])
    return code


def _country_table(key: str, title: str, items: list[dict], note: str | None = None) -> Table:
    # 11 = top 10 + India appended with its rank (world supplier / market tables), so India's row is never cut
    return Table(key, title, COUNTRY_COLUMNS, items or [], note=note, pdf_limit=11)


def _status_label(prov: dict | None) -> str:
    if not prov:
        return "Not available"
    status = {"verified": "Verified", "not_verified": "Not verified", "not_available": "Not available"}.get(
        prov.get("status"), prov.get("status") or "")
    return f"{prov.get('label') or prov.get('source')} ({status})"


# --------------------------------------------------------------------------- product

def product_report(conn: sqlite3.Connection, hsn8: str) -> ReportDoc | None:
    """Report of one 8-digit line; None when it does not exist."""
    d = build_product_detail(conn, hsn8)
    if d is None:
        return None
    trade = d.get("trade") or {}
    tariff = d.get("tariff") or {}
    scores = d.get("scores") or {}
    mapping = d.get("mapping") or {}
    levels = {0: "Section", 2: "Chapter", 4: "Heading", 6: "Subheading"}
    facts = [(levels.get(h.get("level"), "Level"), f"{fmt_code(h['code'])} - {h['description']}")
             for h in d.get("hierarchy") or []]
    owners = d.get("ministries") or []
    primary = next((m for m in owners if m.get("role") == "primary"), None)
    facts.append(("Owning ministry", f"{d.get('ministry_name') or d.get('ministry_id')} ({d.get('ministry_short')})"
                  if primary or d.get("ministry_name") else "Residual (no owner yet)"))
    others = [f"{m['name']} ({m['short_name']})" for m in owners if m.get("role") != "primary"]
    if others:
        facts.append(("Also involved", "; ".join(others)))
    facts.append(("Sector", d.get("sector_name") or "Not available"))
    confidence = mapping.get("confidence")
    facts.append(("Mapping", f"{mapping.get('status')} / source {mapping.get('source')}"
                  + (f" / confidence {confidence:.0%}" if isinstance(confidence, (int, float)) else "")
                  + f" - {_status_label(mapping.get('provenance'))}"))
    if trade.get("trade_level") == "hs4_aggregate":
        facts.append(("Trade level", f"HS6 {fmt_code(trade.get('metric_hs6') or d['hs4'] + '00')} "
                                     f"(BACI reports heading {fmt_code(d['hs4'])} only as this aggregate; "
                                     f"{trade.get('heading_lines') or d.get('lines_in_hs6')} national line(s) "
                                     "share it)"))
    else:
        facts.append(("Trade level", f"HS6 {fmt_code(d['hs6'])} (trade is reported at HS6; "
                                     f"{d.get('lines_in_hs6')} national line(s) share it)"))
    facts.append(("Data-quality score", f"{d.get('data_quality_score')}/100"))

    trade_code = trade.get("metric_hs6") or d["hs6"]
    trade_note = f"{trade.get('year') or ''} HS6 {fmt_code(trade_code)}".strip()
    if trade.get("trade_level") == "hs4_aggregate":
        trade_note += " (heading aggregate)"
    kpis = [
        Kpi("India exports", trade.get("exports"), "usd", trade_note),
        Kpi("India imports", trade.get("imports"), "usd"),
        Kpi("Trade balance", trade.get("trade_balance"), "usd"),
        Kpi("World trade", trade.get("world_trade"), "usd"),
        Kpi("RCA (Balassa)", trade.get("rca"), "ratio", "> 1 = comparative advantage"),
        Kpi("India's share of world exports", trade.get("india_world_share"), "pct"),
        Kpi("India's supplier rank", trade.get("india_supplier_rank"), "int",
            f"of {trade['n_suppliers']} exporters" if trade.get("n_suppliers") else None),
        Kpi("Tariff (BCD / MFN avg)", d.get("bcd_display"), "text", "WITS MFN simple average"),
    ]
    if scores:
        kpis += [Kpi("Export potential score", scores.get("export_potential_score"), "num", MODEL_NOTE),
                 Kpi("Untapped export potential", scores.get("untapped_potential_usd"), "usd", MODEL_NOTE),
                 Kpi("Vulnerability score", scores.get("vulnerability_score"), "num", MODEL_NOTE),
                 Kpi("Archetype", scores.get("archetype"), "text", MODEL_NOTE)]

    tables = [Table("series", "Trade trend (US$, HS6)", SERIES_COLUMNS, d.get("series") or [], pdf_limit=None)]
    forecast = (scores.get("forecast") or {}) if scores else {}
    fc_rows = [{"flow": flow, **point} for flow in ("exports", "imports") for point in forecast.get(flow) or []]
    if fc_rows:
        tables.append(Table("forecast", "Forecast 2025-2026 (model estimate)", [
            Column("flow", "Flow", "text", 1), Column("year", "Year", "year", 0.6),
            Column("value", "Forecast", "usd", 1), Column("lo", "Lower (95%)", "usd", 1),
            Column("hi", "Upper (95%)", "usd", 1)], fc_rows, note="OLS on log values 2018-2024; " + MODEL_NOTE,
            pdf_limit=None))
    tables += [
        _country_table("top_destinations", "India's top export destinations", d.get("top_destinations")),
        _country_table("top_sources", "India's top import sources", d.get("top_sources")),
        _country_table("world_top_suppliers", "World's top suppliers (India's position marked by rank)",
                       d.get("world_top_suppliers")),
        _country_table("world_top_markets", "World's top import markets", d.get("world_top_markets")),
    ]
    links = ([{"direction": "upstream (input)", **u} for u in d.get("upstream") or []]
             + [{"direction": "downstream (used in)", **u} for u in d.get("downstream") or []])
    tables += [
        Table("value_chains", "Value chains", [Column("chain_id", "Chain id", "code", 1),
                                               Column("name", "Value chain", "text", 2),
                                               Column("stage_name", "Stage", "text", 1.5)],
              d.get("value_chains") or []),
        Table("links", "Value-chain interlinkages", [
            Column("direction", "Direction", "text", 1.2), Column("code", "HS code", "code", 0.8),
            Column("description", "Product", "text", 3), Column("relation", "Relation", "text", 0.9),
            Column("chain_id", "Chain", "code", 0.9)], links, pdf_limit=30),
        Table("schemes", "Schemes covering this line (PLI / QCO)", SCHEME_COLUMNS, d.get("schemes") or []),
        Table("production", "Domestic production", [
            Column("year", "Year", "year", 0.6), Column("value", "Value", "num", 1), Column("unit", "Unit", "text", 0.7),
            Column("label", "Label", "text", 1.5), Column("source", "Source", "text", 2),
            Column("status", "Status", "text", 0.8)], d.get("production") or []),
        Table("siblings", "Other national lines in the same HS6", [
            Column("hsn8", "HSN code", "code", 0.8), Column("description", "Product", "text", 3.5),
            Column("ministry_short", "Ministry", "text", 0.9)], d.get("siblings") or [], pdf_limit=20),
    ]
    if d.get("alerts"):
        tables.append(Table("alerts", "Automated alerts", [
            Column("kind", "Kind", "text", 1), Column("severity", "Severity", "text", 0.6),
            Column("title", "Alert", "text", 2.2), Column("detail", "Detail", "text", 3)], d["alerts"]))

    prov = [f"Trade: {_status_label(trade.get('provenance'))}" if trade else "Trade: Not available",
            f"Tariff: {_status_label(tariff.get('provenance'))}" if tariff else "Tariff: Not available",
            f"Ministry mapping: {_status_label(mapping.get('provenance'))}",
            "Partner, supplier and market tables: CEPII BACI (via OEC), latest year, all reporters.",
            MAPPING_NOTE]
    if scores:
        prov.append("Scores, archetype and forecasts: " + MODEL_NOTE + ".")
    return ReportDoc(kind="product", entity_id=d["hsn8"], title=f"HSN {fmt_code(d['hsn8'])} - {d['description']}",
                     subtitle=d.get("full_description"), facts=facts, kpis=kpis, tables=tables, provenance=prov)


# --------------------------------------------------------------------------- ministry / sector

def _summary_columns(*extra: Column) -> list[Column]:
    base = [c for c in PRODUCT_COLUMNS if c.key in ("hsn8", "description", "ministry_short", "sector_name",
                                                    "exports", "imports", "world_trade", "rca", "bcd_display")]
    return base + list(extra)


def entity_report(conn: sqlite3.Connection, kind: Literal["ministry", "sector"], entity_id: str) -> ReportDoc | None:
    """Ministry or sector report (dashboard + the complete HS code table); None for an unknown id."""
    d = build_entity_dashboard(conn, kind, entity_id)
    if d is None:
        return None
    entity = d[kind]
    k = d["kpis"]
    if kind == "ministry":
        title = f"{entity['name']} ({entity['short_name']})"
        facts = [("Ministry / department", entity["name"]), ("Short name", entity["short_name"]),
                 ("Parent ministry", entity.get("parent_ministry") or "-"), ("Kind", entity.get("kind") or "-"),
                 ("Website", entity.get("website") or "Not available")]
        subtitle = "Ministry dashboard report - HS codes owned, trade, dependencies and opportunities"
    else:
        title = entity["name"]
        facts = [("Sector", entity["name"]), ("Description", entity.get("description") or "-"),
                 ("HS chapters", ", ".join(entity.get("chapters") or []) or "-")]
        subtitle = "Sector report - HS codes, owning ministries, trade, dependencies and opportunities"
    facts.append(("Ranking basis", "Model scores" if d.get("ranking") == "model"
                  else "Transparent fallback ranking (model scores not available)"))

    kpis = [Kpi("HS codes (current lines)", k.get("codes"), "int"),
            Kpi("Accepted mappings", k.get("accepted"), "int")]
    if k.get("verified_codes") is not None:
        kpis.append(Kpi("Verified mappings", k.get("verified_codes"), "int", "official / approved claims"))
    if kind == "ministry":
        kpis.append(Kpi("Secondary-owner codes", k.get("secondary_codes"), "int"))
    kpis += [Kpi("India exports", k.get("exports"), "usd", "DGCIS TRADESTAT, latest FY, summed over 8-digit lines"),
             Kpi("India imports", k.get("imports"), "usd"),
             Kpi("Trade balance", k.get("trade_balance"), "usd"),
             Kpi("World trade", k.get("world_trade"), "usd"),
             Kpi("Sectors covered" if kind == "ministry" else "Ministries involved",
                 k.get("sectors_covered") if kind == "ministry" else k.get("ministries_covered"), "int"),
             Kpi("Value chains involved", k.get("chains_involved"), "int"),
             Kpi("Open helpdesk tickets", k.get("open_tickets"), "int"),
             Kpi("Pending residual claims", k.get("pending_claims"), "int")]

    products = entity_products(conn, kind, entity_id, sort="exports", order="desc", page_size=None)["items"]
    vuln = Column("vulnerability_score", "Vulnerability", "num", 0.8)
    other = "sector_name" if kind == "ministry" else "ministry_short"
    pdf_cols = ["hsn8", "description", other, "exports", "imports", "bcd_display", "rca"]
    tables = [
        Table("top_exports", "Top exports (one line per HS6)", _summary_columns(), d.get("top_exports") or [],
              pdf_columns=pdf_cols),
        Table("top_imports", "Top imports (one line per HS6)", _summary_columns(), d.get("top_imports") or [],
              pdf_columns=pdf_cols),
        Table("dependency_hotspots", "Import-dependency hotspots", _summary_columns(
            vuln, Column("top_import_source_name", "Top source", "text", 1.0),
            Column("top_import_source_share", "Top source share", "pct", 0.8),
            Column("china_import_share", "China share", "pct", 0.7)), d.get("dependency_hotspots") or [],
            pdf_columns=["hsn8", "description", "imports", "vulnerability_score", "top_import_source_name",
                         "china_import_share"], note=MODEL_NOTE if d.get("ranking") == "model" else None),
        Table("opportunities", "Export opportunities", _summary_columns(
            Column("export_potential_score", "Export potential", "num", 0.8),
            Column("untapped_potential_usd", "Untapped potential", "usd", 1.0),
            Column("archetype", "Archetype", "text", 0.9)), d.get("opportunities") or [],
            pdf_columns=["hsn8", "description", "exports", "rca", "export_potential_score",
                         "untapped_potential_usd", "archetype"],
            note=MODEL_NOTE if d.get("ranking") == "model" else None),
    ]
    if kind == "ministry":
        tables.append(Table("sector_mix", "Sector mix", [
            Column("name", "Sector", "text", 2.5), Column("codes", "Codes", "int", 0.6),
            Column("exports", "Exports", "usd", 1), Column("imports", "Imports", "usd", 1)], d.get("sector_mix") or []))
    else:
        tables.append(Table("ministry_mix", "Owning ministries", [
            Column("short_name", "Ministry", "text", 0.9), Column("name", "Ministry (full name)", "text", 2.6),
            Column("codes", "Codes", "int", 0.6), Column("exports", "Exports", "usd", 1),
            Column("imports", "Imports", "usd", 1)], d.get("ministry_mix") or []))
    tables += [
        Table("chapter_mix", "HS chapter mix", [
            Column("hs2", "Chapter", "code", 0.6), Column("description", "Chapter description", "text", 3),
            Column("codes", "Codes", "int", 0.6), Column("exports", "Exports", "usd", 1),
            Column("imports", "Imports", "usd", 1)], d.get("chapter_mix") or [], pdf_limit=30),
        Table("trend", "Trade trend (US$)", SERIES_COLUMNS, d.get("trend") or [], pdf_limit=None),
        Table("value_chains", "Value chains involved", [
            Column("chain_id", "Chain id", "code", 1), Column("name", "Value chain", "text", 2),
            Column("stages", "Stages involved", "text", 2.5)],
            [{**c, "stages": ", ".join(c.get("stages") or [])} for c in d.get("value_chains") or []]),
        Table("schemes", "Schemes (PLI / QCO)", SCHEME_COLUMNS, d.get("schemes") or []),
        Table("products", ("Ministry-wise HS code table" if kind == "ministry" else "Sector HS code table")
              + " (by India exports)", PRODUCT_COLUMNS, products, pdf_limit=40, pdf_columns=pdf_cols,
              note="Every line of the " + kind + ", largest HS6 exports first; trade values are HS6-level figures "
                   "repeated on each national line of the HS6."),
    ]
    trade_prov = (d.get("provenance") or {}).get("trade")
    prov = [f"Trade: {_status_label(trade_prov)}; totals allocate each HS6 value over its national lines "
            "(no double counting).", MAPPING_NOTE]
    if d.get("ranking") == "model":
        prov.append("Hotspots and opportunities: " + MODEL_NOTE + ".")
    return ReportDoc(kind=kind, entity_id=entity["id"], title=title, subtitle=subtitle, facts=facts, kpis=kpis,
                     tables=tables, provenance=prov)


# --------------------------------------------------------------------------- value chain

def _vc_detail(conn: sqlite3.Connection, chain_id: str) -> dict | None:
    """The C2 deep-dive (``GET /api/valuechains/{id}``) or None when the chain is unknown / builder missing."""
    try:
        from app.routers.valuechains import value_chain
    except Exception as exc:  # noqa: BLE001 - the report degrades to the curated tables
        log.warning("value-chain builder unavailable (%s) - using the reduced report", exc)
        return None
    try:
        return value_chain(chain_id, conn)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        log.warning("value-chain builder failed for %s (%s) - using the reduced report", chain_id, exc)
        return None


def _vc_fallback(conn: sqlite3.Connection, chain: dict) -> dict:
    """A reduced deep-dive built from the curated tables and the common helpers."""
    hs6s = prefix_hs6_list(conn, chain["anchor_hs"])
    totals = hs6_trade_totals(conn, hs6s)
    share = (totals["exports"] / totals["world_trade"]) if totals.get("exports") and totals.get("world_trade") else None
    prov = provenance("tradestat", year=2024) if hs6s else provenance(None)
    stages = []
    for s in rows(conn, "SELECT stage_id, name, stage_order, ministry_text FROM vc_stages WHERE chain_id = ? "
                        "ORDER BY stage_order", (chain["id"],)):
        items = rows(conn, "SELECT id, item_name, hs_code, hsn8, description, ministry_text FROM vc_items "
                           "WHERE chain_id = ? AND stage_id = ? ORDER BY item_order, id", (chain["id"], s["stage_id"]))
        stages.append({"stage_id": s["stage_id"], "name": s["name"], "ministry_text": s["ministry_text"],
                       "items": items})
    return {
        "chain": {**chain, "lead_ministry": ministry_ref(conn, chain.get("lead_ministry_id"))},
        "kpis": [{"key": "global_exports", "label": "Global exports", "value": totals.get("world_trade"),
                  "unit": "usd", "provenance": prov},
                 {"key": "india_exports", "label": "India's exports", "value": totals.get("exports"), "unit": "usd",
                  "provenance": prov},
                 {"key": "india_share", "label": "India's share in global exports", "value": share,
                  "unit": "fraction", "provenance": prov},
                 {"key": "india_imports", "label": "India's imports", "value": totals.get("imports"), "unit": "usd",
                  "provenance": prov}],
        "india_rank": None, "stages": stages,
        "world_top_suppliers": country_values(conn, "world_suppliers", hs6s, limit=10, include_india=True),
        "world_top_markets": country_values(conn, "world_markets", hs6s, limit=10),
        "india_top_destinations": country_values(conn, "india_partners", hs6s, flow="X", limit=10),
        "india_top_sources": country_values(conn, "india_partners", hs6s, flow="M", limit=10),
        "top_export_categories": [], "manufacturers": parse_json(chain.get("manufacturers_json"), []) or [],
        "clusters": [], "skill_council": parse_json(chain.get("skill_council_json"), None), "schemes": [],
        "risk_flags": [], "provenance": {"trade": prov},
    }


_UNIT_KIND = {"usd": "usd", "fraction": "pct", "units": "qty", "tonnes": "qty"}


def valuechain_report(conn: sqlite3.Connection, chain_id: str) -> ReportDoc | None:
    """Value-chain (sector deep-dive) report; None for an unknown chain."""
    chain = row(conn, "SELECT * FROM value_chains WHERE id = ?", (chain_id,))
    if not chain:
        return None
    d = _vc_detail(conn, chain_id) or _vc_fallback(conn, chain)
    meta = d.get("chain") or {}
    lead = meta.get("lead_ministry") or {}
    facts = [("Value chain", chain["name"]), ("Anchor HS code", f"{chain['anchor_hs']} (sector KPIs aggregate the "
                                                               "distinct HS6 codes under it)"),
             ("Trade edition", f"India: DGFT/DGCIS TRADESTAT FY{LATEST_YEAR}-{str(LATEST_YEAR + 1)[-2:]}; "
                               f"world: CEPII BACI HS 2022, {LATEST_YEAR} (via OEC)"),
             ("Lead ministry", f"{lead.get('name')} ({lead.get('short_name')})" if lead else "Not available"),
             ("Phase", chain.get("phase") or "-"),
             ("Mapping source", "Curated by the platform team (to be validated with the line ministry)")]
    if d.get("india_rank") and d["india_rank"].get("text"):
        facts.append(("India's position", d["india_rank"]["text"]))
    council = d.get("skill_council")
    if council and council.get("name"):
        facts.append(("Sector skill council", council["name"] + (f" - {council['url']}" if council.get("url") else "")))

    kpis = []
    for kp in d.get("kpis") or []:
        kind = _UNIT_KIND.get(kp.get("unit") or "", "qty")
        note_parts = [_status_label(kp.get("provenance"))]
        if kp.get("unit") and kind == "qty":
            note_parts.insert(0, kp["unit"])
        kpis.append(Kpi(kp.get("label") or kp.get("key"), kp.get("value"), kind, "; ".join(note_parts)))

    mapping_rows = []
    for s in d.get("stages") or []:
        for it in s.get("items") or []:
            mapping_rows.append({"stage": s.get("name"), "item": it.get("item_name"), "hs_code": it.get("hs_code"),
                                 "description": it.get("description"), "ministry_text": it.get("ministry_text"),
                                 "hsn8": it.get("hsn8"), "exports": it.get("exports"), "imports": it.get("imports"),
                                 "rca": it.get("rca"), "mfn_tariff": it.get("mfn_tariff")})
    tables = [
        Table("mapping", "Ministry-wise product mapping (value-chain stages)", [
            Column("stage", "Stage", "text", 1.1), Column("item", "Item", "text", 1.5),
            Column("hs_code", "HS code", "code", 0.8), Column("description", "Description", "text", 2.6),
            Column("ministry_text", "Ministry", "text", 1.6), Column("hsn8", "Linked line", "code", 0.8),
            Column("exports", "India exports", "usd", 0.9), Column("imports", "India imports", "usd", 0.9),
            Column("rca", "RCA", "ratio", 0.5), Column("mfn_tariff", "MFN %", "pct_value", 0.5)], mapping_rows,
            pdf_limit=80, pdf_columns=["stage", "item", "hs_code", "description", "ministry_text", "exports"]),
        _country_table("world_top_suppliers", "Top global suppliers (India appended with its rank)",
                       d.get("world_top_suppliers")),
        _country_table("world_top_markets", "Top global import markets", d.get("world_top_markets")),
        _country_table("india_top_destinations", "India's export destinations", d.get("india_top_destinations")),
        _country_table("india_top_sources", "India's import partners", d.get("india_top_sources")),
        Table("top_export_categories", "India's top export categories under the anchor code", [
            Column("code", "HS6", "code", 0.7), Column("label", "Product", "text", 3.5),
            Column("value", "India exports", "usd", 1), Column("share", "Share", "pct", 0.7)],
            d.get("top_export_categories") or []),
        Table("risk_flags", "Supply-chain risk flags", [
            Column("code", "HS code", "code", 0.8), Column("item_name", "Item", "text", 1.3),
            Column("stage", "Stage", "text", 1), Column("vulnerability_score", "Vulnerability", "num", 0.7),
            Column("imports", "India imports", "usd", 0.9), Column("reason", "Why", "text", 3.5)],
            d.get("risk_flags") or [], note=MODEL_NOTE),
        Table("manufacturers", "Leading manufacturers", [Column("name", "Company", "text", 2),
                                                          Column("url", "Website", "text", 3)],
              d.get("manufacturers") or []),
        Table("clusters", "Manufacturing clusters", [
            Column("name", "Cluster", "text", 2), Column("state", "State", "text", 1),
            Column("district", "District", "text", 1), Column("products", "Products", "text", 2.5)],
            d.get("clusters") or []),
        Table("schemes", "Schemes (PLI / QCO)", SCHEME_COLUMNS,
              [{k: v for k, v in s.items() if k != "codes"} for s in d.get("schemes") or []]),
    ]
    prov = [f"{key.title()}: {_status_label(p)}" for key, p in (d.get("provenance") or {}).items() if p]
    prov.append("Production figures: UNIDO INDSTAT, Rubber Board, ATMA or official uploads; absent figures are "
                "'Not available'.")
    return ReportDoc(kind="valuechain", entity_id=chain_id, title=chain.get("title") or chain["name"],
                     subtitle=chain.get("description"), facts=facts, kpis=kpis, tables=tables, provenance=prov)


# --------------------------------------------------------------------------- search export

def search_report(conn: sqlite3.Connection, filters: dict) -> ReportDoc:
    """Every row of a product search (the explorer's current table). Raises ValueError for bad filters."""
    result = search_products(conn, page_size=None, **filters)
    shown = [(k, str(v)) for k, v in filters.items() if v not in (None, "") and k not in ("sort", "order")]
    facts = [(k.replace("_", " ").capitalize(), v) for k, v in shown] or [("Filters", "none (all lines)")]
    facts += [("Sort", f"{filters.get('sort') or 'relevance'} {filters.get('order') or ''}".strip()),
              ("Rows", f"{result['total']:,}"), ("Match", result.get("match") or "all")]
    return ReportDoc(kind="search", entity_id="hsn", title="HSN search export",
                     subtitle="Rows of the HSN Explorer table for the filters below", facts=facts,
                     tables=[Table("products", "Products", PRODUCT_COLUMNS, result["items"], pdf_limit=50,
                                   pdf_columns=PRODUCT_PDF)],
                     provenance=["Trade: India's exports and imports DGFT/DGCIS TRADESTAT, latest FY, per 8-digit line; world "
                                 "trade and RCA base CEPII BACI HS 2022 via OEC, HS6 level; tariffs: WITS TRAINS MFN "
                                 "simple average applied duty.", MAPPING_NOTE])


_EXPORT_FORMATS = ("csv", "xlsx")
_warming_exports: set[str] = set()
_warm_lock = threading.Lock()


def _unfiltered(filters: dict) -> bool:
    return all(v in (None, "") for k, v in filters.items() if k not in ("sort", "order"))


def _render_unfiltered(conn: sqlite3.Connection, fmt: str, sort: str, order: str | None) -> tuple[bytes, str, str]:
    """``(content, media_type, filename)`` of the whole-catalogue export (cached per data fingerprint)."""
    doc = search_report(conn, {"sort": sort, "order": order})
    return render(doc, fmt, "products")


def search_export_bytes(conn: sqlite3.Connection, filters: dict, fmt: str) -> tuple[bytes, str, str]:
    """Render a search export; the unfiltered one comes from the fingerprint-keyed cache."""
    if _unfiltered(filters):
        return cached(conn, "search_export", _render_unfiltered, fmt, filters.get("sort") or "relevance",
                      filters.get("order"))
    return render(search_report(conn, filters), fmt, "products")


def warm_export_async(db_path: str | Path) -> threading.Thread | None:
    """Pre-render the unfiltered CSV and XLSX exports in a daemon thread (best effort, never raises)."""
    key = str(Path(db_path).resolve())
    with _warm_lock:
        if key in _warming_exports:
            return None
        _warming_exports.add(key)

    def _run() -> None:
        try:
            with connection(db_path) as conn:
                for fmt in _EXPORT_FORMATS:
                    cached(conn, "search_export", _render_unfiltered, fmt, "relevance", None)
        except Exception as exc:  # noqa: BLE001 - warming must never raise
            log.warning("search export warm-up failed: %s", exc)
        finally:
            with _warm_lock:
                _warming_exports.discard(key)

    thread = threading.Thread(target=_run, name="atlas-export-warmup", daemon=True)
    thread.start()
    return thread


# --------------------------------------------------------------------------- endpoints

def _attachment(content: bytes, media_type: str, filename: str) -> Response:
    return Response(content=content, media_type=media_type,
                    headers={"Content-Disposition": f'attachment; filename="{filename}"',
                             "Cache-Control": "no-store"})


def _download(doc: ReportDoc, fmt: str, table: str | None = None) -> Response:
    try:
        content, media_type, filename = render(doc, fmt, table if fmt == "csv" else None)
    except KeyError as exc:
        keys = ", ".join(t.key for t in doc.tables)
        raise HTTPException(status_code=400, detail=f"Unknown table '{table}'; tables: {keys}") from exc
    return _attachment(content, media_type, filename)


@router.get("/search", summary="Export the current search / explorer table (CSV or XLSX)")
def search_export(
    q: str | None = Query(None, max_length=200),
    ministry_id: str | None = None,
    ministry_role: Literal["primary", "secondary", "any"] = "primary",
    sector_id: str | None = None,
    chapter: str | None = None,
    mapping_status: str | None = None,
    mapping_source: str | None = None,
    min_exports: float | None = None,
    min_imports: float | None = None,
    rca_min: float | None = None,
    rca_max: float | None = None,
    prefix: str | None = Query(None, max_length=12),
    sort: SortParam = "relevance",
    order: Literal["asc", "desc"] | None = None,
    format: TableFormat = "csv",  # noqa: A002 - SPEC query parameter name
    conn: sqlite3.Connection = Depends(get_db),
    _user: dict = Depends(require_user),
) -> Response:
    filters = {"q": q, "ministry_id": ministry_id, "ministry_role": ministry_role, "sector_id": sector_id,
               "chapter": chapter, "mapping_status": mapping_status, "mapping_source": mapping_source,
               "min_exports": min_exports, "min_imports": min_imports, "rca_min": rca_min, "rca_max": rca_max,
               "prefix": prefix, "sort": sort, "order": order}
    if ministry_role == "primary":
        filters.pop("ministry_role")
    try:
        content, media_type, filename = search_export_bytes(conn, filters, format)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _attachment(content, media_type, filename)


def _build(conn: sqlite3.Connection, kind: str, entity_id: str) -> ReportDoc | None:
    if kind == "product":
        return product_report(conn, entity_id)
    if kind in ("ministry", "sector"):
        return entity_report(conn, kind, entity_id)  # type: ignore[arg-type]
    return valuechain_report(conn, entity_id)


def build_report(conn: sqlite3.Connection, kind: str, entity_id: str) -> ReportDoc | None:
    """Public builder (also usable by other modules): the ``ReportDoc`` of a product / ministry / sector / chain."""
    if kind not in ("product", "ministry", "sector", "valuechain"):
        raise ValueError(f"unknown report kind '{kind}'")
    return _build(conn, kind, entity_id)


def _report(kind: str, entity_id: str, fmt: str, table: str | None, conn: sqlite3.Connection) -> Response:
    doc = _build(conn, kind, entity_id)
    if doc is None:
        raise HTTPException(status_code=404, detail=f"Unknown {kind} '{entity_id}'")
    return _download(doc, fmt, table)


@router.get("/sector/{entity_id}", summary="Sector report (signed-in users)")
def sector_report(entity_id: str, format: ReportFormat = "pdf",  # noqa: A002 - SPEC query parameter name
                  table: str | None = Query(None, max_length=60, description="CSV only: export one table"),
                  conn: sqlite3.Connection = Depends(get_db), _user: dict = Depends(require_user)) -> Response:
    return _report("sector", entity_id, format, table, conn)


@router.get("/{kind}/{entity_id}", summary="Product / ministry / value-chain report (PDF, XLSX or CSV)")
def entity_download(kind: Literal["product", "ministry", "valuechain"], entity_id: str,
                    format: ReportFormat = "pdf",  # noqa: A002 - SPEC query parameter name
                    table: str | None = Query(None, max_length=60, description="CSV only: export one table"),
                    conn: sqlite3.Connection = Depends(get_db)) -> Response:
    return _report(kind, entity_id, format, table, conn)
