"""Shared response builders (docs/SPEC.md section 6, "Shared shapes"). Every router imports these so the JSON
shapes never drift. The signatures below are a contract: extend only with optional keyword arguments.

Shapes
------
``ProductSummary`` = ``{hsn8, hs6, hs4, hs2, description, full_description, ministry_id, ministry_short,
ministry_name, sector_id, sector_name, mapping_status, mapping_source, mapping_confidence, exports, imports,
world_trade, rca, mfn_tariff, bcd_display, lines_in_hs6, trade_level, metric_hs6}`` - trade values are the
2024 figures of the HS6 subheading that carries the line from ``hs6_metrics`` (null when absent); when BACI
reports only the heading aggregate (``<hs4>00``, e.g. 2710 -> 271000) the figure is that aggregate and
``trade_level`` is ``"hs4_aggregate"``; ``mfn_tariff`` is the WITS MFN simple average in percent;
``bcd_display`` is the WITS MFN applied average (``tariffs.mfn_avg``), formatted as a percentage
(``"12.5%"``), else null.

``MinistryRef`` = ``{id, short_name, name, color}``;
``CountryValue`` = ``{country_id, country, iso3, value, share, rank}``;
``Provenance`` = ``{source, status, label, year}``.

Builders
--------
``product_summaries(conn, where_sql="1=1", params=(), order_sql="p.hsn8", limit=25, offset=0, *,
extra_select="", join_sql="", with_sql="")``
    One SQL statement over ``products p`` joined to ``ministries mi``, ``sectors se``, ``hs6_metrics m``,
    ``tariffs t`` and ``hs6_scores sc`` - all LEFT JOINs, so
    ``where_sql`` / ``order_sql`` / ``extra_select`` may reference any of these aliases, e.g.
    ``where_sql="p.ministry_id = ? AND m.india_imports > ?"``,
    ``extra_select="sc.vulnerability_score, m.china_import_share"``,
    ``order_sql="sc.vulnerability_score DESC NULLS LAST, p.hsn8"``.
    ``join_sql`` adds further joins (after the standard ones); ``with_sql`` is a leading ``WITH ...`` clause.
    ``params`` are the positional parameters of ``with_sql``, ``join_sql``, ``extra_select`` and ``where_sql`` in
    the order those fragments appear in the statement: with -> extra_select -> join -> where. ``limit=None``
    returns every row. Extra selected columns are passed through unchanged.
``count_products(conn, where_sql="1=1", params=(), *, join_sql="", with_sql="") -> int``
    Row count for the same FROM / WHERE (use the same fragments and params, minus ``extra_select``).
``paginate(items, total, page, page_size) -> {items, total, page, page_size}``
``ministry_ref(conn, id) -> MinistryRef | None`` and ``ministry_refs(conn, ids) -> [MinistryRef]``
``country_values(conn, table, hs6_list, flow=None, limit=10, include_india=False) -> [CountryValue]``
    ``table`` is ``india_partners`` (pass ``flow`` 'X' or 'M'), ``world_suppliers`` or ``world_markets``.
    Values of several HS6 codes are summed per country (distinct HS6 - no double counting); ``share`` is the
    country's share of the summed total over *all* countries and ``rank`` its 1-based position.
    ``include_india=True`` appends India (with its true rank) when it is outside the top ``limit``.
``provenance(source, status=None, label=None, year=None) -> Provenance``
    ``status`` defaults from ``source`` (SPEC section 1): baci / wits / gst_master / hs_nomenclature / comtrade /
    unido_indstat / rubber_board / atma / dpiit_guidebook / official_upload / manual -> verified;
    rule / model / unmapped -> not_verified; None -> not_available. ``label`` defaults to a human-readable
    source name (with the year when given).
``prefix_hs6_list(conn, prefix) -> [hs6]``
    Distinct HS6 codes under a 2/4/6-digit prefix (an 8-digit code gives its HS6), from ``hs6_products``,
    ``products`` and ``hs_nodes``. Non-digit or empty input -> ``[]``.
``fmt_pct(value, *, fraction=False, decimals=2) -> str | None``
    ``12.5 -> "12.5%"``, ``20.0 -> "20%"``; with ``fraction=True`` the value is a share (``0.0307 -> "3.07%"``).
``search_products(conn, *, q=None, <facets>, sort="relevance", order=None, page=1, page_size=25) -> dict``
    The product search behind ``/api/hsn/search``, ``/api/ministries/{id}/products`` and
    ``/api/sectors/{id}/products`` (C3's ``/api/reports/search`` should call it too, with ``page_size=None``
    for all rows). Returns the paginated envelope plus ``match`` (which search stage produced the rows).

Other helpers (stable, documented below): ``normalize_code``, ``parse_code_query``, ``fts_query``,
``bcd_display``, ``finish_summary``, ``mapping_provenance``, ``code_descriptions``, ``ministry_refs``,
``country_names``, ``hs6_trade_totals``, ``trade_series``, ``quality_score``, ``meta_values``, ``latest_year``,
``parse_json``, ``page_window``.

Production figures (one chooser for every page, so the chain KPI, the demand-supply table, the network node and
the ministry dashboard always show the same number): ``choose_production(rows)`` picks, among the ``production``
rows of one (scope, key, label), the row with ``status = 'verified'`` first, then the latest ``year`` (unknown
year last), then the newest ``id``; ``production_record(conn, scope, key, label=None)`` returns the chosen row
and ``None`` (the second element is kept for callers that expect the historic two-value return);
``production_provenance(row)`` builds the row's Provenance from its real source.

Counting convention: KPI counts and code distributions use current lines only (``products.is_current = 1``,
the HS2022-valid lines comparable with the Guidebook); product lists include every line.
"""
from __future__ import annotations

import json
import re
import sqlite3
from collections.abc import Iterable, Sequence
from typing import Any

from app.config import LATEST_YEAR
from app.db import in_json, json_param, row, rows, scalar

INDIA_ID = "asind"
CHINA_ID = "aschn"
COUNTRY_TABLES = ("india_partners", "world_suppliers", "world_markets")
MAX_PAGE_SIZE = 200
DEFAULT_PAGE_SIZE = 25

# Mapping sources whose ministry assignment counts as verified (SPEC section 1 and 4, data-quality score).
VERIFIED_MAPPING_SOURCES = ("dpiit_guidebook", "official_upload", "manual")

_VERIFIED_SOURCES = {"baci", "wits", "gst_master", "hs_nomenclature", "comtrade",
                     "unido_indstat", "rubber_board", "atma", "dpiit_guidebook", "official_upload", "manual",
                     "dgft_itc_hs", "tradestat"}
# The Atlas's own curated mappings, the residual/rule mappings and every model output are
# platform-produced, not official sources: they are published as Not verified (SPEC section 1).
_NOT_VERIFIED_SOURCES = {"rule", "unmapped", "curated", "model"}
_SOURCE_LABELS = {
    "baci": "CEPII BACI (via OEC)",
    "tradestat": "DGFT/DGCIS TRADESTAT (official 8-digit trade)",
    "wits": "WITS / UNCTAD TRAINS, India MFN applied tariff",
    "gst_master": "GST HSN master (CBIC)",
    "hs_nomenclature": "WCO HS 2022 nomenclature",
    "rule": "Provisional rule-based mapping (not used for final owners)",
    "dpiit_guidebook": "DPIIT Guidebook on HSN Code Mapping, 16 December 2025 revision",
    "official_upload": "Official mapping uploaded through the Data Hub",
    "manual": "Manual assignment (approved ministry claim)",
    "unmapped": "Not listed in the DPIIT Guidebook (16.12.2025 revision)",
    "dgft_itc_hs": "DGFT ITC-HS import / export policy (public portal)",
    "model": "Model estimate - Atlas analytical model (DGFT/DGCIS & CEPII BACI)",
    "curated": "Curated by Atlas research team (awaiting ministry validation)",
    "comtrade": "UN Comtrade (reported)",
    "unido_indstat": "UNIDO INDSTAT 2026, ISIC Rev.4 output",
    "rubber_board": "Rubber Board, Government of India",
    "atma": "ATMA India, tyre production trend",
}
# Labels that embed the data year (SPEC example: "CEPII BACI 2024 (via OEC)").
_SOURCE_LABELS_WITH_YEAR = {
    "baci": "CEPII BACI {year} (via OEC)",
    # India's flows are the official financial-year series; world totals, RCA denominators and partner tables BACI.
    "tradestat": "DGFT/DGCIS TRADESTAT FY{year}-{fy_end} (India's trade); world trade: CEPII BACI {year}",
    "wits": "WITS / UNCTAD TRAINS {year}, India MFN applied tariff",
    "comtrade": "UN Comtrade {year} (reported)",
    "unido_indstat": "UNIDO INDSTAT 2026, ISIC Rev.4 output {year}",
    "rubber_board": "Rubber Board, Government of India {year}",
    "atma": "ATMA India, tyre production trend {year}",
}

_SUMMARY_SELECT = """
  p.hsn8, p.hs6, p.hs4, p.hs2, p.description, p.full_description,
  p.ministry_id, mi.short_name AS ministry_short, mi.name AS ministry_name,
  p.sector_id, se.name AS sector_name,
  p.mapping_status, p.mapping_source, p.mapping_confidence,
  m.india_exports AS exports, m.india_imports AS imports, m.world_trade AS world_trade, m.rca AS rca,
  t.mfn_avg AS mfn_tariff, p.lines_in_hs6, m.metric_hs6 AS metric_hs6, m.trade_level AS _trade_level"""

_SUMMARY_FROM = """
FROM products p
LEFT JOIN ministries mi ON mi.id = p.ministry_id
LEFT JOIN sectors se ON se.id = p.sector_id
LEFT JOIN v_product_trade m ON m.hsn8 = p.hsn8
LEFT JOIN tariffs t ON t.hs6 = p.hs6
LEFT JOIN hs6_scores sc ON sc.hs6 = m.metric_hs6"""

_NON_CODE_CHARS = re.compile(r"[\s.\-_/']")


# --------------------------------------------------------------------------- small utilities

def normalize_code(code: Any) -> str:
    """Strip spaces, dots, dashes, slashes and quotes from a typed code (``"4011.10.10" -> "40111010"``).

    Section ids (roman numerals) are upper-cased (``"xi" -> "XI"``).
    """
    text = _NON_CODE_CHARS.sub("", str(code or "")).strip()
    return text if text.isdigit() else text.upper()


def parse_json(text: str | None, default: Any = None) -> Any:
    """``json.loads`` that returns ``default`` for NULL / malformed input."""
    if text is None or text == "":
        return default
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return default


def fmt_pct(value: Any, *, fraction: bool = False, decimals: int = 2) -> str | None:
    """Format a percentage for display: ``12.5 -> "12.5%"``, ``20 -> "20%"``; None / non-numeric -> None.

    ``fraction=True`` treats ``value`` as a share (``0.0307 -> "3.07%"``). Trailing zeros are dropped.
    """
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:  # NaN
        return None
    if fraction:
        number *= 100.0
    text = f"{number:.{decimals}f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if text in ("-0", ""):
        text = "0"
    return f"{text}%"


def bcd_display(override: Any, mfn_avg: Any) -> str | None:
    """Format an optional override, else the MFN average, as a percentage; None when neither exists."""
    if override not in (None, ""):
        text = str(override).strip()
        if text.endswith("%"):
            return text
        formatted = fmt_pct(text)
        return formatted if formatted is not None else text
    return fmt_pct(mfn_avg)


def page_window(page: int | None, page_size: int | None) -> tuple[int, int, int]:
    """Clamp pagination input to ``page >= 1`` and ``1 <= page_size <= 200``; returns ``(page, size, offset)``."""
    page = max(1, int(page or 1))
    size = min(MAX_PAGE_SIZE, max(1, int(page_size or DEFAULT_PAGE_SIZE)))
    return page, size, (page - 1) * size


def paginate(items: list, total: int, page: int, page_size: int) -> dict:
    """The SPEC list envelope ``{items, total, page, page_size}``."""
    return {"items": items, "total": int(total or 0), "page": int(page), "page_size": int(page_size)}


def meta_values(conn: sqlite3.Connection) -> dict[str, str]:
    """All ``meta`` key/value pairs."""
    return {r["key"]: r["value"] for r in rows(conn, "SELECT key, value FROM meta")}


def latest_year(conn: sqlite3.Connection) -> int:
    """``meta.latest_year`` (2024 when missing)."""
    value = scalar(conn, "SELECT value FROM meta WHERE key = 'latest_year'")
    try:
        return int(value)
    except (TypeError, ValueError):
        return LATEST_YEAR


# --------------------------------------------------------------------------- provenance

def provenance(source: str | None, status: str | None = None, label: str | None = None,
               year: int | None = None) -> dict:
    """``{source, status, label, year}``; ``status`` and ``label`` default from ``source`` (see module doc)."""
    if status is None:
        if source is None:
            status = "not_available"
        elif source in _VERIFIED_SOURCES:
            status = "verified"
        elif source in _NOT_VERIFIED_SOURCES:
            status = "not_verified"
        else:
            status = "not_verified"
    if label is None:
        if source is None:
            label = "Not available"
        elif year and source in _SOURCE_LABELS_WITH_YEAR:
            label = _SOURCE_LABELS_WITH_YEAR[source].format(year=year, fy_end=str(year + 1)[-2:])
        else:
            label = _SOURCE_LABELS.get(source, source)
    return {"source": source, "status": status, "label": label, "year": year}


def mapping_provenance(mapping_source: str | None, mapping_rule: str | None = None,
                       mapping_status: str | None = None) -> dict:
    """Provenance of a product's ministry assignment (Guidebook / uploads / approved claims = verified).

    A residual status wins over the source: the Guidebook lists residual codes, but no ministry
    accepted them, so ownership is still unverified.
    """
    if mapping_status == "residual":
        if mapping_source == "dpiit_guidebook":
            return provenance(mapping_source, "not_verified",
                              "DPIIT Guidebook: residual code, no ministry accepted it; ownership to be claimed")
        if mapping_source == "unmapped":
            return provenance(mapping_source, "not_verified",
                              "Not listed in the DPIIT Guidebook (16.12.2025 revision); no owner assigned")
        return provenance(mapping_source or "rule", "not_verified",
                          "Residual: no ministry identified - ownership to be claimed")
    if mapping_source in VERIFIED_MAPPING_SOURCES:
        return provenance(mapping_source, "verified")
    return provenance(mapping_source or "rule", "not_verified")


# --------------------------------------------------------------------------- production figures

PRODUCTION_CODE_SCOPES = ("hsn8", "hs6", "hs4")


def _production_rank(r: dict) -> tuple:
    year = r.get("year")
    return (1 if r.get("status") == "verified" else 0, int(year) if year is not None else -1, int(r.get("id") or 0))


def choose_production(records: Iterable[dict]) -> dict | None:
    """The production row to display among rows of one (scope, key, label): verified first, then the latest
    year (unknown year last), then the newest id. None for no rows."""
    best: dict | None = None
    for r in records:
        if r is None or r.get("value") is None:
            continue
        if best is None or _production_rank(r) > _production_rank(best):
            best = r
    return best


def production_record(conn: sqlite3.Connection, scope: str | Sequence[str] | None, key: str,
                      label: str | None = None) -> tuple[dict | None, None]:
    """The chosen production row for ``key`` (see :func:`choose_production`).

    ``scope`` is one scope, a sequence of scopes, or None for the three code scopes (hsn8 / hs6 / hs4).
    The second tuple element is always ``None``; it keeps the old ``(chosen, comparator)`` signature for
    callers that only need the chosen figure.
    """
    scopes = PRODUCTION_CODE_SCOPES if scope is None else ([scope] if isinstance(scope, str) else list(scope))
    where = f"{in_json('scope')} AND key = ?"
    params: list = [json_param(scopes), key]
    if label is not None:
        where += " AND label = ?"
        params.append(label)
    data = rows(conn, f"SELECT id, scope, key, label, year, value, unit, source, status FROM production "
                      f"WHERE {where} ORDER BY id", params)
    return choose_production(data), None


def production_provenance(record: dict | None) -> dict:
    """Provenance of a production row; uploads keep their own status and real source label."""
    if not record or record.get("value") is None:
        return provenance(None)
    source = record.get("source") or "manual"
    label = None if source in _SOURCE_LABELS else source
    return provenance(source, record.get("status"), label, record.get("year"))


# --------------------------------------------------------------------------- products

def finish_summary(r: dict) -> dict:
    """Turn a raw ``product_summaries`` row into the ``ProductSummary`` shape (in place; returns it)."""
    r["bcd_display"] = bcd_display(None, r.get("mfn_tariff"))
    r["trade_level"] = r.pop("_trade_level", None) or "hs6"
    return r


def _fragment(text: str) -> str:
    text = (text or "").strip()
    return f",\n  {text.lstrip(',').strip()}" if text else ""


def product_summaries(conn: sqlite3.Connection, where_sql: str = "1=1", params: Sequence = (),
                      order_sql: str = "p.hsn8", limit: int | None = 25, offset: int = 0, *,
                      extra_select: str = "", join_sql: str = "", with_sql: str = "") -> list[dict]:
    """``ProductSummary`` rows for ``products p`` matching ``where_sql`` (see module docstring for aliases)."""
    sql = (f"{with_sql}\nSELECT{_SUMMARY_SELECT}{_fragment(extra_select)}{_SUMMARY_FROM}\n{join_sql}\n"
           f"WHERE {where_sql or '1=1'}\nORDER BY {order_sql or 'p.hsn8'}")
    args = list(params)
    if limit is not None:
        sql += "\nLIMIT ? OFFSET ?"
        args += [int(limit), int(offset or 0)]
    return [finish_summary(r) for r in rows(conn, sql, args)]


_SUMMARY_JOINS = (  # (alias, LEFT JOIN clause) of _SUMMARY_FROM; each matches at most one row per product
    ("mi", "LEFT JOIN ministries mi ON mi.id = p.ministry_id"),
    ("se", "LEFT JOIN sectors se ON se.id = p.sector_id"),
    ("m", "LEFT JOIN v_product_trade m ON m.hsn8 = p.hsn8"),
    ("t", "LEFT JOIN tariffs t ON t.hs6 = p.hs6"),
    ("sc", "LEFT JOIN hs6_scores sc ON sc.hs6 = m.metric_hs6"),
)


def count_products(conn: sqlite3.Connection, where_sql: str = "1=1", params: Sequence = (), *,
                   join_sql: str = "", with_sql: str = "") -> int:
    """Number of products matching ``where_sql`` with the same joins as :func:`product_summaries`.

    The standard LEFT JOINs match at most one row each, so only those whose alias appears in ``where_sql`` /
    ``join_sql`` are added (same count, much faster on the full catalogue).
    """
    referenced = f"{join_sql} {where_sql}"
    joins = "\n".join(clause for alias, clause in _SUMMARY_JOINS if re.search(rf"\b{alias}\.", referenced))
    sql = f"{with_sql}\nSELECT COUNT(*) AS n\nFROM products p\n{joins}\n{join_sql}\nWHERE {where_sql or '1=1'}"
    return int(scalar(conn, sql, list(params), 0))


def code_descriptions(conn: sqlite3.Connection, codes: Iterable[str]) -> dict[str, str]:
    """Description of each code: 8-digit -> ``products.description``, 2/4/6-digit -> ``hs_nodes.description``."""
    codes = {str(c) for c in codes if c}
    out: dict[str, str] = {}
    lines = [c for c in codes if len(c) == 8]
    nodes = [c for c in codes if len(c) != 8]
    if lines:
        for r in rows(conn, f"SELECT hsn8 AS code, description FROM products WHERE {in_json('hsn8')}",
                      (json_param(lines),)):
            out[r["code"]] = r["description"]
    if nodes:
        for r in rows(conn, f"SELECT code, description FROM hs_nodes WHERE {in_json('code')}",
                      (json_param(nodes),)):
            out[r["code"]] = r["description"]
    return out


def quality_score(mapping_status: str | None, mapping_source: str | None, has_trade: bool, has_tariff: bool,
                  has_production: bool) -> int:
    """Data-quality score of a product (SPEC section 4), capped at 100.

    30 when the ministry mapping is verified (dpiit_guidebook / official_upload / manual), 15 when it
    is rule-based (an unmapped *residual* line earns no mapping points), + 30 trade present + 20 tariff
    present (WITS MFN average) + 20 production present.
    """
    score = 0
    if mapping_status != "residual":
        if mapping_source in VERIFIED_MAPPING_SOURCES:
            score += 30
        elif mapping_source == "rule":
            score += 15
    score += 30 if has_trade else 0
    score += 20 if has_tariff else 0
    score += 20 if has_production else 0
    return min(100, score)


# --------------------------------------------------------------------------- ministries / countries

def ministry_ref(conn: sqlite3.Connection, id: str | None) -> dict | None:  # noqa: A002 - SPEC name
    """``{id, short_name, name, color}`` or None for an unknown / empty id."""
    if not id:
        return None
    return row(conn, "SELECT id, short_name, name, color FROM ministries WHERE id = ?", (id,))


def ministry_refs(conn: sqlite3.Connection, ids: Iterable[str]) -> list[dict]:
    """MinistryRefs in the order given (unknown ids and duplicates skipped)."""
    wanted = [i for i in dict.fromkeys(ids) if i]
    if not wanted:
        return []
    found = {r["id"]: r for r in rows(conn, "SELECT id, short_name, name, color FROM ministries "
                                           f"WHERE {in_json('id')}", (json_param(wanted),))}
    return [found[i] for i in wanted if i in found]


def country_names(conn: sqlite3.Connection, ids: Iterable[str]) -> dict[str, str]:
    """``{country_id: name}`` for the given OEC ids."""
    ids = [i for i in set(ids) if i]
    if not ids:
        return {}
    return {r["id"]: r["name"] for r in rows(conn, f"SELECT id, name FROM countries WHERE {in_json('id')}",
                                             (json_param(ids),))}


def _as_list(hs6_list: str | Iterable[str] | None) -> list[str]:
    if hs6_list is None:
        return []
    if isinstance(hs6_list, str):
        return [hs6_list] if hs6_list else []
    return [c for c in dict.fromkeys(str(x) for x in hs6_list) if c]


def country_values(conn: sqlite3.Connection, table: str, hs6_list: str | Iterable[str], flow: str | None = None,
                   limit: int = 10, include_india: bool = False) -> list[dict]:
    """Top countries (``CountryValue``) of a partner / supplier / market table for one or many HS6 codes."""
    if table not in COUNTRY_TABLES:
        raise ValueError(f"table must be one of {COUNTRY_TABLES}, got {table!r}")
    codes = _as_list(hs6_list)
    if not codes:
        return []
    where = in_json("x.hs6")
    args: list = [json_param(codes)]
    if table == "india_partners":
        if flow not in ("X", "M"):
            raise ValueError("india_partners needs flow 'X' (India's exports) or 'M' (India's imports)")
        where += " AND x.flow = ?"
        args.append(flow)
    if len(codes) == 1:
        where = "x.hs6 = ?" + where[len(in_json("x.hs6")):]
        args[0] = codes[0]
    data = rows(conn, f"""
        SELECT x.country_id, c.name AS country, c.iso3, SUM(x.value) AS value
        FROM {table} x LEFT JOIN countries c ON c.id = x.country_id
        WHERE {where}
        GROUP BY x.country_id
        ORDER BY value DESC, x.country_id""", args)
    total = sum(r["value"] or 0 for r in data)
    out: list[dict] = []
    india: dict | None = None
    for rank, r in enumerate(data, start=1):
        item = {"country_id": r["country_id"], "country": r["country"] or r["country_id"], "iso3": r["iso3"],
                "value": r["value"], "share": (r["value"] / total) if total else None, "rank": rank}
        if rank <= limit:
            out.append(item)
        elif include_india and r["country_id"] == INDIA_ID:
            india = item
            break
        elif not include_india:
            break
    if india is not None:
        out.append(india)
    return out


def country_values_hs8(conn: sqlite3.Connection, hsn8: str, flow: str, limit: int = 10) -> list[dict]:
    """Partner countries for an 8-digit line from india_partners_hs8, or empty list if none."""
    data = rows(conn, """
        SELECT x.country_id, c.name AS country, c.iso3, x.value
        FROM india_partners_hs8 x LEFT JOIN countries c ON c.id = x.country_id
        WHERE x.hsn8 = ? AND x.flow = ?
        ORDER BY x.value DESC, x.country_id LIMIT ?""", (hsn8, flow, limit))
    if not data:
        return []
    total = sum(r["value"] or 0 for r in data)
    return [{"country_id": r["country_id"], "country": r["country"] or r["country_id"], "iso3": r["iso3"],
             "value": r["value"], "share": (r["value"] / total) if total else None, "rank": i}
            for i, r in enumerate(data, start=1)]


# --------------------------------------------------------------------------- HS6 aggregation

def prefix_hs6_list(conn: sqlite3.Connection, prefix: str | None) -> list[str]:
    """Distinct HS6 codes under ``prefix`` (2/4/6 digits; 8 digits -> its HS6). Sorted; [] for bad input."""
    code = normalize_code(prefix)
    if not code or not code.isdigit():
        return []
    if len(code) >= 6:
        code = code[:6]
        found = scalar(conn, """
            SELECT COUNT(*) FROM (SELECT hs6 FROM hs6_products WHERE hs6 = ?
                                  UNION SELECT hs6 FROM products WHERE hs6 = ?
                                  UNION SELECT code FROM hs_nodes WHERE code = ? AND level = 6)""",
                       (code, code, code), 0)
        return [code] if found else []
    pattern = code + "*"
    return [r["hs6"] for r in rows(conn, """
        SELECT hs6 FROM hs6_products WHERE hs6 GLOB ?
        UNION SELECT hs6 FROM products WHERE hs6 GLOB ?
        UNION SELECT code AS hs6 FROM hs_nodes WHERE level = 6 AND code GLOB ?
        ORDER BY hs6""", (pattern, pattern, pattern))]


def hs6_trade_totals(conn: sqlite3.Connection, hs6_list: Iterable[str]) -> dict:
    """Latest-year sums over distinct HS6 codes: ``{exports, imports, world_trade, n_hs6}`` (null when no data)."""
    codes = _as_list(hs6_list)
    if not codes:
        return {"exports": None, "imports": None, "world_trade": None, "n_hs6": 0}
    r = row(conn, f"""SELECT SUM(india_exports) AS exports, SUM(india_imports) AS imports,
                             SUM(world_trade) AS world_trade, COUNT(*) AS n_hs6
                      FROM hs6_metrics WHERE {in_json('hs6')}""", (json_param(codes),))
    return r


def country_values_hs8(conn: sqlite3.Connection, hsn8: str, flow: str, limit: int = 10) -> list[dict]:
    """Top countries of one official 8-digit line (DGCIS bilateral, FY2024-25)."""
    if flow not in ("X", "M"):
        raise ValueError("flow must be 'X' (India's exports) or 'M' (India's imports)")
    data = rows(conn, """
        SELECT x.country_id, c.name AS country, c.iso3, SUM(x.value) AS value
        FROM india_partners_hs8 x LEFT JOIN countries c ON c.id = x.country_id
        WHERE x.hsn8 = ? AND x.flow = ?
        GROUP BY x.country_id
        ORDER BY value DESC, x.country_id""", (hsn8, flow))
    total = sum(r["value"] or 0 for r in data)
    out: list[dict] = []
    for rank, r in enumerate(data, start=1):
        if rank > limit:
            break
        out.append({"country_id": r["country_id"], "country": r["country"] or r["country_id"],
                    "iso3": r["iso3"], "value": r["value"],
                    "share": (r["value"] / total) if total else None, "rank": rank})
    return out


def trade_series(conn: sqlite3.Connection, hs6_list: Iterable[str], *,
                 hsn8: str | None = None) -> list[dict]:
    """Yearly ``[{year, exports, imports, world_trade}]`` summed over distinct HS6 codes.

    With ``hsn8``, India's exports/imports are replaced by that official 8-digit line's DGCIS
    values (NULL when the line is not published for a year); world trade stays the BACI HS6 total.
    """
    codes = _as_list(hs6_list)
    if not codes:
        return []
    where = "hs6 = ?" if len(codes) == 1 else in_json("hs6")
    arg = codes[0] if len(codes) == 1 else json_param(codes)
    data = rows(conn, f"""SELECT year, SUM(india_exports) AS exports, SUM(india_imports) AS imports,
                                 SUM(world_trade) AS world_trade
                          FROM trade_hs6 WHERE {where} GROUP BY year ORDER BY year""", (arg,))
    if hsn8:
        exact = {r["year"]: (r["india_exports"], r["india_imports"]) for r in rows(
            conn, "SELECT year, india_exports, india_imports FROM trade_hs8 WHERE hsn8 = ?", (hsn8,))}
        for point in data:
            x, m = exact.get(point["year"], (None, None))
            point["exports"], point["imports"] = x, m
    return data


# --------------------------------------------------------------------------- product search (SPEC 6.3)

#: Sort keys accepted by :func:`search_products` (SPEC 6.3 ``sort=``).
SEARCH_SORTS = ("relevance", "exports", "imports", "rca", "code", "world_trade")
_SORT_COLUMNS = {"exports": "m.india_exports", "imports": "m.india_imports", "rca": "m.rca",
                 "world_trade": "m.world_trade"}
#: FTS5 columns searched first (ministry / sector names are only used as a fallback - otherwise "tyre" would
#: match every chapter-40 line through the sector name "Rubber & Tyres").
FTS_TEXT_COLUMNS = ("hsn8", "description", "full_description")
#: bm25 weights for (hsn8, description, full_description, ministry, sector).
FTS_WEIGHTS = (5.0, 10.0, 3.0, 1.0, 1.0)
_STOPWORDS = frozenset({"a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of", "on", "or", "the",
                        "to", "with", "without"})
_WORD = re.compile(r"\w+", re.UNICODE)
_CODE_QUERY = re.compile(r"(?i)\s*(?:(?:itc[\s-]*)?hsn?(?:\s*code)?|code|tariff\s*line)?\s*[:#-]?\s*([\d.\s]+)\s*")
_FTS_MAX_TOKENS = 8


def parse_code_query(q: str | None) -> str | None:
    """The digits of a code-like query (``"4011"``, ``"4011.10.10"``, ``"HS 6109"``, ``"hsn: 61 09"``), else None.

    Codes longer than 8 digits are cut to the 8-digit national line.
    """
    if not q:
        return None
    m = _CODE_QUERY.fullmatch(q)
    if not m:
        return None
    digits = re.sub(r"\D", "", m.group(1))
    return digits[:8] or None


def fts_query(q: str | None, *, any_terms: bool = False,
              columns: Sequence[str] | None = FTS_TEXT_COLUMNS) -> str | None:
    """Build a safe FTS5 MATCH expression from free text (None when ``q`` has no word characters).

    Every token is quoted (so ``AND`` / ``NOT`` / quotes in user input are literal) and prefix-matched
    (``"tyre"*``), common stop words are dropped, and adjacent tokens are also tried as one compound word
    so ``tyre cord`` finds the HS text ``tyrecord``. ``any_terms=True`` ORs the tokens instead of ANDing them.
    ``columns`` restricts the match to those FTS columns (None = all columns).
    """
    tokens = [t.lower() for t in _WORD.findall(q or "")]
    if not tokens:
        return None
    tokens = ([t for t in tokens if t not in _STOPWORDS] or tokens)[:_FTS_MAX_TOKENS]

    def term(token: str) -> str:
        # A one-letter token ("t" of "T-shirts") is matched exactly unless it is all the user typed so far:
        # a one-letter prefix expands to thousands of index terms.
        return f'"{token}"' if len(token) == 1 and len(tokens) > 1 else f'"{token}"*'

    if any_terms or len(tokens) == 1:
        expr = " OR ".join(term(t) for t in tokens)
    else:
        alternatives = [tokens] + [tokens[:i] + [tokens[i] + tokens[i + 1]] + tokens[i + 2:]
                                   for i in range(len(tokens) - 1)]
        expr = " OR ".join("(" + " ".join(term(t) for t in alt) + ")" for alt in alternatives)
    if columns:
        return "{" + " ".join(columns) + "} : (" + expr + ")"
    return expr


def _search_filters(*, ministry_id: str | None, ministry_role: str, sector_id: str | None,
                    chapter: str | Sequence[str] | None, mapping_status: str | None, mapping_source: str | None,
                    min_exports: float | None, min_imports: float | None, rca_min: float | None,
                    rca_max: float | None, prefix: str | None, current_only: bool) -> tuple[list[str], list]:
    """WHERE fragments + params for the facets of :func:`search_products`."""
    where: list[str] = []
    params: list = []
    if ministry_id:
        if ministry_role == "any":
            where.append("(p.ministry_id = ? OR EXISTS (SELECT 1 FROM product_ministries pm "
                         "WHERE pm.hsn8 = p.hsn8 AND pm.ministry_id = ?))")
            params += [ministry_id, ministry_id]
        elif ministry_role == "secondary":
            where.append("EXISTS (SELECT 1 FROM product_ministries pm WHERE pm.hsn8 = p.hsn8 "
                         "AND pm.ministry_id = ? AND pm.role = 'secondary')")
            params.append(ministry_id)
        elif ministry_role == "primary":
            where.append("p.ministry_id = ?")
            params.append(ministry_id)
        else:
            raise ValueError("ministry_role must be 'primary', 'secondary' or 'any'")
    if sector_id:
        where.append("p.sector_id = ?")
        params.append(sector_id)
    if chapter:
        raw = chapter.split(",") if isinstance(chapter, str) else list(chapter)
        chapters = [c.zfill(2) for c in (normalize_code(x) for x in raw) if c.isdigit() and len(c) <= 2]
        if not chapters:
            raise ValueError("chapter must be one or more 2-digit HS chapters, e.g. '61' or '61,62'")
        where.append(in_json("p.hs2"))
        params.append(json_param(chapters))
    if mapping_status:
        where.append("p.mapping_status = ?")
        params.append(mapping_status)
    if mapping_source:
        where.append("p.mapping_source = ?")
        params.append(mapping_source)
    for value, sql in ((min_exports, "m.india_exports >= ?"), (min_imports, "m.india_imports >= ?"),
                       (rca_min, "m.rca >= ?"), (rca_max, "m.rca <= ?")):
        if value is not None:
            where.append(sql)
            params.append(float(value))
    if prefix:
        code = normalize_code(prefix)
        if not code.isdigit():
            raise ValueError("prefix must be digits, e.g. '4011'")
        where.append("p.hsn8 GLOB ?")
        params.append(code[:8] + "*")
    if current_only:
        where.append("p.is_current = 1")
    return where, params


def search_products(conn: sqlite3.Connection, *, q: str | None = None, ministry_id: str | None = None,
                    ministry_role: str = "primary", sector_id: str | None = None,
                    chapter: str | Sequence[str] | None = None, mapping_status: str | None = None,
                    mapping_source: str | None = None, min_exports: float | None = None,
                    min_imports: float | None = None, rca_min: float | None = None, rca_max: float | None = None,
                    prefix: str | None = None, current_only: bool = False, sort: str = "relevance",
                    order: str | None = None, page: int = 1, page_size: int | None = DEFAULT_PAGE_SIZE,
                    extra_where: str | None = None, extra_params: Sequence = ()) -> dict:
    """Faceted product search -> ``{items: ProductSummary[], total, page, page_size, match}`` (SPEC 6.3).

    ``q`` - a code (digits; dots, spaces and an ``HS`` / ``HSN`` prefix ignored) matches 8-digit lines by code
    prefix *and* the FTS index (descriptions that cite the code); relevance = exact code first, then code
    prefix (in code order), then bm25. Any other text runs FTS5 with prefix terms, first over code and
    descriptions (all words), then over all columns incl. ministry / sector names, then with any word; the
    first stage with results wins and is reported as ``match`` (``code`` | ``text`` | ``text_all_columns`` |
    ``text_any`` | ``none``; ``all`` when there is no ``q``).

    Facets: ``ministry_id`` (``ministry_role`` 'primary' (default) | 'secondary' | 'any' owner), ``sector_id``,
    ``chapter`` ('61' or '61,62'), ``mapping_status``, ``mapping_source``, ``min_exports`` / ``min_imports``
    (US$, HS6 level), ``rca_min`` / ``rca_max``, ``prefix`` (code prefix), ``current_only``. ``extra_where`` /
    ``extra_params`` add a raw condition over the ``product_summaries`` aliases.

    ``sort`` in :data:`SEARCH_SORTS` (``relevance`` falls back to code order without ``q``); ``order``
    'asc' | 'desc' (default: desc for values, asc for code). NULL values always sort last.
    ``page_size=None`` returns every match (internal use, e.g. CSV exports). Raises ``ValueError`` for bad input.
    """
    if sort not in SEARCH_SORTS:
        raise ValueError(f"sort must be one of {', '.join(SEARCH_SORTS)}")
    if order not in (None, "asc", "desc"):
        raise ValueError("order must be 'asc' or 'desc'")
    if page_size is None:
        page, size, offset = max(1, int(page or 1)), None, 0
    else:
        page, size, offset = page_window(page, page_size)

    where, fparams = _search_filters(
        ministry_id=ministry_id, ministry_role=ministry_role, sector_id=sector_id, chapter=chapter,
        mapping_status=mapping_status, mapping_source=mapping_source, min_exports=min_exports,
        min_imports=min_imports, rca_min=rca_min, rca_max=rca_max, prefix=prefix, current_only=current_only)
    if extra_where:
        where.append(f"({extra_where})")
        fparams += list(extra_params)

    q = (q or "").strip()
    code = parse_code_query(q)
    weights = ", ".join(str(w) for w in FTS_WEIGHTS)
    with_fts = (f"WITH hits AS (SELECT rowid AS rid, bm25(products_fts, {weights}) AS score "
                "FROM products_fts WHERE products_fts MATCH ?)")

    # Candidate plans, tried in order until one has results. Each plan:
    # (match label, MATCH params, extra_select, extra_select params, join_sql, where list, where params)
    plans: list[tuple[str, list, str, list, str, list[str], list]] = []
    if not q:
        plans.append(("all", [], "", [], "", where, fparams))
    elif code:
        # The candidate rowid set (code prefix UNION FTS hits) drives the scan, so the joins only run for matches.
        plans.append(("code", [fts_query(code, columns=None)],
                      "CASE WHEN p.hsn8 = ? THEN 0 WHEN p.hsn8 GLOB ? THEN 1 ELSE 2 END AS _tier, h.score AS _score",
                      [code, code + "*"], "LEFT JOIN hits h ON h.rid = p.rowid",
                      ["p.rowid IN (SELECT rowid FROM products WHERE hsn8 GLOB ? UNION SELECT rid FROM hits)"] + where,
                      [code + "*"] + fparams))
    else:
        seen: set[str] = set()
        for label, expr in (("text", fts_query(q)), ("text_all_columns", fts_query(q, columns=None)),
                            ("text_any", fts_query(q, any_terms=True))):
            if expr and expr not in seen:
                seen.add(expr)
                plans.append((label, [expr], "2 AS _tier, h.score AS _score", [],
                              "JOIN hits h ON h.rid = p.rowid", where, fparams))
    if not plans:  # q had no searchable characters
        return {**paginate([], 0, page, size or DEFAULT_PAGE_SIZE), "match": "none"}

    total, chosen = 0, None
    for plan in plans:
        _label, mparams, _sel, _sparams, join_sql, wh, whp = plan
        total = count_products(conn, " AND ".join(wh) or "1=1", mparams + whp,
                               join_sql=join_sql, with_sql=with_fts if mparams else "")
        if total:
            chosen = plan
            break
    if chosen is None:
        return {**paginate([], 0, page, size or DEFAULT_PAGE_SIZE), "match": "none" if q else "all"}
    label, mparams, extra_select, sparams, join_sql, wh, whp = chosen

    if sort == "relevance" and q:
        order_sql = "_tier, CASE WHEN _tier = 2 THEN _score END, p.hsn8"
    elif sort in _SORT_COLUMNS:
        direction = "ASC" if order == "asc" else "DESC"
        order_sql = f"{_SORT_COLUMNS[sort]} {direction} NULLS LAST, p.hsn8"
    else:  # code, or relevance without q
        order_sql = f"p.hsn8 {'DESC' if order == 'desc' else 'ASC'}"
    items = product_summaries(conn, " AND ".join(wh) or "1=1", mparams + sparams + whp, order_sql,
                              limit=size, offset=offset, extra_select=extra_select, join_sql=join_sql,
                              with_sql=with_fts if mparams else "")
    for item in items:
        item.pop("_tier", None)
        item.pop("_score", None)
    return {**paginate(items, total, page, size if size is not None else total), "match": label}
