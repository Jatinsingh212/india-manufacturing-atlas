"""Opportunity Lab analytics (docs/SPEC.md section 6.6): build the analytics layer with AI/ML-based
analytics. Owner: C2. Government roles only (``analyst``, ``ministry``, ``admin``; SPEC section 5): anonymous
callers get 401, ``industry`` users 403.

Endpoints (all HS6-level, latest year 2024; every score is a *model estimate*, method in docs/METHODOLOGY.md):

* ``GET /api/analytics/opportunities``        export potential + untapped potential + opportunity matrix
* ``GET /api/analytics/import-dependency``    dependency ranking + imports by source country
* ``GET /api/analytics/import-substitution``  substitution candidates (net importers >= US$ 10 mn) + schemes
* ``GET /api/analytics/competitiveness``      RCA histogram, by-sector aggregate RCA, top-RCA products
* ``GET /api/analytics/demand-supply``        production vs trade (apparent consumption only in value terms)
* ``GET /api/analytics/archetypes``           rule-based archetypes + k-means clusters
* ``GET /api/analytics/forecast/{code}``      2018-2024 history + 2025-2026 forecast (hs6 / hsn8; also 4 / 2 digits)
* ``GET /api/analytics/trends``               yearly totals for India / a ministry / sector / chapter
* ``GET /api/analytics/anomalies``            the automated alerts (same shape as ``/api/risk/alerts``)

Common filters: ``ministry_id``, ``sector_id``, ``chapter`` (``61`` or ``61,62``), ``chain_id``, ``limit``
(default 50, max 500), ``min_world_trade``, ``min_imports`` (US$). Unknown ministry / sector / chain -> 404.

Decisions
---------
* An HS6 matches ``ministry_id`` / ``sector_id`` when at least one of its 8-digit lines belongs to it; the item's
  ``ministry_*`` / ``sector_*`` are the most common among its lines (SPEC); ``hsn8_sample`` is its lowest line.
* ``chain_id`` selects the HS6 codes of the chain's anchor, items and edges (4-digit codes expanded).
* ``summary`` figures cover *all* filtered products, ``items`` only the top ``limit``.
* Import substitution leaves out primary commodities that domestic manufacturing cannot substitute (ores,
  crude oil / coal / gas, unworked diamonds and stones, precious and unwrought base metals -
  ``app.services.scoring.PRIMARY_GOODS_PREFIXES``); ``include_primary=true`` shows them and ``excluded``
  reports how many were left out (docs/METHODOLOGY.md section 4.5).
* Demand-supply production figures come from the shared chooser ``app.common.production_record`` over the
  real sourced rows (UNIDO INDSTAT, Rubber Board, ATMA, official uploads).
* Competitiveness: ``n_rca_gt1`` counts RCA >= 1; ``rca_weighted`` of a sector is its aggregate Balassa RCA
  ``(sum X / X) / (sum W / W)`` (= the world-trade-weighted mean of its products' RCA); ``top_rca`` ranks
  products with India exports >= US$ 5 mn (noise floor) by RCA.
* ``sort`` (optional) re-ranks ``items`` by another numeric field of the item.
* Responses are built from the cached analytics frame (``app.services.scoring.analytics_frame``) - well under
  the 1.5 s budget on the full database.
"""
from __future__ import annotations

import json
import sqlite3
from collections import defaultdict
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from app.common import (code_descriptions, normalize_code, parse_json, production_provenance, production_record,
                        provenance)
from app.db import get_db, row, rows
from app.security import require_gov
from app.services import forecast as fc
from app.services.graph import chain_hs6
from app.services.scoring import (ALERT_RULES, ARCHETYPES, PRIMARY_GOODS_PREFIXES, SEVERITY_ORDER, Frame, aggregate,
                                  analytics_frame, cached, is_primary_good)

router = APIRouter(prefix="/api/analytics", tags=["analytics"], dependencies=[Depends(require_gov)])

DEFAULT_LIMIT = 50
MAX_LIMIT = 500
TOP_RCA_MIN_EXPORTS = 5e6
RCA_BUCKETS = ((0.0, 0.1, "0-0.1"), (0.1, 0.5, "0.1-0.5"), (0.5, 1.0, "0.5-1"), (1.0, 2.0, "1-2"),
               (2.0, 5.0, "2-5"), (5.0, float("inf"), "5+"))
TrendLevel = Literal["total", "ministry", "sector", "chapter"]
Severity = Literal["high", "medium", "low"]
AlertKind = Literal["import_surge", "export_drop", "concentration", "china_dependence"]
ARCHETYPE_RULES = {
    "Champion": "RCA >= 1 and India's export CAGR >= world CAGR",
    "Established": "RCA >= 1",
    "Emerging": "0.3 <= RCA < 1 and India's export CAGR > world CAGR",
    "Dependent": "Imports >= 2 x exports and imports >= US$ 50 mn",
    "Marginal": "None of the rules above",
}


# =========================================================================== shared helpers (risk / policy use them)

def trade_provenance(year: int = 2024) -> dict:
    return provenance("tradestat", year=year)


def model_provenance(label: str = "Model estimate - Atlas analytical model (derived from official DGFT/DGCIS & UN trade data)") -> dict:
    return provenance("model", "not_verified", label)


def common_filters(
    ministry_id: str | None = Query(None, description="Ministry / department id (any of the HS6's lines)"),
    sector_id: str | None = Query(None, description="Sector id (any of the HS6's lines)"),
    chapter: str | None = Query(None, description="HS chapter(s), e.g. '61' or '61,62'"),
    chain_id: str | None = Query(None, description="Value chain id"),
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    min_world_trade: float | None = Query(None, ge=0, description="US$"),
    min_imports: float | None = Query(None, ge=0, description="US$"),
) -> dict:
    """The SPEC 6.6 common filters as a dict (FastAPI dependency)."""
    return {"ministry_id": ministry_id or None, "sector_id": sector_id or None, "chapter": chapter or None,
            "chain_id": chain_id or None, "limit": limit, "min_world_trade": min_world_trade,
            "min_imports": min_imports}


def _exists(conn: sqlite3.Connection, table: str, id_: str) -> bool:
    return row(conn, f"SELECT 1 AS x FROM {table} WHERE id = ?", (id_,)) is not None


def filter_rows(conn: sqlite3.Connection, frame: Frame, f: dict) -> list[dict]:
    """Frame rows matching the common filters (404 unknown ids, 400 bad chapter)."""
    out = frame.rows
    if f.get("ministry_id"):
        mid = f["ministry_id"]
        if not _exists(conn, "ministries", mid):
            raise HTTPException(status_code=404, detail=f"Unknown ministry '{mid}'")
        out = [r for r in out if mid in frame.line_ministries.get(r["hs6"], ())]
    if f.get("sector_id"):
        sid = f["sector_id"]
        if not _exists(conn, "sectors", sid):
            raise HTTPException(status_code=404, detail=f"Unknown sector '{sid}'")
        out = [r for r in out if sid in frame.line_sectors.get(r["hs6"], ()) or r.get("sector_id") == sid]
    if f.get("chapter"):
        chapters = set()
        for part in str(f["chapter"]).split(","):
            code = normalize_code(part)
            if not code.isdigit() or len(code) > 2:
                raise HTTPException(status_code=400, detail="chapter must be one or more 2-digit HS chapters, e.g. 61,62")
            chapters.add(code.zfill(2))
        out = [r for r in out if r["hs2"] in chapters]
    if f.get("chain_id"):
        codes = chain_hs6(conn, f["chain_id"])
        if codes is None:
            raise HTTPException(status_code=404, detail=f"Unknown value chain '{f['chain_id']}'")
        wanted = set(codes)
        out = [r for r in out if r["hs6"] in wanted]
    if f.get("min_world_trade") is not None:
        out = [r for r in out if (r.get("world_trade") or 0) >= f["min_world_trade"]]
    if f.get("min_imports") is not None:
        out = [r for r in out if (r.get("india_imports") or 0) >= f["min_imports"]]
    return out


def item_base(r: dict) -> dict:
    """``{hs6, description, hsn8_sample, ministry_id, ministry_short, sector_id, sector_name}``."""
    return {"hs6": r["hs6"], "description": r["description"], "hsn8_sample": r.get("hsn8_sample"),
            "ministry_id": r.get("ministry_id"), "ministry_short": r.get("ministry_short"),
            "sector_id": r.get("sector_id"), "sector_name": r.get("sector_name")}


def pick(r: dict, *keys: str) -> dict:
    return {k: r.get(k) for k in keys}


def ranked(items: list[dict], key: str, *, reverse: bool = True) -> list[dict]:
    """Sort by ``key`` (None last), then hs6."""
    present = [r for r in items if r.get(key) is not None]
    missing = [r for r in items if r.get(key) is None]
    present.sort(key=lambda r: (-(r[key]) if reverse else r[key], r["hs6"]))
    missing.sort(key=lambda r: r["hs6"])
    return present + missing


def _sort_items(items: list[dict], sort: str | None, default: str) -> list[dict]:
    key = sort or default
    if items and key not in items[0]:
        raise HTTPException(status_code=400, detail=f"cannot sort by '{key}'")
    return ranked(items, key)


def scheme_index(conn: sqlite3.Connection) -> list[dict]:
    """Cached ``[{prefix, id, name, kind}]`` of scheme product prefixes."""
    def build(c: sqlite3.Connection) -> list[dict]:
        return rows(c, """SELECT sp.hs_prefix AS prefix, s.id, s.name, s.kind FROM scheme_products sp
                          JOIN schemes s ON s.id = sp.scheme_id ORDER BY s.kind, s.id, sp.hs_prefix""")
    return cached(conn, "scheme_index", build)


def schemes_for_code(index: list[dict], code: str) -> list[dict]:
    """Schemes whose prefix covers ``code`` or lies under it (8-digit prefixes inside an HS6)."""
    out: dict[str, dict] = {}
    for s in index:
        p = s["prefix"]
        if code.startswith(p) or p.startswith(code):
            out.setdefault(s["id"], {"id": s["id"], "name": s["name"], "kind": s["kind"]})
    return list(out.values())


def alerts_list(conn: sqlite3.Connection, *, severity: str | None = None, kind: str | None = None,
                limit: int = 100, hs6_set: set | None = None) -> list[dict]:
    """Alerts (``[{id, kind, hs6, description, severity, title, detail, value, created_at}]``), high first."""
    where, params = ["1=1"], []
    if severity:
        where.append("a.severity = ?")
        params.append(severity)
    if kind:
        where.append("a.kind = ?")
        params.append(kind)
    data = rows(conn, f"""
        SELECT a.id, a.kind, a.hs6, COALESCE(hp.description, n.description, 'HS ' || a.hs6) AS description,
               a.severity, a.title, a.detail, a.value, a.created_at
        FROM alerts a LEFT JOIN hs6_products hp ON hp.hs6 = a.hs6 LEFT JOIN hs_nodes n ON n.code = a.hs6
        WHERE {' AND '.join(where)}""", params)
    if hs6_set is not None:
        data = [a for a in data if a["hs6"] in hs6_set]
    kind_order = {k: i for i, k in enumerate(ALERT_RULES)}
    data.sort(key=lambda a: (SEVERITY_ORDER.get(a["severity"], 9), kind_order.get(a["kind"], 9),
                             -abs(a["value"] or 0), a["id"]))
    frame = analytics_frame(conn)
    for a in data[:limit]:
        r = frame.by_hs6.get(a["hs6"])
        a["ministry_id"] = r.get("ministry_id") if r else None
        a["ministry_short"] = r.get("ministry_short") if r else None
        a["sector_id"] = r.get("sector_id") if r else None
        a["hsn8_sample"] = r.get("hsn8_sample") if r else None
    return data[:limit]


def _filtered_hs6(conn: sqlite3.Connection, f: dict) -> set | None:
    """HS6 set of the filters, or None when no filter restricts the universe."""
    keys = ("ministry_id", "sector_id", "chapter", "chain_id", "min_world_trade", "min_imports")
    if not any(f.get(k) is not None for k in keys):
        return None
    return {r["hs6"] for r in filter_rows(conn, analytics_frame(conn), f)}


def source_country_breakdown(conn: sqlite3.Connection, hs6_list: list[str], limit: int = 15) -> list[dict]:
    """India's imports by source country over the HS6 codes: ``[{country_id, country, imports, n_products}]``."""
    def build(c: sqlite3.Connection, codes: tuple) -> list[dict]:
        if not codes:
            return []
        return rows(c, """
            SELECT ip.country_id, COALESCE(co.name, ip.country_id) AS country, SUM(ip.value) AS imports,
                   COUNT(DISTINCT ip.hs6) AS n_products
            FROM india_partners ip LEFT JOIN countries co ON co.id = ip.country_id
            WHERE ip.flow = 'M' AND ip.value > 0 AND ip.hs6 IN (SELECT value FROM json_each(?))
            GROUP BY ip.country_id ORDER BY imports DESC, ip.country_id""", (json.dumps(list(codes)),))
    data = cached(conn, "source_countries", build, tuple(sorted(hs6_list)))
    return [dict(r) for r in data[:limit]]


# =========================================================================== endpoints

@router.get("/opportunities", summary="Export potential, untapped potential and the opportunity matrix")
def opportunities(f: dict = Depends(common_filters),
                  sort: str | None = Query(None, description="item field to rank by (default export_potential_score)"),
                  conn: sqlite3.Connection = Depends(get_db)) -> dict:
    frame = analytics_frame(conn)
    data = filter_rows(conn, frame, f)
    fields = ("india_exports", "world_trade", "rca", "world_cagr", "export_cagr", "export_potential_score",
              "untapped_potential_usd", "archetype", "india_world_share")
    items = [{**item_base(r), **pick(r, *fields)} for r in data]
    items = _sort_items(items, sort, "export_potential_score")[: f["limit"]]
    matrix = [{"hs6": i["hs6"], "label": i["description"], "x": i["rca"], "y": i["world_cagr"],
               "size": i["world_trade"], "archetype": i["archetype"],
               "export_potential_score": i["export_potential_score"]} for i in items]
    total_untapped = sum(r.get("untapped_potential_usd") or 0.0 for r in data) if frame.scored else None
    return {"items": items, "matrix": matrix,
            "summary": {"total_untapped_usd": total_untapped, "n_products": len(data),
                        "total_exports": sum(r.get("india_exports") or 0.0 for r in data),
                        "n_with_untapped": sum(1 for r in data if (r.get("untapped_potential_usd") or 0) > 0)},
            "scored": frame.scored,
            "provenance": {"trade": trade_provenance(), "scores": model_provenance()}}


@router.get("/import-dependency", summary="Import dependency ranking and imports by source country")
def import_dependency(f: dict = Depends(common_filters), sort: str | None = Query(None),
                      conn: sqlite3.Connection = Depends(get_db)) -> dict:
    frame = analytics_frame(conn)
    data = [r for r in filter_rows(conn, frame, f) if (r.get("india_imports") or 0) > 0]
    fields = ("india_imports", "india_exports", "dependency_ratio", "india_import_hhi", "top_import_source",
              "top_import_source_name", "top_import_source_share", "china_import_share",
              "import_dependency_score", "vulnerability_score", "n_import_sources")
    items = [{**item_base(r), **pick(r, *fields)} for r in data]
    items = _sort_items(items, sort, "import_dependency_score")[: f["limit"]]
    total = sum(r["india_imports"] for r in data)
    from_china = sum(r["india_imports"] * (r.get("china_import_share") or 0.0) for r in data)
    return {"items": items, "by_source_country": source_country_breakdown(conn, [r["hs6"] for r in data]),
            "summary": {"total_imports": total, "china_share": (from_china / total) if total else None,
                        "imports_from_china": from_china, "n_products": len(data)},
            "scored": frame.scored,
            "provenance": {"trade": trade_provenance(), "scores": model_provenance()}}


@router.get("/import-substitution", summary="Import substitution candidates")
def import_substitution(f: dict = Depends(common_filters), sort: str | None = Query(None),
                        include_primary: bool = Query(False, description="Also list primary commodities (ores, "
                                                      "fuels, unworked stones, precious / unwrought metals)"),
                        conn: sqlite3.Connection = Depends(get_db)) -> dict:
    frame = analytics_frame(conn)
    scored = [r for r in filter_rows(conn, frame, f) if r.get("substitution_score") is not None]
    primary = [] if include_primary else [r for r in scored if is_primary_good(r["hs6"])]
    excluded_hs6 = {r["hs6"] for r in primary}
    data = [r for r in scored if r["hs6"] not in excluded_hs6]
    index = scheme_index(conn)
    fields = ("india_imports", "india_exports", "rca", "world_supplier_hhi", "mfn_tariff", "substitution_score",
              "top_import_source", "top_import_source_name", "china_import_share", "archetype")
    items = [{**item_base(r), **pick(r, *fields)} for r in data]
    items = _sort_items(items, sort, "substitution_score")[: f["limit"]]
    for i in items:
        i["schemes"] = schemes_for_code(index, i["hs6"])
    total_m = sum(r.get("india_imports") or 0.0 for r in data)
    total_x = sum(r.get("india_exports") or 0.0 for r in data)
    with_scheme = sum(1 for r in data if schemes_for_code(index, r["hs6"]))
    scores = [r["substitution_score"] for r in data]
    return {"items": items,
            "summary": {"n_products": len(data), "total_imports": total_m, "total_exports": total_x,
                        "net_imports": total_m - total_x, "n_with_scheme": with_scheme,
                        "avg_substitution_score": (sum(scores) / len(scores)) if scores else None},
            "excluded": {"n_products": len(primary),
                         "imports": sum(r.get("india_imports") or 0.0 for r in primary),
                         "rule": ("Primary commodities are not substitution candidates: ores, crude oil / coal / "
                                  "gas, unworked diamonds and precious stones, precious metals and unwrought base "
                                  "metals (HS " + ", ".join(PRIMARY_GOODS_PREFIXES) + "). Add include_primary=true "
                                  "to list them."),
                         "included": include_primary},
            "scored": frame.scored,
            "provenance": {"trade": trade_provenance(), "tariff": provenance("wits", year=2022),
                           "scores": model_provenance()}}


@router.get("/competitiveness", summary="RCA-based competitiveness")
def competitiveness(f: dict = Depends(common_filters), conn: sqlite3.Connection = Depends(get_db)) -> dict:
    frame = analytics_frame(conn)
    data = [r for r in filter_rows(conn, frame, f) if r.get("rca") is not None]
    histogram = []
    for lo, hi, label in RCA_BUCKETS:
        members = [r for r in data if lo <= r["rca"] < hi]
        histogram.append({"bucket": label, "min": lo, "max": None if hi == float("inf") else hi,
                          "count": len(members), "exports": sum(r.get("india_exports") or 0.0 for r in members)})
    sectors: dict[str, list] = defaultdict(list)
    names: dict[str, str] = {}
    for r in data:
        sid = r.get("sector_id") or "unassigned"
        sectors[sid].append(r)
        names[sid] = r.get("sector_name") or "Unassigned"
    by_sector = []
    for sid, members in sectors.items():
        agg = aggregate(frame, [m["hs6"] for m in members])
        by_sector.append({"sector_id": sid, "name": names[sid], "rca_weighted": agg["rca"],
                          "n_rca_gt1": sum(1 for m in members if m["rca"] >= 1), "n_products": len(members),
                          "exports": agg["exports"], "world_trade": agg["world_trade"]})
    by_sector.sort(key=lambda s: (-(s["exports"] or 0), s["sector_id"]))
    fields = ("india_exports", "world_trade", "rca", "india_world_share", "export_cagr", "world_cagr", "archetype",
              "india_supplier_rank")
    top = [r for r in data if (r.get("india_exports") or 0) >= TOP_RCA_MIN_EXPORTS]
    top_items = ranked([{**item_base(r), **pick(r, *fields)} for r in top], "rca")[: f["limit"]]
    total_x = sum(r.get("india_exports") or 0.0 for r in data)
    x_gt1 = sum(r.get("india_exports") or 0.0 for r in data if r["rca"] >= 1)
    return {"histogram": histogram, "by_sector": by_sector, "top_rca": top_items,
            "summary": {"n_rca_gt1": sum(1 for r in data if r["rca"] >= 1), "n_products": len(data),
                        "exports_rca_gt1_share": (x_gt1 / total_x) if total_x else None, "total_exports": total_x,
                        "aggregate_rca": aggregate(frame, [r["hs6"] for r in data])["rca"],
                        "top_rca_min_exports": TOP_RCA_MIN_EXPORTS},
            "provenance": {"trade": trade_provenance()}}


def _demand_row(code: str, description: str, prod: dict | None, agg: dict) -> dict:
    """One demand-supply row for a real, sourced production figure (when one exists)."""
    value = prod.get("value") if prod else None
    unit = prod.get("unit") if prod else None
    x, m = agg.get("exports"), agg.get("imports")
    apparent = None
    self_suff = None
    note = None
    if value is not None and unit and unit.lower() in ("usd", "us$"):
        apparent = value + (m or 0.0) - (x or 0.0)
        self_suff = (value / apparent) if apparent and apparent > 0 else None
    elif value is not None:
        note = (f"Production is reported in {unit or 'physical units'}; apparent consumption needs production in "
                "value terms (US$) - Not available")
    else:
        note = "Domestic production: Not available"
    return {"code": code, "description": description, "production": value, "unit": unit,
            "production_label": prod.get("label") if prod else None, "production_year": prod.get("year") if prod else None,
            "imports": m, "exports": x,
            "trade_balance": (x - m) if x is not None and m is not None else None,
            "apparent_consumption": apparent, "self_sufficiency": self_suff, "provenance": production_provenance(prod),
            "trade_provenance": trade_provenance(), "note": note}


def _chain_production(conn: sqlite3.Connection, chain: dict) -> dict | None:
    """India-production row of a chain from the shared real-data chooser."""
    chosen = production_record(conn, "chain", chain["id"], "india_production")[0]
    return {**chosen, "label": "India's production"} if chosen else None


def _code_production(conn: sqlite3.Connection, code: str) -> dict | None:
    return production_record(conn, None, code)[0]


@router.get("/demand-supply", summary="Domestic production vs trade (demand-supply gaps)")
def demand_supply(chain_id: str | None = Query(None), sector_id: str | None = Query(None),
                  limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
                  conn: sqlite3.Connection = Depends(get_db)) -> dict:
    frame = analytics_frame(conn)
    items: list[dict] = []
    if chain_id:
        chain = row(conn, "SELECT * FROM value_chains WHERE id = ?", (chain_id,))
        if chain is None:
            raise HTTPException(status_code=404, detail=f"Unknown value chain '{chain_id}'")
        anchor = chain["anchor_hs"]
        chosen = _chain_production(conn, chain)
        items.append({**_demand_row(anchor, chain.get("title") or chain["name"], chosen,
                                    aggregate(frame, frame.resolve(anchor)[0])), "level": "chain"})
        seen = {anchor}
        codes = rows(conn, """SELECT i.hs_code, MIN(i.item_name) AS item_name FROM vc_items i
                              LEFT JOIN vc_stages s ON s.chain_id = i.chain_id AND s.stage_id = i.stage_id
                              WHERE i.chain_id = ? AND i.hs_code IS NOT NULL
                              GROUP BY i.hs_code ORDER BY MIN(s.stage_order), MIN(i.item_order)""", (chain_id,))
        descs = code_descriptions(conn, [c["hs_code"] for c in codes])
        for c in codes:
            if c["hs_code"] in seen:
                continue
            seen.add(c["hs_code"])
            desc = f"{c['item_name']} - {descs.get(c['hs_code']) or 'HS ' + c['hs_code']}"
            items.append({**_demand_row(c["hs_code"], desc, _code_production(conn, c["hs_code"]),
                                        aggregate(frame, frame.resolve(c["hs_code"])[0])), "level": "item"})
    elif sector_id:
        if not _exists(conn, "sectors", sector_id):
            raise HTTPException(status_code=404, detail=f"Unknown sector '{sector_id}'")
        data = filter_rows(conn, frame, {"sector_id": sector_id})
        data.sort(key=lambda r: (-((r.get("india_imports") or 0) + (r.get("india_exports") or 0)), r["hs6"]))
        for r in data[:limit]:
            prod = _code_production(conn, r["hs6"]) or _code_production(conn, r["hs4"])
            items.append({**_demand_row(r["hs6"], r["description"], prod, aggregate(frame, [r["hs6"]])),
                          "level": "hs6"})
    else:
        for chain in rows(conn, "SELECT * FROM value_chains ORDER BY sort_order, id"):
            anchor = chain["anchor_hs"]
            chosen = _chain_production(conn, chain)
            items.append({**_demand_row(anchor, chain.get("title") or chain["name"], chosen,
                                        aggregate(frame, frame.resolve(anchor)[0])),
                          "level": "chain", "chain_id": chain["id"]})
        seen_codes: set[str] = set()
        for p in rows(conn, "SELECT scope, key FROM production WHERE scope IN ('hsn8', 'hs6', 'hs4') ORDER BY id"):
            if p["key"] in seen_codes:
                continue
            seen_codes.add(p["key"])
            chosen = production_record(conn, None, p["key"])[0]
            items.append({**_demand_row(p["key"], (chosen or {}).get("label") or f"HS {p['key']}", chosen,
                                        aggregate(frame, frame.resolve(p["key"])[0])), "level": p["scope"]})
    return {"items": items[:limit] if not chain_id else items,
            "note": ("Apparent consumption = production + imports - exports, computed only when production is "
                     "known in value terms (US$); physical production figures are shown as reported."),
            "provenance": {"trade": trade_provenance()}}


@router.get("/archetypes", summary="Rule-based archetypes and k-means product clusters")
def archetypes(f: dict = Depends(common_filters), conn: sqlite3.Connection = Depends(get_db)) -> dict:
    frame = analytics_frame(conn)
    data = filter_rows(conn, frame, f)
    n_examples = min(10, max(3, f["limit"] // 10)) if f["limit"] != DEFAULT_LIMIT else 5
    groups: dict[str, list] = defaultdict(list)
    for r in data:
        if r.get("archetype"):
            groups[r["archetype"]].append(r)
    example_key = {"Dependent": "india_imports", "Marginal": "world_trade"}
    out_arch = []
    for name in ARCHETYPES:
        members = groups.get(name, [])
        key = example_key.get(name, "india_exports")
        ex = sorted(members, key=lambda r: (-(r.get(key) or 0), r["hs6"]))[:n_examples]
        out_arch.append({"name": name, "rule": ARCHETYPE_RULES[name], "n": len(members),
                         "exports": sum(r.get("india_exports") or 0.0 for r in members),
                         "imports": sum(r.get("india_imports") or 0.0 for r in members),
                         "examples": [{"hs6": r["hs6"], "description": r["description"],
                                       "value": r.get(key)} for r in ex]})
    clusters: dict[int, list] = defaultdict(list)
    for r in data:
        if r.get("ml_cluster") is not None:
            clusters[int(r["ml_cluster"])].append(r)
    out_clusters = []
    for cid, meta in sorted(frame.clusters_global.items()):
        members = clusters.get(cid, [])
        ex = sorted(members, key=lambda r: (-(r.get("world_trade") or 0), r["hs6"]))[:n_examples]
        arch_mix: dict[str, int] = defaultdict(int)
        for r in members:
            arch_mix[r.get("archetype") or "n/a"] += 1
        out_clusters.append({"id": cid, "n": len(members), "n_total": meta["n_total"], "label": meta["label"],
                             "centroid": meta["centroid"], "z": meta["z"],
                             "exports": sum(r.get("india_exports") or 0.0 for r in members),
                             "imports": sum(r.get("india_imports") or 0.0 for r in members),
                             "archetype_mix": dict(sorted(arch_mix.items())),
                             "examples": [{"hs6": r["hs6"], "description": r["description"]} for r in ex]})
    return {"archetypes": out_arch, "clusters": out_clusters, "n_products": len(data), "scored": frame.scored,
            "method": {"archetypes": ARCHETYPE_RULES,
                       "clusters": ("k-means (k = 6, random_state = 42, n_init = 10) on standardised "
                                    "[log1p exports, log1p imports, log1p world trade, min(RCA, 5), world CAGR and "
                                    "export CAGR clipped to +-0.5]; centroid values are in those feature units, "
                                    "z = standard deviations from the mean of all products")},
            "provenance": {"scores": model_provenance()}}


def _forecast_body(conn: sqlite3.Connection, code: str) -> dict:
    frame = analytics_frame(conn)
    digits = "".join(ch for ch in code if ch.isdigit())
    if len(digits) not in (2, 4, 6, 8):
        raise HTTPException(status_code=404, detail=f"'{code}' is not an HS code (2, 4, 6 or 8 digits)")
    description = code_descriptions(conn, [digits]).get(digits)
    if len(digits) == 8 and description is None:
        raise HTTPException(status_code=404, detail=f"Unknown 8-digit line {digits}")
    hs6s, level = frame.resolve(digits)
    if not hs6s:
        raise HTTPException(status_code=404, detail=f"No trade data for HS {digits}")
    history = fc.series_for(conn, hs6s)
    stored = None
    if len(hs6s) == 1:
        s = row(conn, "SELECT forecast_json FROM hs6_scores WHERE hs6 = ?", (hs6s[0],))
        stored = parse_json(s["forecast_json"], None) if s else None
    forecast = stored if isinstance(stored, dict) else fc.forecast_from_history(history)
    growth = {"exports": fc.trend_growth({h["year"]: h["exports"] for h in history}),
              "imports": fc.trend_growth({h["year"]: h["imports"] for h in history})}
    return {"code": digits, "description": description or (frame.by_hs6[hs6s[0]]["description"]
                                                           if len(hs6s) == 1 else f"HS {digits}"),
            "trade_level": level, "hs6_codes": hs6s if len(hs6s) <= 50 else hs6s[:50], "n_hs6": len(hs6s),
            "history": history,
            "forecast": {"exports": forecast.get("exports") or [], "imports": forecast.get("imports") or []},
            "trend_growth": growth, "method": fc.METHOD,
            "provenance": {"history": trade_provenance(), "forecast": model_provenance()}}


@router.get("/forecast/{code}", summary="Trade history and 2025-2026 forecast for an HS code")
def forecast(code: str, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    return cached(conn, "forecast", lambda c, k: _forecast_body(c, k), normalize_code(code))


def _trend_series(conn: sqlite3.Connection, level: str, id_: str | None) -> list[dict]:
    if level == "total":
        return rows(conn, """SELECT year, SUM(india_exports) AS exports, SUM(india_imports) AS imports,
                                    SUM(world_trade) AS world_trade FROM trade_hs6 GROUP BY year ORDER BY year""")
    if level == "chapter":
        return rows(conn, """SELECT year, SUM(india_exports) AS exports, SUM(india_imports) AS imports,
                                    SUM(world_trade) AS world_trade FROM trade_hs6 WHERE hs6 GLOB ?
                             GROUP BY year ORDER BY year""", (f"{id_}*",))
    column = "ministry_id" if level == "ministry" else "sector_id"
    return rows(conn, f"""
        SELECT t.year, SUM(COALESCE(t.india_exports, 0) * m.weight) AS exports,
               SUM(COALESCE(t.india_imports, 0) * m.weight) AS imports,
               SUM(COALESCE(t.world_trade, 0) * m.weight) AS world_trade
        FROM products p JOIN v_product_trade m ON m.hsn8 = p.hsn8
        JOIN trade_hs6 t ON t.hs6 = m.metric_hs6
        WHERE p.{column} = ? GROUP BY t.year ORDER BY t.year""", (id_,))


@router.get("/trends", summary="Yearly trade totals (India, ministry, sector or chapter)")
def trends(level: TrendLevel = Query("total"), id: str | None = Query(None),  # noqa: A002 - SPEC name
           conn: sqlite3.Connection = Depends(get_db)) -> dict:
    ident = None
    if level != "total":
        if not id:
            raise HTTPException(status_code=400, detail=f"id is required for level={level}")
        ident = id
        if level == "chapter":
            ident = normalize_code(id).zfill(2)
            if not ident.isdigit() or len(ident) != 2:
                raise HTTPException(status_code=400, detail="chapter id must be a 2-digit HS chapter")
        elif not _exists(conn, "ministries" if level == "ministry" else "sectors", ident):
            raise HTTPException(status_code=404, detail=f"Unknown {level} '{ident}'")
    series = cached(conn, "trends", _trend_series, level, ident)
    note = None
    if level in ("ministry", "sector"):
        note = ("Ministry / sector totals apportion each HS6 value over its 8-digit lines (value / lines_in_hs6); "
                "2018-2021 use HS2017 codes, so codes changed in HS2022 may be missing from those years.")
    return {"level": level, "id": ident, "series": [dict(s) for s in series], "note": note,
            "provenance": trade_provenance()}


@router.get("/anomalies", summary="Automated alerts (import surges, export drops, concentration, China dependence)")
def anomalies(severity: Severity | None = Query(None), kind: AlertKind | None = Query(None),
              f: dict = Depends(common_filters), conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    hs6_set = _filtered_hs6(conn, f)
    limit = f["limit"] if f["limit"] != DEFAULT_LIMIT else 100
    return alerts_list(conn, severity=severity, kind=kind, limit=limit, hs6_set=hs6_set)
