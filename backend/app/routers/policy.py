"""Policy Workbench API (docs/SPEC.md section 6.7): import substitution, PLI targeting, trade negotiations,
skilling and quality control. Owner: C2.

Access (SPEC section 5): use cases, schemes, agreements and skilling are public; ``/negotiation`` and
``/simulate-tariff`` need a government role (analyst / ministry / admin; anonymous 401, industry 403).

Endpoints
---------
* ``GET  /api/policy/use-cases``           the five policy use cases with live headline metrics and the UI route
* ``GET  /api/policy/schemes?kind=PLI|QCO`` schemes with their product coverage and trade
* ``GET  /api/policy/schemes/{id}``         one scheme: KPIs, covered products (<= 200), top import dependencies
* ``GET  /api/policy/agreements``           India's FTAs / CEPAs with bilateral trade with the partners
* ``GET  /api/policy/negotiation``          offensive / defensive interests vs a partner or an agreement (GOV)
* ``POST /api/policy/simulate-tariff``      BCD scenario simulator (``app.services.simulator``) (GOV)
* ``GET  /api/policy/skilling``             Sector Skill Councils by chain / sector

Decisions
---------
* **Scheme coverage.** A scheme covers every 8-digit line under its HS prefixes. ``n_products`` counts the
  current lines; trade sums distinct HS6 codes: a 2/4/6-digit prefix brings the whole HS6, an 8-digit prefix
  only its line's share (HS6 value / ``lines_in_hs6``, SPEC aggregation rule), capped at the full HS6.
  ``avg_rca`` is the simple mean of the covered HS6 codes' RCA; ``aggregate_rca`` the Balassa RCA of the sum.
* **Bilateral trade** with a partner group = India's latest-year exports to / imports from those countries,
  summed over every HS6 (``india_partners``).
* **Negotiation** (SPEC 6.7). Offensive: India RCA >= 1 and the partners' imports from the world >= US$ 5 mn;
  ``gap_usd = max(0, india_world_share * partner_imports_world - india_exports_to_partner)``; top 50 by gap.
  Defensive: India's imports from the partners >= US$ 5 mn, the partners' RCA >= 1 and (India RCA >= 0.5 or the
  product is covered by a PLI scheme); top 50 by imports. A partner group's RCA is its combined Balassa RCA
  ``(sum exports_p / sum exports) / (W_p / W)`` from ``world_suppliers``. ``summary`` counts every qualifying
  product (not only the top 50). ``india_mfn`` is India's MFN applied tariff (WITS, simple average).
* Heavy aggregates are cached per data fingerprint (``app.services.scoring.cached``).
"""
from __future__ import annotations

import sqlite3
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.common import latest_year, parse_json, product_summaries, provenance
from app.db import get_db, json_param, row, rows, scalar
from app.security import require_gov
from app.services import simulator
from app.services.scoring import analytics_frame, cached, rca, usd_text

router = APIRouter(prefix="/api/policy", tags=["policy"])

SCHEME_KINDS = ("PLI", "QCO")
MAX_SCHEME_PRODUCTS = 200
TOP_DEPENDENCIES = 10
NEGOTIATION_MIN_USD = 5e6
NEGOTIATION_TOP = 50
OFFENSIVE_MIN_RCA = 1.0
DEFENSIVE_MIN_PARTNER_RCA = 1.0
DEFENSIVE_MIN_INDIA_RCA = 0.5
BILATERAL_TOP = 10


# =========================================================================== scheme coverage (cached)

def _build_scheme_coverage(conn: sqlite3.Connection) -> dict[str, dict]:
    """``{scheme_id: {prefixes, hsn8: [..], weights: {hs6: w}}}`` (see module docstring)."""
    frame = analytics_frame(conn)
    # One pass over the view: joining it per prefix re-evaluates it each time (seconds over ~100 prefixes).
    line_weight = {r["hsn8"]: r["weight"] for r in rows(conn, "SELECT hsn8, weight FROM v_product_trade")}
    out: dict[str, dict] = {}
    for sp in rows(conn, "SELECT scheme_id, hs_prefix, note FROM scheme_products ORDER BY scheme_id, hs_prefix"):
        entry = out.setdefault(sp["scheme_id"], {"prefixes": [], "lines": {}, "weights": defaultdict(float),
                                                 "full": set()})
        prefix = "".join(ch for ch in sp["hs_prefix"] or "" if ch.isdigit())
        if not prefix:
            continue
        entry["prefixes"].append({"prefix": prefix, "note": sp["note"]})
        for p in rows(conn, "SELECT hsn8, hs6, lines_in_hs6, is_current FROM products WHERE hsn8 GLOB ?",
                      (prefix + "*",)):
            entry["lines"][p["hsn8"]] = {**p, "weight": line_weight.get(p["hsn8"])}
        if len(prefix) >= 8:
            line = entry["lines"].get(prefix[:8])
            if line:
                weight = float(line.get("weight") or (1.0 / max(1, int(line["lines_in_hs6"] or 1))))
                for h in frame.resolve(prefix[:8])[0]:
                    entry["weights"][h] += weight
        else:
            hs6s = frame.resolve(prefix)[0] if len(prefix) == 6 else frame.under(prefix)
            entry["full"].update(hs6s)
    result = {}
    for sid, e in out.items():
        weights = {h: min(1.0, w) for h, w in e["weights"].items()}
        weights.update({h: 1.0 for h in e["full"]})
        result[sid] = {"prefixes": e["prefixes"], "hsn8": sorted(e["lines"]),
                       "n_current": sum(1 for p in e["lines"].values() if p["is_current"]),
                       "weights": weights}
    return result


def scheme_coverage(conn: sqlite3.Connection) -> dict[str, dict]:
    return cached(conn, "scheme_coverage", _build_scheme_coverage)


def _coverage_trade(frame, weights: dict[str, float]) -> dict:
    x = m = w = 0.0
    rcas = []
    for h, wt in weights.items():
        r = frame.by_hs6.get(h)
        if r is None:
            continue
        x += (r.get("india_exports") or 0.0) * wt
        m += (r.get("india_imports") or 0.0) * wt
        w += (r.get("world_trade") or 0.0) * wt
        if r.get("rca") is not None:
            rcas.append(r["rca"])
    has = bool(weights) and any(h in frame.by_hs6 for h in weights)
    return {"exports": x if has else None, "imports": m if has else None, "world_trade": w if has else None,
            "avg_rca": (sum(rcas) / len(rcas)) if rcas else None,
            "aggregate_rca": rca(x, frame.totals["X"], w, frame.totals["W"]) if has else None,
            "n_hs6": len(weights)}


def _ministries(conn: sqlite3.Connection) -> dict[str, dict]:
    return {r["id"]: r for r in rows(conn, "SELECT id, short_name, name, color FROM ministries")}


def _scheme_item(s: dict, cov: dict | None, trade: dict, ministries: dict[str, dict]) -> dict:
    cov = cov or {"prefixes": [], "n_current": 0}
    return {"id": s["id"], "name": s["name"], "kind": s["kind"], "ministry": ministries.get(s.get("ministry_id") or ""),
            "outlay_crore": s.get("outlay_crore"), "launched": s.get("launched"), "description": s.get("description"),
            "url": s.get("url"), "n_products": cov["n_current"], "exports": trade["exports"],
            "imports": trade["imports"], "source": s.get("source"), "n_hs6": trade["n_hs6"],
            "prefixes": cov["prefixes"]}


def _build_scheme_list(conn: sqlite3.Connection) -> list[dict]:
    frame = analytics_frame(conn)
    coverage = scheme_coverage(conn)
    ministries = _ministries(conn)
    out = []
    for s in rows(conn, "SELECT * FROM schemes ORDER BY kind, COALESCE(outlay_crore, 0) DESC, name"):
        cov = coverage.get(s["id"])
        out.append(_scheme_item(s, cov, _coverage_trade(frame, (cov or {}).get("weights", {})), ministries))
    return out


# =========================================================================== use cases

def _use_cases(conn: sqlite3.Connection) -> list[dict]:
    frame = analytics_frame(conn)
    schemes = cached(conn, "scheme_list", _build_scheme_list)
    pli = [s for s in schemes if s["kind"] == "PLI"]
    qco = [s for s in schemes if s["kind"] == "QCO"]
    subst = [r for r in frame.rows if r.get("substitution_score") is not None]
    subst_m = sum(r.get("india_imports") or 0.0 for r in subst)
    rca1 = [r for r in frame.rows if (r.get("rca") or 0) >= 1]
    growth = [r for r in frame.rows if r.get("archetype") in ("Champion", "Emerging")]
    china = [r for r in frame.rows if (r.get("china_import_share") or 0) >= 0.6 and (r.get("india_imports") or 0) > 0]
    china_m = sum((r.get("india_imports") or 0.0) * r["china_import_share"] for r in china)
    agreements = rows(conn, "SELECT status, COUNT(*) AS n FROM trade_agreements GROUP BY status")
    n_agree = sum(a["n"] for a in agreements)
    in_force = sum(a["n"] for a in agreements if a["status"] == "in_force")
    councils = rows(conn, "SELECT chain_ids_json FROM skill_councils")
    chain_ids = {r["id"] for r in rows(conn, "SELECT id FROM value_chains")}
    chains_covered = {c for r in councils for c in (parse_json(r["chain_ids_json"], []) or [])} & chain_ids
    coverage = scheme_coverage(conn)
    pli_lines = len({h for s in pli for h in coverage.get(s["id"], {}).get("hsn8", [])})
    qco_lines = len({h for s in qco for h in coverage.get(s["id"], {}).get("hsn8", [])})
    year = latest_year(conn)
    return [
        {"id": "import_substitution", "title": "Import substitution",
         "description": ("Find products India imports far more than it exports, where world supply is diversified "
                         "and India already has some capability - candidates for domestic manufacturing."),
         "question": "Which imports could India realistically replace with domestic production?",
         "route": "/analytics?tab=substitution",
         "metrics": [f"{len(subst):,} net-import products (imports >= US$ 10 mn) scored",
                     f"{usd_text(subst_m)} of {year} imports in these products",
                     f"{sum(1 for r in subst if (r.get('china_import_share') or 0) >= 0.5):,} of them sourced "
                     f"mostly from China"]},
        {"id": "pli_targeting", "title": "PLI scheme targeting",
         "description": ("Map each Production Linked Incentive scheme to its HS lines and track the covered "
                         "products' exports, imports and competitiveness; spot high-potential products no scheme "
                         "covers yet."),
         "question": "Are PLI incentives aimed at the products with the most export potential and import risk?",
         "route": "/policy?tab=pli",
         "metrics": [f"{len(pli)} PLI schemes covering {pli_lines:,} HS lines",
                     f"PLI-covered imports {usd_text(sum(s['imports'] or 0 for s in pli))}, exports "
                     f"{usd_text(sum(s['exports'] or 0 for s in pli))} ({year})",
                     f"{len(growth):,} Champion / Emerging products (model estimate)"]},
        {"id": "trade_negotiations", "title": "Trade negotiations",
         "description": ("Product-level offensive interests (where India is competitive and the partner imports a "
                         "lot) and defensive interests (where a competitive partner could hurt Indian producers) "
                         "for every FTA / CEPA partner."),
         "question": "What should India ask for, and protect, in an FTA / CEPA negotiation?",
         "route": "/policy?tab=negotiation",
         "metrics": [f"{n_agree} agreements ({in_force} in force)",
                     f"{len(rca1):,} HS6 products with RCA >= 1",
                     "Offensive / defensive lists computed live from CEPII BACI partner trade"]},
        {"id": "skilling", "title": "Skilling programmes",
         "description": ("Link value chains and sectors to their Sector Skill Councils so skilling plans follow "
                         "the manufacturing priorities and clusters."),
         "question": "Which skill councils serve the priority value chains and clusters?",
         "route": "/policy?tab=skilling",
         "metrics": [f"{len(councils)} Sector Skill Councils",
                     f"{len(chains_covered)} of {len(chain_ids)} value chains linked to a council"]},
        {"id": "quality_control", "title": "Quality control interventions",
         "description": ("Track Quality Control Orders by HS line and find import-dependent, concentrated products "
                         "where a standard could curb low-quality imports."),
         "question": "Where would a Quality Control Order protect consumers and domestic producers most?",
         "route": "/policy?tab=qco",
         "metrics": [f"{len(qco)} QCOs covering {qco_lines:,} HS lines",
                     f"{len(china):,} products with >= 60% of imports from China "
                     f"({usd_text(china_m)} of imports from China)"]},
    ]


@router.get("/use-cases", summary="The five policy use cases with live headline metrics")
def use_cases(conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    return cached(conn, "use_cases", _use_cases)


# =========================================================================== schemes

@router.get("/schemes", summary="PLI schemes and Quality Control Orders with product coverage")
def schemes(kind: str | None = Query(None, description="PLI or QCO"),
            conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    items = cached(conn, "scheme_list", _build_scheme_list)
    if kind:
        k = kind.strip().upper()
        if k not in SCHEME_KINDS:
            raise HTTPException(status_code=400, detail="kind must be PLI or QCO")
        items = [s for s in items if s["kind"] == k]
    return items


def _prefix_where(prefixes: list[dict]) -> tuple[str, list]:
    codes = [p["prefix"] for p in prefixes]
    return "(" + " OR ".join("p.hsn8 GLOB ?" for _ in codes) + ")", [c[:8] + "*" for c in codes]


@router.get("/schemes/{scheme_id}", summary="One scheme: KPIs, covered products and import dependencies")
def scheme_detail(scheme_id: str, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    s = row(conn, "SELECT * FROM schemes WHERE id = ?", (scheme_id,))
    if s is None:
        raise HTTPException(status_code=404, detail=f"Unknown scheme '{scheme_id}'")
    frame = analytics_frame(conn)
    cov = scheme_coverage(conn).get(scheme_id)
    trade = _coverage_trade(frame, (cov or {}).get("weights", {}))
    item = _scheme_item(s, cov, trade, _ministries(conn))
    products: list[dict] = []
    deps: list[dict] = []
    if cov and cov["prefixes"]:
        where, params = _prefix_where(cov["prefixes"])
        products = product_summaries(conn, where, params, "m.india_exports DESC NULLS LAST, p.hsn8",
                                     limit=MAX_SCHEME_PRODUCTS)
        extra = ("sc.vulnerability_score, m.top_import_source, c.name AS top_import_source_name, "
                 "m.top_import_source_share, m.china_import_share, "
                 "m.india_imports / (m.india_imports + COALESCE(m.india_exports, 0)) AS dependency_ratio")
        candidates = product_summaries(
            conn, f"{where} AND m.india_imports > 0 AND sc.vulnerability_score IS NOT NULL", params,
            "sc.vulnerability_score DESC, m.india_imports DESC, p.hsn8", limit=None, extra_select=extra,
            join_sql="LEFT JOIN countries c ON c.id = m.top_import_source")
        seen: set[str] = set()
        for c in candidates:
            if c["hs6"] in seen:
                continue
            seen.add(c["hs6"])
            deps.append(c)
            if len(deps) >= TOP_DEPENDENCIES:
                break
    x, m = trade["exports"], trade["imports"]
    year = latest_year(conn)
    return {"scheme": item,
            "kpis": {"n_products": item["n_products"], "exports": x, "imports": m,
                     "trade_balance": (x - m) if x is not None and m is not None else None,
                     "avg_rca": trade["avg_rca"], "aggregate_rca": trade["aggregate_rca"], "n_hs6": trade["n_hs6"],
                     "world_trade": trade["world_trade"]},
            "products": products, "top_dependencies": deps,
            "provenance": {"scheme": provenance("manual", "verified",
                                                s.get("source") or "Curated from public Government sources"),
                           "trade": provenance("tradestat", year=year),
                           "scores": provenance("model", "not_verified", "Model estimate · Atlas analytical model (derived from official DGFT/DGCIS & UN trade data)")}}


# =========================================================================== agreements

def _build_bilateral(conn: sqlite3.Connection) -> dict[str, dict[str, float]]:
    """``{country_id: {"X": exports to, "M": imports from}}`` over every HS6 (latest year)."""
    out: dict[str, dict[str, float]] = defaultdict(lambda: {"X": 0.0, "M": 0.0})
    for r in rows(conn, "SELECT country_id, flow, SUM(value) AS v FROM india_partners GROUP BY country_id, flow"):
        out[r["country_id"]][r["flow"]] = r["v"] or 0.0
    return dict(out)


def bilateral_totals(conn: sqlite3.Connection) -> dict[str, dict[str, float]]:
    return cached(conn, "bilateral_totals", _build_bilateral)


def _country_refs(conn: sqlite3.Connection, ids: list[str]) -> list[dict]:
    if not ids:
        return []
    found = {r["id"]: r["name"] for r in rows(conn, "SELECT id, name FROM countries WHERE id IN "
                                                    "(SELECT value FROM json_each(?))", (json_param(ids),))}
    return [{"id": i, "name": found.get(i, i)} for i in ids]


@router.get("/agreements", summary="India's FTAs / CEPAs with bilateral trade")
def agreements(conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    totals = bilateral_totals(conn)
    out = []
    order = {"in_force": 0, "signed": 1, "negotiating": 2}
    for a in rows(conn, "SELECT * FROM trade_agreements"):
        ids = [i for i in (parse_json(a["partners_json"], []) or []) if i]
        out.append({"id": a["id"], "name": a["name"], "short_name": a.get("short_name"),
                    "partners": _country_refs(conn, ids), "status": a["status"], "year": a.get("year"),
                    "url": a.get("url"), "notes": a.get("notes"),
                    "india_exports_to": sum(totals.get(i, {}).get("X", 0.0) for i in ids) if ids else None,
                    "india_imports_from": sum(totals.get(i, {}).get("M", 0.0) for i in ids) if ids else None})
    out.sort(key=lambda a: (order.get(a["status"], 9), -(a["india_exports_to"] or 0), a["id"]))
    return out


# =========================================================================== negotiation (GOV)

def _sum_by_hs6(conn: sqlite3.Connection, sql: str, params: tuple) -> dict[str, float]:
    return {r["hs6"]: r["v"] or 0.0 for r in rows(conn, sql, params)}


def _pli_hs6(conn: sqlite3.Connection) -> dict[str, list[str]]:
    """``{hs6: [PLI scheme names]}`` of HS6 codes touched by a PLI scheme."""
    out: dict[str, list[str]] = defaultdict(list)
    names = {s["id"]: s["name"] for s in rows(conn, "SELECT id, name FROM schemes WHERE kind = 'PLI'")}
    for sid, cov in scheme_coverage(conn).items():
        if sid in names:
            for h in cov["weights"]:
                out[h].append(names[sid])
    return dict(out)


def _negotiation(conn: sqlite3.Connection, partner_ids: tuple[str, ...]) -> dict:
    """Offensive / defensive lists for a partner group.

    Performance: the partners' world imports are only read for the offensive candidates (India RCA >= 1) and
    their exports only for the defensive candidates (India imports from them >= US$ 5 mn), with the partners'
    total exports as one covering-index sum - a 27-country EU query stays well inside the 1.5 s budget even
    on a cold cache.
    """
    frame = analytics_frame(conn)
    pj = json_param(list(partner_ids))
    x_to = _sum_by_hs6(conn, """SELECT hs6, SUM(value) AS v FROM india_partners
                               WHERE flow = 'X' AND country_id IN (SELECT value FROM json_each(?)) GROUP BY hs6""",
                       (pj,))
    m_from = _sum_by_hs6(conn, """SELECT hs6, SUM(value) AS v FROM india_partners
                                 WHERE flow = 'M' AND country_id IN (SELECT value FROM json_each(?)) GROUP BY hs6""",
                         (pj,))
    offensive_pool = [r["hs6"] for r in frame.rows if (r.get("rca") or 0) >= OFFENSIVE_MIN_RCA]
    defensive_pool = sorted(h for h, v in m_from.items() if v >= NEGOTIATION_MIN_USD and h in frame.by_hs6)
    p_imp = _sum_by_hs6(conn, """SELECT hs6, SUM(value) AS v FROM world_markets
                                WHERE country_id IN (SELECT value FROM json_each(?))
                                  AND hs6 IN (SELECT value FROM json_each(?)) GROUP BY hs6""",
                        (pj, json_param(offensive_pool))) if offensive_pool else {}
    p_exp = _sum_by_hs6(conn, """SELECT hs6, SUM(value) AS v FROM world_suppliers
                                WHERE country_id IN (SELECT value FROM json_each(?))
                                  AND hs6 IN (SELECT value FROM json_each(?)) GROUP BY hs6""",
                        (pj, json_param(defensive_pool))) if defensive_pool else {}
    p_total = float(scalar(conn, "SELECT SUM(value) FROM world_suppliers WHERE country_id IN "
                                 "(SELECT value FROM json_each(?))", (pj,), 0.0) or 0.0)
    W = frame.totals["W"]
    pli = _pli_hs6(conn)

    def desc(h: str) -> str:
        r = frame.by_hs6.get(h)
        return r["description"] if r else f"HS {h}"

    def partner_rca(h: str) -> float | None:
        r = frame.by_hs6.get(h)
        return rca(p_exp.get(h, 0.0), p_total, r.get("world_trade") if r else None, W) if p_total else None

    offensive = []
    for h, imp in p_imp.items():
        r = frame.by_hs6.get(h)
        if r is None or imp < NEGOTIATION_MIN_USD or (r.get("rca") or 0) < OFFENSIVE_MIN_RCA:
            continue
        share = r.get("india_world_share") or 0.0
        sent = x_to.get(h, 0.0)
        offensive.append({"hs6": h, "description": r["description"], "partner_imports_world": imp,
                          "india_exports_to_partner": sent, "india_rca": r.get("rca"),
                          "india_world_share": r.get("india_world_share"),
                          "india_share_of_partner_imports": sent / imp if imp else None,
                          "gap_usd": max(0.0, share * imp - sent), "india_mfn": r.get("mfn_tariff"),
                          "hsn8_sample": r.get("hsn8_sample"), "ministry_short": r.get("ministry_short")})
    offensive.sort(key=lambda o: (-o["gap_usd"], o["hs6"]))

    defensive = []
    for h, imp in m_from.items():
        r = frame.by_hs6.get(h)
        if r is None or imp < NEGOTIATION_MIN_USD:
            continue
        p_rca = partner_rca(h)
        if p_rca is None or p_rca < DEFENSIVE_MIN_PARTNER_RCA:
            continue
        i_rca = r.get("rca")
        schemes_ = pli.get(h, [])
        base = i_rca is not None and i_rca >= DEFENSIVE_MIN_INDIA_RCA
        if not (base or schemes_):
            continue
        parts = [f"Partner is competitive (RCA {p_rca:.1f})"]
        if base:
            parts.append(f"India has a production base (RCA {i_rca:.2f})")
        if schemes_:
            parts.append("covered by " + ", ".join(sorted(set(schemes_))[:2]))
        total_m = r.get("india_imports") or 0.0
        defensive.append({"hs6": h, "description": r["description"], "india_imports_from_partner": imp,
                          "partner_share_of_india_imports": imp / total_m if total_m else None,
                          "partner_rca": p_rca, "india_rca": i_rca, "india_mfn": r.get("mfn_tariff"),
                          "pli_schemes": sorted(set(schemes_)), "reason": "; ".join(parts),
                          "hsn8_sample": r.get("hsn8_sample"), "ministry_short": r.get("ministry_short")})
    defensive.sort(key=lambda d: (-d["india_imports_from_partner"], d["hs6"]))

    def top(values: dict[str, float]) -> list[dict]:
        best = sorted(((v, h) for h, v in values.items() if v > 0), key=lambda t: (-t[0], t[1]))[:BILATERAL_TOP]
        return [{"hs6": h, "description": desc(h), "value": v} for v, h in best]

    ex, im = sum(x_to.values()), sum(m_from.values())
    return {"bilateral": {"india_exports_to": ex, "india_imports_from": im, "balance": ex - im,
                          "top_exports": top(x_to), "top_imports": top(m_from)},
            "offensive": offensive[:NEGOTIATION_TOP], "defensive": defensive[:NEGOTIATION_TOP],
            "summary": {"n_offensive": len(offensive), "n_defensive": len(defensive),
                        "total_gap_usd": sum(o["gap_usd"] for o in offensive),
                        "defensive_imports_usd": sum(d["india_imports_from_partner"] for d in defensive),
                        "partner_total_exports": p_total or None}}


@router.get("/negotiation", summary="FTA / CEPA negotiation analyser (offensive and defensive interests)",
            dependencies=[Depends(require_gov)])
def negotiation(partner: str | None = Query(None, description="Partner country id (OEC id, e.g. 'eugbr')"),
                agreement: str | None = Query(None, description="Trade agreement id"),
                conn: sqlite3.Connection = Depends(get_db)) -> dict:
    if not partner and not agreement:
        raise HTTPException(status_code=400, detail="pass ?partner=<country_id> or ?agreement=<id>")
    agreement_info = None
    if agreement:
        a = row(conn, "SELECT * FROM trade_agreements WHERE id = ?", (agreement,))
        if a is None:
            raise HTTPException(status_code=404, detail=f"Unknown trade agreement '{agreement}'")
        ids = [i for i in (parse_json(a["partners_json"], []) or []) if i]
        agreement_info = {"id": a["id"], "name": a["name"], "short_name": a.get("short_name"),
                          "status": a["status"], "year": a.get("year")}
    else:
        ids = [p.strip() for p in str(partner).split(",") if p.strip()]
    ids = [i for i in dict.fromkeys(ids) if i != "asind"]
    if not ids:
        raise HTTPException(status_code=400, detail="no partner country other than India")
    partners = _country_refs(conn, ids)
    known = {r["id"] for r in rows(conn, "SELECT id FROM countries WHERE id IN (SELECT value FROM json_each(?))",
                                   (json_param(ids),))}
    unknown = [i for i in ids if i not in known]
    if unknown and not agreement:
        raise HTTPException(status_code=404, detail=f"Unknown country id(s): {', '.join(unknown)}")
    body = cached(conn, "negotiation", _negotiation, tuple(sorted(ids)))
    year = latest_year(conn)
    return {"partners": partners, "agreement": agreement_info, **body,
            "rules": {"offensive": (f"India RCA >= {OFFENSIVE_MIN_RCA:g} and partner imports from the world >= "
                                    f"US$ {NEGOTIATION_MIN_USD / 1e6:g} mn; gap = max(0, India's world share x partner "
                                    "imports - India's exports to the partner); top 50 by gap"),
                      "defensive": (f"India's imports from the partner >= US$ {NEGOTIATION_MIN_USD / 1e6:g} mn, "
                                    f"partner RCA >= {DEFENSIVE_MIN_PARTNER_RCA:g} and (India RCA >= "
                                    f"{DEFENSIVE_MIN_INDIA_RCA:g} or covered by a PLI scheme); top 50 by imports")},
            "provenance": {"trade": provenance("baci", label=(f"CEPII BACI {year} (via OEC), partner and world trade; "
                                                              f"India's RCA from DGFT/DGCIS TRADESTAT "
                                                              f"FY{year}-{str(year + 1)[-2:]} exports"), year=year),
                           "tariff": provenance("wits", year=2022),
                           "scores": provenance("model", "not_verified", "Model estimate · Atlas analytical model (derived from official DGFT/DGCIS & UN trade data)")}}


# =========================================================================== tariff simulator (GOV)

class SimulateTariffRequest(BaseModel):
    """Body of ``POST /api/policy/simulate-tariff`` (SPEC 6.7; rates in percent, shares as fractions)."""

    codes: list[str] = Field(..., min_length=1, max_length=simulator.MAX_CODES,
                             description="HS codes (8-digit lines, or 6/4/2-digit codes simulated HS6 by HS6)")
    new_tariff_pct: float = Field(..., ge=0, le=500, description="New BCD / tariff in percent")
    elasticity: float | None = Field(None, ge=0, le=20, description="Import price elasticity (default 2.5)")
    substitution_share: float | None = Field(None, ge=0, le=1, description="Share of the import change captured "
                                                                          "by domestic producers (default 0.5)")
    input_cost_share: float | None = Field(None, ge=0, le=1, description="Input's share in downstream product "
                                                                        "cost (default 0.10)")
    base_tariff_pct: float | None = Field(None, ge=0, le=500, description="Override the current tariff t0")
    downstream_depth: int | None = Field(None, ge=1, le=6, description="Hops of downstream propagation (default 3)")


@router.post("/simulate-tariff", summary="Tariff (BCD) scenario simulator with downstream cost propagation",
             dependencies=[Depends(require_gov)])
def simulate_tariff(body: SimulateTariffRequest, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    try:
        result = simulator.simulate(
            conn, body.codes, body.new_tariff_pct,
            elasticity=simulator.DEFAULT_ELASTICITY if body.elasticity is None else body.elasticity,
            substitution_share=(simulator.DEFAULT_SUBSTITUTION_SHARE if body.substitution_share is None
                                else body.substitution_share),
            input_cost_share=(simulator.DEFAULT_INPUT_COST_SHARE if body.input_cost_share is None
                              else body.input_cost_share),
            base_tariff_pct=body.base_tariff_pct,
            downstream_depth=body.downstream_depth or 3)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    year = latest_year(conn)
    result["provenance"] = {"imports": provenance("tradestat", label=(f"DGFT/DGCIS TRADESTAT FY{year}-{str(year + 1)[-2:]}"
                                                                      " (India's imports)"), year=year),
                            "tariff": provenance("wits", year=2022),
                            "outcomes": provenance("model", "not_verified",
                                                   "Model estimate · Atlas analytical model (derived from official DGFT/DGCIS & UN trade data)")}
    return result


# =========================================================================== skilling

@router.get("/skilling", summary="Sector Skill Councils for a value chain or sector")
def skilling(chain_id: str | None = Query(None), sector_id: str | None = Query(None),
             conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    if chain_id and row(conn, "SELECT 1 AS x FROM value_chains WHERE id = ?", (chain_id,)) is None:
        raise HTTPException(status_code=404, detail=f"Unknown value chain '{chain_id}'")
    if sector_id and row(conn, "SELECT 1 AS x FROM sectors WHERE id = ?", (sector_id,)) is None:
        raise HTTPException(status_code=404, detail=f"Unknown sector '{sector_id}'")
    out = []
    for c in rows(conn, "SELECT * FROM skill_councils ORDER BY name"):
        sectors = parse_json(c.get("sector_ids_json"), []) or []
        chains = parse_json(c.get("chain_ids_json"), []) or []
        if chain_id and chain_id not in chains:
            continue
        if sector_id and sector_id not in sectors:
            continue
        out.append({"id": c["id"], "name": c["name"], "url": c.get("url"), "sectors": sectors, "chains": chains})
    return out

