"""Reference data and the Atlas overview dashboard (docs/SPEC.md section 6.2). Public.

* ``GET /api/meta/overview``   - KPIs, distribution by ministry and sector, mapping sources, data freshness,
  provenance.
* ``GET /api/meta/ministries`` - every ministry with code counts and trade (residual bucket last).
* ``GET /api/meta/sectors``    - every sector with code counts and trade.
* ``GET /api/meta/sections``   - the 21 HS sections with their chapters and code counts.
* ``GET /api/meta/countries``  - OEC countries.
* ``GET /api/meta/info``       - the four left-panel info cards.

Conventions (see also ``app.common``):

* Code counts are current lines (``products.is_current = 1``).
* Ministry / sector trade = ``SUM(hs6 value / lines_in_hs6)`` over the entity's lines (the ``*_alloc``
  convention of ``v_product_trade``), so the parts add up to India's total without double counting.
* ``kpis.hs6_with_trade`` = HS6 subheadings with India exports or imports > 0 in the latest year;
  ``kpis.india_exports`` / ``india_imports`` / ``world_trade`` = sums over all HS6 rows of ``hs6_metrics``.
"""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query

from app.common import latest_year, parse_json, provenance
from app.db import get_db, row, rows, scalar

router = APIRouter(prefix="/api/meta", tags=["meta"])

#: SQL for "this product line is counted in KPIs" (see module docstring).
CURRENT = "p.is_current = 1"
_ALLOC = ("SUM(COALESCE(m.exports_alloc, 0)) AS exports, "
          "SUM(COALESCE(m.imports_alloc, 0)) AS imports")


def ministry_distribution(conn: sqlite3.Connection, *, include_residual: bool = False) -> list[dict]:
    """``[{ministry_id, short_name, name, color, codes, exports, imports}]`` by codes desc."""
    where = CURRENT + ("" if include_residual else " AND p.ministry_id <> 'residual'")
    return rows(conn, f"""
        SELECT p.ministry_id, mi.short_name, mi.name, mi.color, COUNT(*) AS codes, {_ALLOC}
        FROM products p JOIN ministries mi ON mi.id = p.ministry_id
        LEFT JOIN v_product_trade m ON m.hsn8 = p.hsn8
        WHERE {where}
        GROUP BY p.ministry_id ORDER BY codes DESC, p.ministry_id""")


def sector_distribution(conn: sqlite3.Connection) -> list[dict]:
    """``[{sector_id, name, color, codes, exports, imports}]`` by codes desc."""
    return rows(conn, f"""
        SELECT p.sector_id, se.name, se.color, COUNT(*) AS codes, {_ALLOC}
        FROM products p JOIN sectors se ON se.id = p.sector_id
        LEFT JOIN v_product_trade m ON m.hsn8 = p.hsn8
        WHERE {CURRENT}
        GROUP BY p.sector_id ORDER BY codes DESC, p.sector_id""")


FLOW_TOP_SECTORS = 8
FLOW_TOP_MINISTRIES = 9
_STATUS_LABELS = {
    "dpiit_guidebook": "DPIIT Guidebook",
    "official_upload": "Official upload",
    "manual": "Approved claim",
    "rule": "Provisional rule",
    "unmapped": "Not in Guidebook",
    "residual": "Residual (no owner)",
}
_STATUS_ORDER = ["dpiit_guidebook", "official_upload", "manual", "rule", "unmapped", "residual"]


def ownership_flow(conn: sqlite3.Connection) -> dict:
    """Sector -> register -> owning ministry -> mapping status, for the Overview flow diagram.

    One grouped query over current lines; the long tail of sectors and ministries is folded into an
    "other" node so the diagram stays readable. ``exports`` use the 1/lines_in_hs6 allocation, so they add up
    to India's total without double counting.
    """
    data = rows(conn, f"""
        SELECT p.sector_id, p.ministry_id,
               CASE WHEN p.mapping_status = 'residual' THEN 'residual' ELSE p.mapping_source END AS status,
               COUNT(*) AS codes, {_ALLOC}
        FROM products p LEFT JOIN v_product_trade m ON m.hsn8 = p.hsn8
        WHERE {CURRENT}
        GROUP BY 1, 2, 3""")
    sectors = {r["id"]: r for r in rows(conn, "SELECT id, name, color FROM sectors")}
    ministries = {r["id"]: r for r in rows(conn, "SELECT id, short_name, name, color FROM ministries")}

    def totals(key: str) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for r in data:
            t = out.setdefault(r[key] or "other", {"codes": 0, "exports": 0.0})
            t["codes"] += r["codes"]
            t["exports"] += r["exports"] or 0.0
        return out

    sec_tot, min_tot = totals("sector_id"), totals("ministry_id")
    top_sec = [s for s, _ in sorted(sec_tot.items(), key=lambda kv: -kv[1]["codes"])[:FLOW_TOP_SECTORS]]
    top_min = [m for m, _ in sorted(((k, v) for k, v in min_tot.items() if k != "residual"),
                                    key=lambda kv: -kv[1]["codes"])[:FLOW_TOP_MINISTRIES]]

    def sec_node(sid: str | None) -> str:
        return sid if sid in top_sec else "other"

    def min_node(mid: str | None) -> str:
        return mid if mid in top_min or mid == "residual" else "other"

    sm: dict[tuple[str, str], dict] = {}
    ms: dict[tuple[str, str], dict] = {}
    sms: dict[tuple[str, str, str], dict] = {}
    for r in data:
        s, mi, st = sec_node(r["sector_id"]), min_node(r["ministry_id"]), r["status"] or "rule"
        for bucket, key in ((sm, (s, mi)), (ms, (mi, st)), (sms, (s, mi, st))):
            t = bucket.setdefault(key, {"codes": 0, "exports": 0.0})
            t["codes"] += r["codes"]
            t["exports"] += r["exports"] or 0.0

    def node_total(bucket: dict, idx: int, node: str) -> dict:
        codes = sum(v["codes"] for k, v in bucket.items() if k[idx] == node)
        exports = sum(v["exports"] for k, v in bucket.items() if k[idx] == node)
        return {"codes": codes, "exports": round(exports, 2)}

    sector_nodes = [{"id": s, "name": sectors.get(s, {}).get("name", s), "color": sectors.get(s, {}).get("color"),
                     **node_total(sm, 0, s)} for s in top_sec]
    if any(k[0] == "other" for k in sm):
        sector_nodes.append({"id": "other", "name": f"{len(sec_tot) - len(top_sec)} other sectors", "color": None,
                             **node_total(sm, 0, "other")})
    ministry_nodes = [{"id": m, "short_name": ministries.get(m, {}).get("short_name", m),
                       "name": ministries.get(m, {}).get("name", m), "color": ministries.get(m, {}).get("color"),
                       **node_total(ms, 0, m)} for m in top_min]
    if any(k[0] == "other" for k in ms):
        n_other = len([k for k in min_tot if k not in top_min and k != "residual"])
        ministry_nodes.append({"id": "other", "short_name": f"{n_other} others", "name": f"{n_other} other ministries",
                               "color": None, **node_total(ms, 0, "other")})
    if any(k[0] == "residual" for k in ms):
        ministry_nodes.append({"id": "residual", "short_name": "Residual", "name": "Residual (unmapped)",
                               "color": ministries.get("residual", {}).get("color"), **node_total(ms, 0, "residual")})
    status_ids = [s for s in _STATUS_ORDER if any(k[1] == s for k in ms)]
    status_nodes = [{"id": s, "name": _STATUS_LABELS.get(s, s), **node_total(ms, 1, s)} for s in status_ids]

    def links(bucket: dict) -> list[dict]:
        return [{"source": k[0], "target": k[1], "codes": v["codes"], "exports": round(v["exports"], 2)}
                for k, v in sorted(bucket.items(), key=lambda kv: -kv[1]["codes"])]

    triples = [{"sector": k[0], "ministry": k[1], "status": k[2], "codes": v["codes"],
                "exports": round(v["exports"], 2)}
               for k, v in sorted(sms.items(), key=lambda kv: -kv[1]["codes"])]

    return {
        "total_codes": sum(r["codes"] for r in data),
        "total_exports": round(sum(r["exports"] or 0.0 for r in data), 2),
        "latest_year": latest_year(conn),
        "sectors": sector_nodes,
        "ministries": ministry_nodes,
        "statuses": status_nodes,
        "sector_ministry": links(sm),
        "ministry_status": links(ms),
        "sector_ministry_status": triples,
        "provenance": {"mapping": provenance("dpiit_guidebook", "verified",
                                             "DPIIT Guidebook on HSN Code Mapping, 16 December 2025 revision"),
                       "trade": provenance("tradestat", "verified", year=latest_year(conn))},
    }


@router.get("/flow", summary="Ownership flow: sector -> register -> ministry -> mapping status")
def flow(conn: sqlite3.Connection = Depends(get_db)) -> dict:
    return ownership_flow(conn)


_STATUS_SQL = ("COALESCE(CASE WHEN p.mapping_status = 'residual' THEN 'residual' "
               "ELSE p.mapping_source END, 'rule')")


def _flow_filters(
    sector_id: str | None, ministry_id: str | None, status: str | None,
    flow: dict,
) -> tuple[str, list]:
    """WHERE clause for one sector / ministry / status combination of the ownership flow.

    ``sector_id=other`` means the sectors folded into the flow's "other" node; the same applies to
    ``ministry_id=other``. Concrete ids must be one of the flow's nodes, so the detail always agrees
    with the visible tree.
    """
    known_sectors = {n["id"] for n in flow["sectors"]}
    known_ministries = {n["id"] for n in flow["ministries"]}
    known_statuses = {n["id"] for n in flow["statuses"]}
    if sector_id and sector_id not in known_sectors:
        raise HTTPException(status_code=404, detail=f"Unknown flow sector '{sector_id}'")
    if ministry_id and ministry_id not in known_ministries:
        raise HTTPException(status_code=404, detail=f"Unknown flow ministry '{ministry_id}'")
    if status and status not in known_statuses:
        raise HTTPException(status_code=404, detail=f"Unknown flow status '{status}'")

    clauses = [CURRENT]
    params: list = []
    if sector_id == "other":
        top = [n["id"] for n in flow["sectors"] if n["id"] != "other"]
        clauses.append(f"(p.sector_id IS NULL OR p.sector_id NOT IN ({','.join('?' * len(top))}))")
        params.extend(top)
    elif sector_id:
        clauses.append("p.sector_id = ?")
        params.append(sector_id)
    if ministry_id == "other":
        top = [n["id"] for n in flow["ministries"] if n["id"] not in ("other", "residual")]
        clauses.append(
            f"(p.ministry_id IS NULL OR p.ministry_id NOT IN ({','.join('?' * len(top))}, 'residual'))"
        )
        params.extend(top)
    elif ministry_id:
        clauses.append("p.ministry_id = ?")
        params.append(ministry_id)
    if status:
        clauses.append(f"{_STATUS_SQL} = ?")
        params.append(status)
    return " AND ".join(clauses), params


@router.get("/flow/detail", summary="Exact lines and breakdown for one ownership-tree combination")
def flow_detail(
    sector_id: str | None = Query(None, description="Sector id, or 'other' for the folded tail"),
    ministry_id: str | None = Query(None, description="Ministry id, or 'other' for the folded tail"),
    status: str | None = Query(None, description="Mapping status id"),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    """The exact intersection behind a click in the ownership tree.

    The tree folds long tails into ``other``; this endpoint resolves the selected combination to real
    products, actual sectors/ministries inside any folded bucket, and the top lines by allocated
    exports. Every number is computed from the same current lines as ``/api/meta/flow``.
    """
    flow = ownership_flow(conn)
    where, params = _flow_filters(sector_id, ministry_id, status, flow)
    total = row(conn, f"""
        SELECT COUNT(*) AS codes, {_ALLOC}
        FROM products p LEFT JOIN v_product_trade m ON m.hsn8 = p.hsn8
        WHERE {where}""", tuple(params))
    codes = total["codes"] if total else 0
    total_all = flow["total_codes"] or 1

    def breakdown(key: str, join: str, fields: str, limit: int) -> list[dict]:
        return rows(conn, f"""
            SELECT {fields}, COUNT(*) AS codes, {_ALLOC}
            FROM products p JOIN {join} LEFT JOIN v_product_trade m ON m.hsn8 = p.hsn8
            WHERE {where}
            GROUP BY {key} ORDER BY codes DESC, {key} LIMIT ?""", tuple(params) + (limit,))

    sectors = breakdown("p.sector_id", "sectors se ON se.id = p.sector_id",
                        "p.sector_id AS id, se.name, se.color", 8)
    ministries = breakdown("p.ministry_id", "ministries mi ON mi.id = p.ministry_id",
                           "p.ministry_id AS id, mi.short_name, mi.name, mi.color", 8)
    statuses = rows(conn, f"""
        SELECT {_STATUS_SQL} AS id, COUNT(*) AS codes, {_ALLOC}
        FROM products p LEFT JOIN v_product_trade m ON m.hsn8 = p.hsn8
        WHERE {where}
        GROUP BY id""", tuple(params))
    order = {s["id"]: i for i, s in enumerate(flow["statuses"])}
    statuses.sort(key=lambda r: (order.get(r["id"], 99), -r["codes"]))
    for s in statuses:
        s["name"] = _STATUS_LABELS.get(s["id"], s["id"])

    top_lines = rows(conn, f"""
        SELECT p.hsn8, p.description, p.hs6, p.sector_id, se.name AS sector_name,
               p.ministry_id, mi.short_name AS ministry_short, mi.name AS ministry_name,
               {_STATUS_SQL} AS status,
               ROUND(COALESCE(m.exports_alloc, 0), 2) AS exports,
               ROUND(COALESCE(m.imports_alloc, 0), 2) AS imports
        FROM products p
        JOIN sectors se ON se.id = p.sector_id
        JOIN ministries mi ON mi.id = p.ministry_id
        LEFT JOIN v_product_trade m ON m.hsn8 = p.hsn8
        WHERE {where}
        ORDER BY exports DESC, p.hsn8 LIMIT 6""", tuple(params))

    def label(collection: list[dict], value: str | None) -> str | None:
        if not value:
            return None
        return next((n["name"] for n in collection if n["id"] == value), value)

    return {
        "filters": {"sector_id": sector_id, "ministry_id": ministry_id, "status": status},
        "labels": {"sector": label(flow["sectors"], sector_id),
                   "ministry": label(flow["ministries"], ministry_id),
                   "status": label(flow["statuses"], status)},
        "total_codes": codes,
        "total_codes_all": flow["total_codes"],
        "share": round(codes / total_all, 6),
        "exports": round(float(total["exports"] or 0.0), 2) if total else 0.0,
        "imports": round(float(total["imports"] or 0.0), 2) if total else 0.0,
        "breakdown": {"sectors": sectors, "ministries": ministries, "statuses": statuses},
        "top_lines": top_lines,
        "provenance": flow["provenance"],
    }


def mapping_by_level(conn: sqlite3.Connection) -> list[dict]:
    """Guidebook coverage at 2, 4, 6 and 8 digits.

    For 2/4/6 digits a node counts as covered when at least one accepted 8-digit line lies under it;
    ``line_coverage`` always reports the share of national lines accepted. This is a derived view of
    the official 8-digit mapping, not a separate Guidebook acceptance at the parent level.
    """
    out: list[dict] = []
    for length in (2, 4, 6):
        data = rows(conn, f"""
            SELECT substr(hsn8, 1, {length}) AS prefix, COUNT(*) AS lines,
                   SUM(CASE WHEN mapping_status = 'accepted' THEN 1 ELSE 0 END) AS mapped_lines
            FROM products WHERE is_current = 1 GROUP BY prefix""")
        nodes = len(data)
        covered = sum(1 for r in data if (r["mapped_lines"] or 0) > 0)
        lines = sum(r["lines"] or 0 for r in data)
        mapped = sum(r["mapped_lines"] or 0 for r in data)
        out.append({"level": length, "nodes": nodes, "nodes_with_owner": covered,
                    "lines": lines, "mapped_lines": mapped,
                    "node_coverage": round(covered / nodes, 4) if nodes else 0.0,
                    "line_coverage": round(mapped / lines, 4) if lines else 0.0,
                    "source": "dpiit_guidebook", "method": "aggregated_from_8_digit_lines"})
    r = row(conn, "SELECT COUNT(*) AS lines, COALESCE(SUM(mapping_status = 'accepted'), 0) AS mapped_lines "
                  "FROM products WHERE is_current = 1")
    lines = r["lines"] or 0
    mapped = r["mapped_lines"] or 0
    out.append({"level": 8, "nodes": lines, "nodes_with_owner": mapped,
                "lines": lines, "mapped_lines": mapped,
                "node_coverage": round(mapped / lines, 4) if lines else 0.0,
                "line_coverage": round(mapped / lines, 4) if lines else 0.0,
                "source": "dpiit_guidebook", "method": "direct"})
    return out


@router.get("/overview", summary="Atlas dashboard: KPIs, distributions, freshness")
def overview(conn: sqlite3.Connection = Depends(get_db)) -> dict:
    year = latest_year(conn)
    counts = row(conn, f"""
        SELECT COUNT(*) AS total_codes,
               COALESCE(SUM(p.mapping_status = 'accepted'), 0) AS accepted_codes,
               COALESCE(SUM(p.mapping_status = 'residual'), 0) AS residual_codes,
               COUNT(DISTINCT CASE WHEN p.mapping_status = 'accepted' AND p.ministry_id <> 'residual'
                                   THEN p.ministry_id END) AS ministries_assigned,
               COUNT(DISTINCT p.sector_id) AS sectors
        FROM products p WHERE {CURRENT}""")
    trade = row(conn, """
        SELECT SUM(india_exports) AS india_exports, SUM(india_imports) AS india_imports,
               SUM(world_trade) AS world_trade,
               SUM(COALESCE(india_exports, 0) > 0 OR COALESCE(india_imports, 0) > 0) AS hs6_with_trade
        FROM hs6_metrics""")
    kpis = {**counts, "hs6_with_trade": int(trade["hs6_with_trade"] or 0),
            "india_exports": trade["india_exports"], "india_imports": trade["india_imports"],
            "world_trade": trade["world_trade"], "latest_year": year}

    mapping_sources = rows(conn, f"""
        SELECT CASE
                 WHEN p.mapping_status = 'residual' AND p.mapping_source = 'unmapped' THEN 'unmapped'
                 WHEN p.mapping_status = 'residual' THEN 'residual'
                 ELSE p.mapping_source
               END AS source,
               COUNT(*) AS codes
        FROM products p WHERE {CURRENT}
        GROUP BY source ORDER BY codes DESC""")
    sources = {r["source"] for r in mapping_sources}
    if "dpiit_guidebook" in sources:
        mapping_prov = provenance(
            "dpiit_guidebook", "verified",
            "DPIIT Guidebook on HSN Code Mapping, 16 December 2025 revision; residual lines are not accepted "
            "or not listed by the Guidebook")
    elif "official_upload" in sources:
        mapping_prov = provenance("official_upload", "verified",
                                  "Official mapping uploaded through the Data Hub")
    else:
        mapping_prov = provenance(
            None, "not_available",
            "No official ministry mapping is loaded")
    freshness = rows(conn, """SELECT id AS source_id, name, last_refreshed, status FROM data_sources
                              ORDER BY last_refreshed IS NULL, last_refreshed DESC, id""")
    return {
        "kpis": kpis,
        "distribution_by_ministry": ministry_distribution(conn),
        "sector_distribution": sector_distribution(conn),
        "mapping_sources": mapping_sources,
        "mapping_by_level": mapping_by_level(conn),
        "data_freshness": freshness,
        "provenance": {"trade": provenance("tradestat", year=year), "mapping": mapping_prov},
    }


def ministry_list(conn: sqlite3.Connection) -> list[dict]:
    """``[{id, short_name, name, parent_ministry, kind, website, color, codes, accepted, secondary_codes,
    exports, imports}]`` - by codes desc, residual bucket last."""
    data = rows(conn, f"""
        SELECT mi.id, mi.short_name, mi.name, mi.parent_ministry, mi.kind, mi.website, mi.color,
               COUNT(p.hsn8) AS codes, COALESCE(SUM(p.mapping_status = 'accepted'), 0) AS accepted,
               {_ALLOC}
        FROM ministries mi
        LEFT JOIN products p ON p.ministry_id = mi.id AND {CURRENT}
        LEFT JOIN v_product_trade m ON m.hsn8 = p.hsn8
        GROUP BY mi.id
        ORDER BY mi.id = 'residual', codes DESC, mi.short_name""")
    secondary = {r["ministry_id"]: r["n"] for r in rows(conn, """
        SELECT pm.ministry_id, COUNT(*) AS n FROM product_ministries pm WHERE pm.role = 'secondary'
        GROUP BY pm.ministry_id""")}
    for r in data:
        r["secondary_codes"] = secondary.get(r["id"], 0)
        if not r["codes"]:
            r["exports"] = r["imports"] = None
    return data


def sector_list(conn: sqlite3.Connection) -> list[dict]:
    """``[{id, name, description, color, icon, chapters, codes, exports, imports}]`` - by codes desc."""
    data = rows(conn, f"""
        SELECT se.id, se.name, se.description, se.color, se.icon, se.chapters,
               COUNT(p.hsn8) AS codes, {_ALLOC}
        FROM sectors se
        LEFT JOIN products p ON p.sector_id = se.id AND {CURRENT}
        LEFT JOIN v_product_trade m ON m.hsn8 = p.hsn8
        GROUP BY se.id ORDER BY codes DESC, se.name""")
    for r in data:
        r["chapters"] = parse_json(r["chapters"], [])
        if not r["codes"]:
            r["exports"] = r["imports"] = None
    return data


@router.get("/ministries", summary="All ministries / departments with code counts and trade")
def ministries(conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    return ministry_list(conn)


@router.get("/sectors", summary="All sectors with code counts and trade")
def sectors(conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    return sector_list(conn)


@router.get("/sections", summary="HS sections with their chapters")
def sections(conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    chapter_rows = rows(conn, f"""
        SELECT n.code, n.description, n.section_id,
               (SELECT COUNT(*) FROM products p WHERE p.hs2 = n.code AND {CURRENT}) AS codes
        FROM hs_nodes n WHERE n.level = 2 ORDER BY n.code""")
    by_section: dict[str, list[dict]] = {}
    for r in chapter_rows:
        by_section.setdefault(r.pop("section_id"), []).append(r)
    out = []
    for s in rows(conn, "SELECT id, num, name FROM sections ORDER BY num"):
        chapters = by_section.get(s["id"], [])
        out.append({**s, "codes": sum(c["codes"] for c in chapters), "chapters": chapters})
    return out


@router.get("/countries", summary="Countries (OEC ids)")
def countries(conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    return rows(conn, "SELECT id, iso3, name, continent FROM countries ORDER BY name")


@router.get("/info", summary="Info cards of the Guidebook dashboard")
def info(conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    data = rows(conn, "SELECT id, title, icon, body_md, links_json FROM info_pages ORDER BY sort_order, id")
    for r in data:
        links = parse_json(r.pop("links_json"), [])
        r["links"] = links if isinstance(links, list) else []
    return data
