"""Ministry-specific dashboards (docs/SPEC.md section 6.4).

* ``GET /api/ministries``                 - same list as ``/api/meta/ministries`` (convenience).
* ``GET /api/ministries/{id}``            - the dashboard: ministry, KPIs, sector / chapter mix, top exports /
  imports, dependency hotspots, opportunities, value chains, schemes and the 2018-2024 trend.
* ``GET /api/ministries/{id}/products``   - paginated ``ProductSummary`` ("Ministry Wise HS Code" table);
  ``role=primary`` (default) | ``secondary`` | ``any`` selects the ownership role, plus the search facets.

All endpoints are public (SPEC section 5). :func:`build_entity_dashboard` is shared with ``app.routers.sectors``
and can be reused by the report builders (C3): ``build_entity_dashboard(conn, "ministry", "mot")``.

Definitions
-----------
* ``kpis.codes`` = current lines whose primary owner is the ministry; ``accepted`` = those with mapping status
  ``accepted``; ``verified_codes`` (extra) = those whose mapping source is verified (official upload / manual);
  ``secondary_codes`` = lines where the ministry is a secondary owner.
* ``exports`` / ``imports`` / ``world_trade`` / ``trend`` = ``SUM(hs6 value / lines_in_hs6)`` over the lines
  (SPEC section 4 aggregation rule), so ministry totals add up to India's total.
* ``top_exports`` / ``top_imports`` / ``dependency_hotspots`` / ``opportunities`` list one line per HS6 (the
  lowest code among the entity's lines of that HS6) because trade is known at HS6 level only.
* ``dependency_hotspots`` rank by ``vulnerability_score``; ``opportunities`` by ``export_potential_score``.
  When the scores are not available (``hs6_scores`` empty) they fall back to a transparent ranking -
  imports x dependency ratio x top-source share, resp. world trade x min(RCA, 3) among RCA >= 1 - and
  ``ranking`` (extra) says which basis was used (``"model"`` or ``"fallback"``).
* ``value_chains`` = chains where the ministry appears in a stage / item ministry list, owns an item's line,
  or is the lead ministry; ``stages`` lists the stages it is involved in.
* ``production`` = the real domestic production figures the entity can see: the chain-level rows
  (``global_production`` / ``india_production`` / ``india_output``) of every chain it leads or takes part in,
  plus the ``hsn8`` / ``hs6`` / ``hs4`` rows that cover its lines. One entry per (scope, key, label) through
  the shared chooser ``app.common.choose_production``, each with its real provenance. An empty list means
  "Not available - upload figures through the Data Hub".
* ``open_tickets`` = helpdesk tickets routed to the ministry and not resolved; ``pending_claims`` = pending
  residual-code claims by the ministry.
"""
from __future__ import annotations

import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from app.common import (choose_production, code_descriptions, parse_json, product_summaries, production_provenance,
                        provenance, search_products)
from app.db import get_db, has_rows, in_json, json_param, row, rows, scalar
from app.routers.meta import ministry_list

router = APIRouter(prefix="/api/ministries", tags=["ministries"])

EntityKind = Literal["ministry", "sector"]
SortParam = Literal["relevance", "exports", "imports", "rca", "code", "world_trade"]
OrderParam = Literal["asc", "desc"]
RoleParam = Literal["primary", "secondary", "any"]

TOP_N = 10
_ALLOC = ("SUM(COALESCE(m.exports_alloc, 0)) AS exports, "
          "SUM(COALESCE(m.imports_alloc, 0)) AS imports")


def _scope(kind: EntityKind, alias: str = "p") -> str:
    """SQL predicate selecting the entity's lines (one ``?`` parameter = the entity id)."""
    column = "ministry_id" if kind == "ministry" else "sector_id"
    return f"{alias}.{column} = ?"


def _one_line_per_hs6(kind: EntityKind) -> str:
    return f"p.hsn8 IN (SELECT MIN(p2.hsn8) FROM products p2 WHERE {_scope(kind, 'p2')} GROUP BY p2.hs6)"


def _kpis(conn: sqlite3.Connection, kind: EntityKind, entity_id: str) -> dict:
    scope = _scope(kind)
    base = row(conn, f"""
        SELECT COUNT(*) AS codes,
               COALESCE(SUM(p.mapping_status = 'accepted'), 0) AS accepted,
               COALESCE(SUM(p.mapping_source IN ('dpiit_guidebook', 'official_upload', 'manual')), 0) AS verified_codes,
               COUNT(DISTINCT p.sector_id) AS sectors_covered,
               COUNT(DISTINCT CASE WHEN p.ministry_id <> 'residual' THEN p.ministry_id END) AS ministries_covered,
               COUNT(DISTINCT p.hs6) AS hs6_codes,
               {_ALLOC}, SUM(COALESCE(m.world_alloc, 0)) AS world_trade
        FROM products p LEFT JOIN v_product_trade m ON m.hsn8 = p.hsn8
        WHERE {scope} AND p.is_current = 1""", (entity_id,))
    if kind == "ministry":
        secondary = scalar(conn, "SELECT COUNT(*) FROM product_ministries WHERE ministry_id = ? AND role = 'secondary'",
                           (entity_id,), 0)
        open_tickets = scalar(conn, "SELECT COUNT(*) FROM tickets WHERE routed_ministry_id = ? "
                                    "AND status <> 'resolved'", (entity_id,), 0)
        pending = scalar(conn, "SELECT COUNT(*) FROM residual_claims WHERE ministry_id = ? AND status = 'pending'",
                         (entity_id,), 0)
    else:
        secondary = scalar(conn, """SELECT COUNT(DISTINCT pm.hsn8) FROM product_ministries pm
                                    JOIN products p ON p.hsn8 = pm.hsn8
                                    WHERE pm.role = 'secondary' AND p.sector_id = ?""", (entity_id,), 0)
        open_tickets = scalar(conn, """SELECT COUNT(*) FROM tickets t JOIN products p ON p.hsn8 = t.hsn8
                                       WHERE p.sector_id = ? AND t.status <> 'resolved'""", (entity_id,), 0)
        pending = scalar(conn, """SELECT COUNT(*) FROM residual_claims c JOIN products p ON p.hsn8 = c.hsn8
                                  WHERE p.sector_id = ? AND c.status = 'pending'""", (entity_id,), 0)
    has_lines = bool(base["codes"])
    exports = base["exports"] if has_lines else None
    imports = base["imports"] if has_lines else None
    return {
        "codes": base["codes"], "accepted": base["accepted"], "verified_codes": base["verified_codes"],
        "secondary_codes": secondary,
        "exports": exports, "imports": imports,
        "trade_balance": (exports - imports) if has_lines else None,
        "world_trade": base["world_trade"] if has_lines else None,
        "sectors_covered": base["sectors_covered"], "ministries_covered": base["ministries_covered"],
        "hs6_codes": base["hs6_codes"], "chains_involved": 0,  # filled in by the caller
        "open_tickets": open_tickets, "pending_claims": pending,
    }


def _sector_mix(conn: sqlite3.Connection, ministry_id: str) -> list[dict]:
    return rows(conn, f"""
        SELECT p.sector_id, se.name, se.color, COUNT(*) AS codes, {_ALLOC}
        FROM products p JOIN sectors se ON se.id = p.sector_id LEFT JOIN v_product_trade m ON m.hsn8 = p.hsn8
        WHERE p.ministry_id = ? AND p.is_current = 1
        GROUP BY p.sector_id ORDER BY codes DESC, p.sector_id""", (ministry_id,))


def _ministry_mix(conn: sqlite3.Connection, sector_id: str) -> list[dict]:
    return rows(conn, f"""
        SELECT p.ministry_id, mi.short_name, mi.name, mi.color, COUNT(*) AS codes, {_ALLOC}
        FROM products p JOIN ministries mi ON mi.id = p.ministry_id LEFT JOIN v_product_trade m ON m.hsn8 = p.hsn8
        WHERE p.sector_id = ? AND p.is_current = 1
        GROUP BY p.ministry_id ORDER BY codes DESC, p.ministry_id""", (sector_id,))


def _chapter_mix(conn: sqlite3.Connection, kind: EntityKind, entity_id: str) -> list[dict]:
    return rows(conn, f"""
        SELECT p.hs2, COALESCE(n.description, 'Chapter ' || p.hs2) AS description, COUNT(*) AS codes, {_ALLOC}
        FROM products p LEFT JOIN hs_nodes n ON n.code = p.hs2 LEFT JOIN v_product_trade m ON m.hsn8 = p.hsn8
        WHERE {_scope(kind)} AND p.is_current = 1
        GROUP BY p.hs2 ORDER BY codes DESC, p.hs2""", (entity_id,))


def _ranked(conn: sqlite3.Connection, kind: EntityKind, entity_id: str, where: str, order: str,
            extra_select: str = "", params: tuple = ()) -> list[dict]:
    return product_summaries(conn, f"{_scope(kind)} AND {_one_line_per_hs6(kind)} AND {where}",
                             (entity_id, entity_id, *params), order, limit=TOP_N, extra_select=extra_select)


def _hotspots(conn: sqlite3.Connection, kind: EntityKind, entity_id: str, scored: bool) -> list[dict]:
    extra = ("sc.vulnerability_score, m.top_import_source, c.name AS top_import_source_name, "
             "m.top_import_source_share, m.china_import_share, "
             "m.india_imports / (m.india_imports + COALESCE(m.india_exports, 0)) AS dependency_ratio")
    if scored:
        order = "sc.vulnerability_score DESC NULLS LAST, m.india_imports DESC, p.hsn8"
        where = "m.india_imports > 0 AND sc.vulnerability_score IS NOT NULL"
    else:
        order = ("m.india_imports * (m.india_imports / (m.india_imports + COALESCE(m.india_exports, 0))) "
                 "* COALESCE(m.top_import_source_share, 0) DESC, p.hsn8")
        where = "m.india_imports > COALESCE(m.india_exports, 0)"
    items = product_summaries(
        conn, f"{_scope(kind)} AND {_one_line_per_hs6(kind)} AND {where}", (entity_id, entity_id), order,
        limit=TOP_N, extra_select=extra, join_sql="LEFT JOIN countries c ON c.id = m.top_import_source")
    return items


def _opportunities(conn: sqlite3.Connection, kind: EntityKind, entity_id: str, scored: bool) -> list[dict]:
    extra = "sc.export_potential_score, sc.untapped_potential_usd, sc.archetype, m.india_world_share, m.world_cagr"
    if scored:
        where, order = "sc.export_potential_score IS NOT NULL", "sc.export_potential_score DESC, p.hsn8"
    else:
        where = "m.rca >= 1 AND m.world_trade > 0"
        order = "m.world_trade * MIN(m.rca, 3) DESC, p.hsn8"
    return _ranked(conn, kind, entity_id, where, order, extra)


def _value_chains(conn: sqlite3.Connection, kind: EntityKind, entity_id: str) -> list[dict]:
    """Chains (with the stage names) the ministry / sector takes part in."""
    if kind == "ministry":
        stage_keys = rows(conn, """
            SELECT s.chain_id, s.stage_id FROM vc_stages s
            WHERE EXISTS (SELECT 1 FROM json_each(COALESCE(s.ministry_ids_json, '[]')) j WHERE j.value = ?)
            UNION
            SELECT i.chain_id, i.stage_id FROM vc_items i
            WHERE EXISTS (SELECT 1 FROM json_each(COALESCE(i.ministry_ids_json, '[]')) j WHERE j.value = ?)
               OR i.hsn8 IN (SELECT hsn8 FROM products WHERE ministry_id = ?)""", (entity_id,) * 3)
        lead = {r["id"] for r in rows(conn, "SELECT id FROM value_chains WHERE lead_ministry_id = ?", (entity_id,))}
    else:
        stage_keys = rows(conn, """
            SELECT i.chain_id, i.stage_id FROM vc_items i JOIN products p ON p.hsn8 = i.hsn8 WHERE p.sector_id = ?
            UNION
            SELECT i.chain_id, i.stage_id FROM vc_items i JOIN products p ON p.hs6 = i.hs_code
            WHERE length(i.hs_code) = 6 AND p.sector_id = ?
            UNION
            SELECT i.chain_id, i.stage_id FROM vc_items i JOIN products p ON p.hs4 = i.hs_code
            WHERE length(i.hs_code) = 4 AND p.sector_id = ?""", (entity_id,) * 3)
        lead = set()
    wanted: dict[str, set[str]] = {}
    for k in stage_keys:
        wanted.setdefault(k["chain_id"], set()).add(k["stage_id"])
    for chain_id in lead:
        wanted.setdefault(chain_id, set())
    if not wanted:
        return []
    chains = rows(conn, "SELECT id, name, lead_ministry_id, sort_order FROM value_chains ORDER BY sort_order, id")
    stages = rows(conn, "SELECT chain_id, stage_id, name FROM vc_stages ORDER BY chain_id, stage_order")
    out = []
    for c in chains:
        if c["id"] not in wanted:
            continue
        names = [s["name"] for s in stages if s["chain_id"] == c["id"] and s["stage_id"] in wanted[c["id"]]]
        out.append({"chain_id": c["id"], "name": c["name"], "stages": names,
                    "is_lead": kind == "ministry" and c["lead_ministry_id"] == entity_id})
    return out


_PRODUCTION_LABELS = {"global_production": "Global production", "india_production": "India's production"}


def _production(conn: sqlite3.Connection, kind: EntityKind, entity_id: str, chains: list[dict]) -> list[dict]:
    """Domestic production figures visible to the entity (see module docstring)."""
    chain_ids = [c["chain_id"] for c in chains]
    data: list[dict] = []
    if chain_ids:
        data += rows(conn, f"""SELECT pr.id, pr.scope, pr.key, pr.label, pr.year, pr.value, pr.unit, pr.source,
                                      pr.status, vc.title AS chain_title, vc.name AS chain_name
                               FROM production pr JOIN value_chains vc ON vc.id = pr.key
                               WHERE pr.scope = 'chain' AND {in_json('pr.key')} ORDER BY pr.id""",
                     (json_param(chain_ids),))
    data += rows(conn, f"""SELECT pr.id, pr.scope, pr.key, pr.label, pr.year, pr.value, pr.unit, pr.source, pr.status,
                                  NULL AS chain_title, NULL AS chain_name
                           FROM production pr
                           WHERE pr.scope IN ('hsn8', 'hs6', 'hs4') AND EXISTS (
                               SELECT 1 FROM products p WHERE {_scope(kind)} AND (
                                   (pr.scope = 'hsn8' AND p.hsn8 = pr.key) OR (pr.scope = 'hs6' AND p.hs6 = pr.key)
                                   OR (pr.scope = 'hs4' AND p.hs4 = pr.key)))
                           ORDER BY pr.id""", (entity_id,))
    groups: dict[tuple, list[dict]] = {}
    for r in data:
        groups.setdefault((r["scope"], r["key"], r["label"] or ""), []).append(r)
    codes = [k[1] for k in groups if k[0] != "chain"]
    descriptions = code_descriptions(conn, codes) if codes else {}
    out: list[dict] = []
    for (scope, key, label), members in groups.items():
        chosen = choose_production(members)
        if chosen is None:
            continue
        if scope == "chain":
            title = chosen.get("chain_title") or chosen.get("chain_name") or key
            display = f"{_PRODUCTION_LABELS.get(label, label or 'Production')} - {title}"
        else:
            display = f"{descriptions.get(key) or 'HS ' + key} ({scope.upper()} {key})"
        out.append({"scope": scope, "key": key, "label": label or None, "display_label": display,
                    "year": chosen.get("year"), "value": chosen.get("value"), "unit": chosen.get("unit"),
                    "source": chosen.get("source"), "status": chosen.get("status"),
                    "provenance": production_provenance(chosen),
                    "chain_id": key if scope == "chain" else None, "n_rows": len(members)})
    order = {"verified": 0, "not_verified": 1}
    out.sort(key=lambda p: (order.get(p["status"], 2), p["scope"] != "chain", p["display_label"]))
    return out


def _production_summary_provenance(items: list[dict]) -> dict:
    """One badge for the 'Domestic production' card: not available, sourced figures, or uploads."""
    if not items:
        return provenance(None, label="Not available - upload figures through the Data Hub")
    verified = [p for p in items if p.get("status") == "verified"]
    if verified:
        return provenance(verified[0].get("source") or "manual", "verified",
                          "Sourced production figures (UNIDO INDSTAT, Rubber Board, ATMA or official uploads)")
    return provenance(items[0].get("source") or "manual", "not_verified",
                      "Production figures awaiting verification")


def _schemes(conn: sqlite3.Connection, kind: EntityKind, entity_id: str) -> list[dict]:
    if kind == "ministry":
        return rows(conn, "SELECT id, name, kind FROM schemes WHERE ministry_id = ? ORDER BY kind, name",
                    (entity_id,))
    # A sector's schemes: any scheme whose HS prefixes cover at least one of the sector's lines.
    prefixes = rows(conn, "SELECT DISTINCT scheme_id, hs_prefix FROM scheme_products")
    hit: set[str] = set()
    for pr in prefixes:
        if pr["scheme_id"] in hit:
            continue
        if row(conn, "SELECT 1 AS x FROM products WHERE hsn8 GLOB ? AND sector_id = ? LIMIT 1",
               (pr["hs_prefix"] + "*", entity_id)):
            hit.add(pr["scheme_id"])
    if not hit:
        return []
    return [s for s in rows(conn, "SELECT id, name, kind FROM schemes ORDER BY kind, name") if s["id"] in hit]


def _trend(conn: sqlite3.Connection, kind: EntityKind, entity_id: str) -> list[dict]:
    return rows(conn, f"""
        SELECT t.year, SUM(COALESCE(t.india_exports, 0) * m.weight) AS exports,
               SUM(COALESCE(t.india_imports, 0) * m.weight) AS imports,
               SUM(COALESCE(t.world_trade, 0) * m.weight) AS world_trade
        FROM products p JOIN v_product_trade m ON m.hsn8 = p.hsn8
        JOIN trade_hs6 t ON t.hs6 = m.metric_hs6
        WHERE {_scope(kind)} AND p.is_current = 1
        GROUP BY t.year ORDER BY t.year""", (entity_id,))


def build_entity_dashboard(conn: sqlite3.Connection, kind: EntityKind, entity_id: str) -> dict | None:
    """The SPEC 6.4 dashboard of a ministry or a sector; None when the id is unknown."""
    if kind == "ministry":
        entity = row(conn, "SELECT id, short_name, name, color, parent_ministry, kind, website FROM ministries "
                           "WHERE id = ?", (entity_id,))
    else:
        entity = row(conn, "SELECT id, name, description, color, icon, chapters FROM sectors WHERE id = ?",
                     (entity_id,))
        if entity:
            entity["chapters"] = parse_json(entity["chapters"], [])
    if not entity:
        return None
    scored = has_rows(conn, "hs6_scores") and bool(scalar(conn, f"""
        SELECT COUNT(*) FROM products p JOIN v_product_trade m ON m.hsn8 = p.hsn8
        JOIN hs6_scores sc ON sc.hs6 = m.metric_hs6 WHERE {_scope(kind)}""",
                                                          (entity_id,), 0))
    kpis = _kpis(conn, kind, entity_id)
    chains = _value_chains(conn, kind, entity_id)
    kpis["chains_involved"] = len(chains)
    dashboard_production = _production(conn, kind, entity_id, chains)
    kpis["production_figures"] = len(dashboard_production)
    dashboard = {
        kind: entity,
        "kpis": kpis,
        ("sector_mix" if kind == "ministry" else "ministry_mix"):
            _sector_mix(conn, entity_id) if kind == "ministry" else _ministry_mix(conn, entity_id),
        "chapter_mix": _chapter_mix(conn, kind, entity_id),
        "top_exports": _ranked(conn, kind, entity_id, "m.india_exports > 0", "m.india_exports DESC, p.hsn8"),
        "top_imports": _ranked(conn, kind, entity_id, "m.india_imports > 0", "m.india_imports DESC, p.hsn8"),
        "dependency_hotspots": _hotspots(conn, kind, entity_id, scored),
        "opportunities": _opportunities(conn, kind, entity_id, scored),
        "value_chains": chains,
        "production": dashboard_production,
        "schemes": _schemes(conn, kind, entity_id),
        "trend": _trend(conn, kind, entity_id),
        "ranking": "model" if scored else "fallback",
        "provenance": {"trade": provenance("tradestat", year=scalar(conn, "SELECT MAX(year) FROM hs6_metrics")),
                       "scores": provenance("model", "not_verified", "Model estimate · Atlas analytical model (derived from official DGFT/DGCIS & UN trade data)")
                       if scored else provenance(None, label="Scores not available - transparent fallback ranking"),
                       "production": _production_summary_provenance(dashboard_production)},
    }
    return dashboard


def entity_products(conn: sqlite3.Connection, kind: EntityKind, entity_id: str, **search) -> dict:
    """Paginated ``ProductSummary`` of a ministry's / sector's lines (``app.common.search_products`` facets)."""
    if kind == "ministry":
        search["ministry_id"] = entity_id
    else:
        search["sector_id"] = entity_id
    try:
        return search_products(conn, **search)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("", summary="All ministries / departments (same as /api/meta/ministries)")
def list_ministries(conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    return ministry_list(conn)


@router.get("/{ministry_id}", summary="Ministry dashboard")
def ministry_dashboard(ministry_id: str, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    data = build_entity_dashboard(conn, "ministry", ministry_id)
    if data is None:
        raise HTTPException(status_code=404, detail=f"Unknown ministry '{ministry_id}'")
    return data


@router.get("/{ministry_id}/products", summary="Ministry-wise HS code table (paginated)")
def ministry_products(
    ministry_id: str,
    q: str | None = Query(None, max_length=200),
    role: RoleParam = Query("primary", description="Ownership role of the ministry"),
    sector_id: str | None = None,
    chapter: str | None = None,
    mapping_source: Literal["dpiit_guidebook", "official_upload", "manual", "rule", "unmapped"] | None = None,
    sort: SortParam = "relevance",
    order: OrderParam | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    if not row(conn, "SELECT 1 AS x FROM ministries WHERE id = ?", (ministry_id,)):
        raise HTTPException(status_code=404, detail=f"Unknown ministry '{ministry_id}'")
    return entity_products(conn, "ministry", ministry_id, q=q, ministry_role=role, sector_id=sector_id,
                           chapter=chapter, mapping_source=mapping_source, sort=sort, order=order, page=page,
                           page_size=page_size)
