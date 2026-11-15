"""Product deep-dive: one HS heading from country -> sector -> heading -> 6-digit -> 8-digit (public).

Endpoints (``{hs4}`` may also be a basket id such as ``sports_equipment``: a study's own HS6 list spanning several
headings, from the ``baskets`` / ``basket_codes`` tables)
---------
* ``GET /api/deep-dive/baskets``                   the product baskets
* ``GET /api/deep-dive/{hs4}``                     heading overview: KPIs, every 6-digit subheading with its trade,
                                                     8-digit lines, tariffs, standards and clusters, plus the
                                                     heading's clusters, standards, value chains and land availability
* ``GET /api/deep-dive/{hs4}/readiness``           export readiness of every subheading in every destination market
  ``?market=us&extra_duty=50``                     (``extra_duty`` overrides the market's additional duty: what-if)
* ``GET /api/deep-dive/markets``                   the destination markets and their duty settings
* ``PATCH /api/deep-dive/markets/{id}``            admin: update a market's agreement rate / additional duty

Readiness (0-100) per subheading and market is a transparent weighted score, every component returned:

==============  ======  ===================================================================================
Component       Weight  Measure
==============  ======  ===================================================================================
demand          25      the market's imports of the HS6 (BACI, latest year), log-scaled against the
                        largest market x subheading of the heading
competitiveness 30      India's revealed comparative advantage, ``min(RCA, 2) / 2``
tariff          25      ``1 - min(duty, 40) / 40`` where duty = agreement rate (or the market's MFN from
                        WITS) + the market's additional duty on Indian goods
compliance      10      1 with no mandatory standard in the market, 0.5 with one or more
capability      10      1 when a cluster makes this product, 0.6 when only a heading-wide cluster (e.g. "Sports
                        Goods") exists, else 0.3
==============  ======  ===================================================================================

Bands: >= 65 ``ready``, >= 45 ``emerging``, otherwise ``not_ready``. Without an export base (RCA < 0.1) a product
cannot be more than ``not_ready``: its score is capped at 44 (``capped`` = true, ``uncapped_score`` kept), since
demand and low duties alone do not make India ready to supply a market. A component without data is ``null`` and its
weight is dropped (the score is re-normalised over the components that have data), so a missing tariff never
reads as a zero duty. A product with neither demand nor RCA data (e.g. an HS 2017 code with no HS 2022 trade) is
not scored.
"""
from __future__ import annotations

import math
import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.common import country_names, latest_year, parse_json, provenance
from app.db import get_db, row, rows
from app.security import require_admin
from app.services.audit import log_action

router = APIRouter(prefix="/api/deep-dive", tags=["deep dive"])

WEIGHTS = {"demand": 25, "competitiveness": 30, "tariff": 25, "compliance": 10, "capability": 10}
DUTY_CAP = 40.0
RCA_CAP = 2.0
READY, EMERGING = 65.0, 45.0
NO_EXPORT_BASE_RCA = 0.1
SOURCE_IDS = ("cluster_observatory", "wits_markets", "wits_trains", "iilb", "oec_baci", "dgft_itc_hs")


def _covers(prefix: str, code: str) -> bool:
    """True when a standard / cluster prefix applies to ``code`` (either is a prefix of the other)."""
    return code.startswith(prefix) or prefix.startswith(code)


def _heading(conn: sqlite3.Connection, hs4: str) -> dict:
    node = row(conn, "SELECT code, description, parent, section_id FROM hs_nodes WHERE code = ? AND level = 4", (hs4,))
    if node is None:
        raise HTTPException(404, f"HS heading {hs4} not found")
    chapter = row(conn, "SELECT code, description FROM hs_nodes WHERE code = ?", (node["parent"],))
    section = row(conn, "SELECT * FROM sections WHERE id = ?", (node["section_id"],))
    return {"code": hs4, "description": node["description"], "chapter": chapter, "section": section}


def _scope(conn: sqlite3.Connection, key: str) -> dict:
    """What a deep-dive covers: a basket id (``sports_equipment``) or an HS heading (``9506``, ``9506.62`` -> 9506).

    ``entries`` are the HS6 codes in display order (a basket keeps the study's order, labels and published values).
    """
    basket = row(conn, "SELECT * FROM baskets WHERE id = ?", (key,))
    if basket:
        entries = rows(conn, "SELECT bc.hs6, COALESCE(n.description, bc.category) AS description, bc.category, "
                             "bc.study_world_exports, bc.study_year, bc.note, n.code IS NOT NULL AS in_hs2022 "
                             "FROM basket_codes bc LEFT JOIN hs_nodes n ON n.code = bc.hs6 "
                             "WHERE bc.basket_id = ? ORDER BY bc.sort_order", (key,))
        head = {"code": basket["id"], "description": basket["description"], "chapter": None, "section": None}
        return {"kind": "basket", "key": key, "head": head, "basket": basket, "entries": entries,
                "codes": [e["hs6"] for e in entries]}
    digits = "".join(ch for ch in key if ch.isdigit())
    if len(digits) < 4:
        raise HTTPException(422, "give a 4-digit HS heading (e.g. 9506) or a basket id (e.g. sports_equipment)")
    hs4 = digits[:4]
    head = _heading(conn, hs4)
    entries = rows(conn, "SELECT code AS hs6, description FROM hs_nodes WHERE parent = ? AND level = 6 ORDER BY code",
                   (hs4,))
    return {"kind": "heading", "key": hs4, "head": head, "basket": None, "entries": entries,
            "codes": [e["hs6"] for e in entries]}


def _covers_any(prefix: str, codes: list[str]) -> bool:
    return any(_covers(prefix, c) for c in codes)


def _marks(values) -> str:
    return ",".join("?" * len(values))


def _clusters(conn: sqlite3.Connection, codes: list[str]) -> list[dict]:
    out = []
    for c in rows(conn, "SELECT * FROM co_clusters ORDER BY name"):
        prefixes = parse_json(c.pop("hs_prefixes_json"), [])
        if any(_covers_any(p, codes) for p in prefixes):
            out.append({**c, "hs_prefixes": prefixes, "origin": "cluster_observatory"})
    anchors = {r["id"]: r["anchor_hs"] for r in rows(conn, "SELECT id, anchor_hs FROM value_chains")
               if _covers_any(r["anchor_hs"], codes)}
    chains = list(anchors)
    if chains:
        for c in rows(conn, "SELECT * FROM clusters ORDER BY name"):
            ids = parse_json(c.get("chain_ids_json"), [])
            if not set(ids) & set(chains):
                continue
            anchor = next(anchors[i] for i in ids if i in anchors)
            town = c["name"].split()[0].lower()   # "Anantnag Cricket Bat Cluster" = Observatory "Anantnag Cricket Bats"
            same = next((o for o in out if o["name"].split()[0].lower() == town
                         and _state(o.get("state")) == _state(c["state"])), None)
            if same:   # the curated chain cluster is an Observatory cluster: enrich it instead of duplicating
                same.update({"district": same.get("district") or c.get("district"),
                             "district_source": same.get("district_source") or "curated", "detail": c.get("products"),
                             "lat": same.get("lat") or c.get("lat"), "lon": same.get("lon") or c.get("lon")})
            else:
                out.append({"id": c["id"], "name": c["name"], "cluster_type": "industrial", "state": c["state"],
                            "district": c.get("district"), "products": c.get("products"), "profile_url": None,
                            "hs_prefixes": [anchor], "lat": c.get("lat"), "lon": c.get("lon"), "origin": "value_chain"})
    for c in out:
        c["state"] = _state(c.get("state"))
    _link_nearby(conn, out, anchors)
    return out


def _chain_inputs(conn: sqlite3.Connection, chains: list[str]) -> list[dict]:
    """Raw-material / component items of the chains (every stage but the last)."""
    if not chains:
        return []
    return rows(conn, "SELECT v.chain_id, v.hs_code, v.item_name FROM vc_items v JOIN vc_stages s "
                      "ON s.chain_id = v.chain_id AND s.stage_id = v.stage_id "
                      f"WHERE v.chain_id IN ({_marks(chains)}) AND v.hs_code IS NOT NULL AND s.stage_order < "
                      "(SELECT MAX(stage_order) FROM vc_stages x WHERE x.chain_id = v.chain_id)", chains)


def _link_nearby(conn: sqlite3.Connection, clusters: list[dict], anchors: dict[str, str]) -> None:
    """``nearby``: other industrial clusters in the same district and state, each with ``inputs`` - the input items
    of the cluster's own value chain(s) (chains whose anchor covers the cluster's HS mapping) that the neighbour's
    HS mapping covers (``direct`` when mapped at 4+ digits, ``related`` at chapter level)."""
    inputs = _chain_inputs(conn, list(anchors))
    own = {c["id"] for c in clusters}
    places = {(c["district"].lower(), _state(c["state"])) for c in clusters if c.get("district") and c.get("state")}
    pool: dict[tuple, list[dict]] = {}
    if places:
        for n in rows(conn, "SELECT id, name, district, state, products, hs_prefixes_json FROM co_clusters "
                            "WHERE cluster_type = 'industrial' AND district IS NOT NULL"):
            key = (n["district"].lower(), _state(n["state"]))
            if key in places and n["id"] not in own:
                prefixes = parse_json(n.pop("hs_prefixes_json"), [])
                matched = [{"chain_id": i["chain_id"], "item": i["item_name"], "hs_code": i["hs_code"], "prefix": p,
                            "level": "direct" if len(p) >= 4 else "related"}
                           for i in inputs for p in prefixes if i["hs_code"].startswith(p)]
                pool.setdefault(key, []).append({**n, "hs_prefixes": prefixes, "inputs": matched})
    for c in clusters:
        own_chains = {cid for cid, a in anchors.items() if any(_covers(a, p) for p in c["hs_prefixes"])}
        near = [{**n, "inputs": [i for i in n["inputs"] if i["chain_id"] in own_chains]}
                for n in pool.get(((c.get("district") or "").lower(), c.get("state")), [])]
        c["nearby"] = sorted(near, key=lambda n: (not n["inputs"], n["name"]))


def _state(name: str | None) -> str | None:
    return name.replace(" & ", " and ") if name else name


def _standards(conn: sqlite3.Connection, codes: list[str]) -> list[dict]:
    names = {m["id"]: m["name"] for m in rows(conn, "SELECT id, name FROM markets")}
    names.update({"in": "India", "global": "Global (sport federations)"})
    out = []
    for s in rows(conn, "SELECT * FROM product_standards ORDER BY market_id, hs_prefix"):
        if _covers_any(s["hs_prefix"], codes):
            out.append({**s, "verified": bool(s["verified"]), "market_name": names.get(s["market_id"], s["market_id"])})
    return out


def _norm(name: str | None) -> str:
    return (_state(name) or "").strip().lower()


def _land(conn: sqlite3.Connection, clusters: list[dict]) -> dict:
    """India Industrial Land Bank parks in the clusters' districts (and their states): count, land, top parks."""
    src = row(conn, "SELECT status, last_refreshed FROM data_sources WHERE id = 'iilb'") or {}
    states = {_norm(c["state"]) for c in clusters if c.get("state")}
    parks = [p for p in rows(conn, "SELECT name, state, district, sector, total_area_ha, available_area_ha, raw_json "
                                   "FROM iilb_parks") if _norm(p["state"]) in states]
    def summary(ps: list[dict]) -> dict:
        return {"parks": len(ps), "total_ha": round(sum(p["total_area_ha"] or 0 for p in ps), 1),
                "available_ha": round(sum(p["available_area_ha"] or 0 for p in ps), 1),
                "parks_with_land": sum(1 for p in ps if (p["available_area_ha"] or 0) > 0)}
    by_state = [{"state": next((p["state"] for p in parks if _norm(p["state"]) == st), st), **summary(
        [p for p in parks if _norm(p["state"]) == st])} for st in sorted(states)]
    places: dict[tuple, list[str]] = {}
    for c in clusters:
        if c.get("district") and c.get("state"):
            places.setdefault((_norm(c["state"]), c["district"].strip().lower()), []).append(c["name"])
    by_district = []
    for (st, dist), names in sorted(places.items()):
        here = [p for p in parks if _norm(p["state"]) == st and (p["district"] or "").strip().lower() == dist]
        top = sorted(here, key=lambda p: -(p["available_area_ha"] or 0))[:5]
        by_district.append({
            "state": next((c["state"] for c in clusters if _norm(c["state"]) == st), st),
            "district": next((c["district"] for c in clusters if (c.get("district") or "").lower() == dist), dist),
            "clusters": names, **summary(here),
            "top_parks": [{"name": p["name"], "sector": p["sector"], "total_ha": p["total_area_ha"],
                           "available_ha": p["available_area_ha"],
                           "type": parse_json(p["raw_json"], {}).get("industrial_park_type"),
                           "plug_and_play": parse_json(p["raw_json"], {}).get("plug_and_play"),
                           "updated": parse_json(p["raw_json"], {}).get("updated")} for p in top]})
    return {"status": src.get("status") or "not_configured", "last_refreshed": src.get("last_refreshed"),
            "cluster_states": sorted({c["state"] for c in clusters if c.get("state")}),
            "by_state": by_state, "by_district": by_district}


def build_overview(conn: sqlite3.Connection, scope: dict) -> dict:
    head, codes = scope["head"], scope["codes"]
    year = latest_year(conn)
    found = {r["hs6"]: r for r in rows(conn, "SELECT n.code AS hs6, h4.description AS heading, m.india_exports, m.india_imports, m.world_trade, "
                      "m.trade_balance, m.rca, m.india_world_share, m.india_supplier_rank, m.top_destination, "
                      "m.top_destination_share, m.top_import_source, m.top_import_source_share, m.china_import_share, "
                      "m.export_cagr, m.import_cagr, t.mfn_avg AS india_mfn "
                      "FROM hs_nodes n LEFT JOIN hs_nodes h4 ON h4.code = n.parent "
                      "LEFT JOIN hs6_metrics m ON m.hs6 = n.code LEFT JOIN tariffs t ON t.hs6 = n.code "
                      f"WHERE n.code IN ({_marks(codes)})", codes)}
    subs = [{**e, "hs4": e["hs6"][:4], **found.get(e["hs6"], {})} for e in scope["entries"]]
    lines = rows(conn, "SELECT p.hsn8, p.hs6, p.description, p.ministry_id, mi.short_name AS ministry, "
                       "h.india_exports, h.india_imports, h.year, "
                       "(SELECT policy FROM dgft_itc_policy d WHERE d.itc_code = p.hsn8 AND d.direction = 'import' "
                       " AND d.is_current = 1 LIMIT 1) AS import_policy, "
                       "(SELECT policy FROM dgft_itc_policy d WHERE d.itc_code = p.hsn8 AND d.direction = 'export' "
                       " AND d.is_current = 1 LIMIT 1) AS export_policy "
                       "FROM products p LEFT JOIN ministries mi ON mi.id = p.ministry_id "
                       "LEFT JOIN trade_hs8 h ON h.hsn8 = p.hsn8 AND h.year = (SELECT MAX(year) FROM trade_hs8) "
                       f"WHERE p.hs6 IN ({_marks(codes)}) AND p.is_current = 1 ORDER BY p.hsn8", codes)
    clusters = _clusters(conn, codes)
    standards = _standards(conn, codes)
    cnames = country_names(conn, {s[k] for s in subs for k in ("top_destination", "top_import_source") if s.get(k)})
    for s in subs:
        s["top_destination_name"] = cnames.get(s.get("top_destination"))
        s["top_import_source_name"] = cnames.get(s.get("top_import_source"))
        s["lines"] = [ln for ln in lines if ln["hs6"] == s["hs6"]]
        s["standards"] = [x["id"] for x in standards if _covers(x["hs_prefix"], s["hs6"])]
        s["clusters"] = [c["id"] for c in clusters
                         if any(_covers(p, s["hs6"]) and len(p) > 4 for p in c["hs_prefixes"])]
    sum_ = lambda k: sum(s[k] or 0 for s in subs if s.get(k) is not None) if any(s.get(k) is not None for s in subs) else None  # noqa: E731
    x, m, w = sum_("india_exports"), sum_("india_imports"), sum_("world_trade")
    production = (row(conn, "SELECT * FROM production WHERE (scope IN ('hs4', 'hs6') AND key LIKE ?) "
                            "ORDER BY year DESC LIMIT 1", (scope["key"] + "%",)) if scope["kind"] == "heading" else None)
    chains = [{"id": r["id"], "name": r["name"], "title": r["title"]}
              for r in rows(conn, "SELECT id, name, title, anchor_hs FROM value_chains ORDER BY sort_order")
              if _covers_any(r["anchor_hs"], codes)]
    sector = row(conn, "SELECT s.id, s.name FROM products p JOIN sectors s ON s.id = p.sector_id "
                       f"WHERE p.hs6 IN ({_marks(codes)}) GROUP BY s.id ORDER BY COUNT(*) DESC LIMIT 1", codes)
    ministries = rows(conn, "SELECT mi.id, mi.name, COUNT(*) AS n_lines FROM products p "
                            "JOIN ministries mi ON mi.id = p.ministry_id "
                            f"WHERE p.hs6 IN ({_marks(codes)}) GROUP BY mi.id ORDER BY COUNT(*) DESC", codes)
    ministry = {"id": ministries[0]["id"], "name": ministries[0]["name"]} if ministries else None
    study = [s["study_world_exports"] for s in subs if s.get("study_world_exports") is not None]
    sources = rows(conn, f"SELECT id, name, status, last_refreshed, records FROM data_sources WHERE id IN "
                         f"({','.join('?' * len(SOURCE_IDS))})", SOURCE_IDS)
    return {
        "country": {"id": "asind", "name": "India"}, "kind": scope["kind"], "basket": scope["basket"],
        "heading": head, "sector": sector, "lead_ministry": ministry, "ministries": ministries, "year": year,
        "kpis": {"india_exports": x, "india_imports": m, "world_trade": w,
                 "trade_balance": (x - m) if x is not None and m is not None else None,
                 "india_world_share": (x / w) if x and w else None,
                 "n_subheadings": len(subs), "n_lines": len(lines), "n_clusters": len(clusters),
                 "n_headings": len({s["hs4"] for s in subs}),
                 "study_world_exports": sum(study) if study else None,
                 "production": production,
                 "production_provenance": provenance(production["source"] if production else None)},
        "subheadings": subs, "clusters": clusters, "standards": standards, "value_chains": chains,
        "land": _land(conn, clusters),
        "sources": sources,
        "provenance": {"trade": provenance("baci", year=year), "lines": provenance("dgcis_tradestat"),
                       "clusters": provenance("cluster_observatory", "not_verified",
                                              "Cluster Observatory register; HS mapping curated by the Atlas"),
                       "standards": provenance("curated", "not_verified", "Curated; see each row's verified flag")},
    }


def _markets(conn: sqlite3.Connection) -> list[dict]:
    out = []
    for m in rows(conn, "SELECT * FROM markets ORDER BY sort_order"):
        m["country_ids"] = parse_json(m.pop("country_ids_json"), [])
        out.append(m)
    return out


def _band(score: float | None) -> str | None:
    if score is None:
        return None
    return "ready" if score >= READY else "emerging" if score >= EMERGING else "not_ready"


def build_readiness(conn: sqlite3.Connection, scope: dict, market_id: str | None, extra_duty: float | None) -> dict:
    markets = [m for m in _markets(conn) if market_id in (None, m["id"])]
    if market_id and not markets:
        raise HTTPException(404, f"market {market_id} not found")
    codes = scope["codes"]
    marks = _marks(codes)
    metrics = {r["hs6"]: r for r in rows(conn, f"SELECT hs6, rca, india_exports FROM hs6_metrics WHERE hs6 IN ({marks})",
                                          codes)}
    subs = [{"hs6": e["hs6"], "description": e["description"], "category": e.get("category"),
             "rca": (metrics.get(e["hs6"]) or {}).get("rca"),
             "india_exports": (metrics.get(e["hs6"]) or {}).get("india_exports")} for e in scope["entries"]]
    standards = rows(conn, "SELECT hs_prefix, market_id, scheme, name, status FROM product_standards")
    cluster_prefixes = [p for c in _clusters(conn, codes) for p in c["hs_prefixes"]]
    specific = [p for p in cluster_prefixes if len(p) > 4]
    cells, demand_raw = [], []
    for m in markets:
        ids = m["country_ids"]
        cmarks = ",".join("?" * len(ids))
        demand = {r["hs6"]: r["v"] for r in rows(
            conn, f"SELECT hs6, SUM(value) AS v FROM world_markets WHERE hs6 IN ({marks}) AND country_id IN ({cmarks}) "
                  f"GROUP BY hs6", (*codes, *ids))}
        to_market = {r["hs6"]: r["v"] for r in rows(
            conn, f"SELECT hs6, SUM(value) AS v FROM india_partners WHERE flow = 'X' AND hs6 IN ({marks}) "
                  f"AND country_id IN ({cmarks}) GROUP BY hs6", (*codes, *ids))}
        mfn = {r["hs6"]: r for r in rows(conn, f"SELECT * FROM market_tariffs WHERE market_id = ? AND hs6 IN ({marks})",
                                         (m["id"], *codes))}
        extra = float(m["extra_duty_pct"] or 0) if extra_duty is None else float(extra_duty)
        for s in subs:
            t = mfn.get(s["hs6"])
            base_rate = m["pref_rate_pct"] if m["pref_rate_pct"] is not None else (t["mfn_avg"] if t else None)
            duty = None if base_rate is None else round(base_rate + extra, 2)
            reqs = [x for x in standards if x["market_id"] in (m["id"], "global") and _covers(x["hs_prefix"], s["hs6"])]
            mandatory = [x for x in reqs if x["status"] == "mandatory"]
            cells.append({"hs6": s["hs6"], "market_id": m["id"], "market_imports": demand.get(s["hs6"]),
                          "india_exports_to_market": to_market.get(s["hs6"]), "rca": s["rca"],
                          "mfn_rate": round(t["mfn_avg"], 2) if t and t["mfn_avg"] is not None else None, "mfn_year": t["year"] if t else None,
                          "pref_rate": m["pref_rate_pct"], "extra_duty": extra, "duty": duty,
                          "mandatory_standards": [x["name"] for x in mandatory],
                          "voluntary_standards": [x["name"] for x in reqs if x["status"] == "voluntary"],
                          "cluster_match": ("product" if any(_covers(p, s["hs6"]) for p in specific) else
                                            "heading" if any(_covers(p, s["hs6"]) for p in cluster_prefixes) else None)})
            if demand.get(s["hs6"]):
                demand_raw.append(demand[s["hs6"]])
    top = math.log10(max(demand_raw)) if demand_raw else None
    for c in cells:
        comp = {
            "demand": (max(0.0, math.log10(c["market_imports"]) / top) if c["market_imports"] and top else None),
            "competitiveness": min(c["rca"], RCA_CAP) / RCA_CAP if c["rca"] is not None else None,
            "tariff": 1 - min(max(c["duty"], 0.0), DUTY_CAP) / DUTY_CAP if c["duty"] is not None else None,
            "compliance": 0.5 if c["mandatory_standards"] else 1.0,
            "capability": {"product": 1.0, "heading": 0.6}.get(c["cluster_match"], 0.3),
        }
        used = {k: v for k, v in comp.items() if v is not None}
        weight = sum(WEIGHTS[k] for k in used)
        c["components"] = {k: (round(v * 100, 1) if v is not None else None) for k, v in comp.items()}
        has_trade = comp["demand"] is not None or comp["competitiveness"] is not None   # else no basis to score
        score = round(sum(WEIGHTS[k] * v for k, v in used.items()) / weight * 100, 1) if weight and has_trade else None
        c["capped"] = bool(score is not None and c["rca"] is not None and c["rca"] < NO_EXPORT_BASE_RCA
                           and score >= EMERGING)
        c["uncapped_score"] = score
        c["score"] = EMERGING - 1 if c["capped"] else score
        c["band"] = _band(c["score"])
        c["missing"] = [k for k, v in comp.items() if v is None]
    return {"hs4": scope["key"], "kind": scope["kind"], "markets": markets, "subheadings": subs, "cells": cells, "weights": WEIGHTS,
            "bands": {"ready": READY, "emerging": EMERGING}, "extra_duty_override": extra_duty,
            "method": __doc__.split("Readiness (0-100)")[1].strip() if __doc__ else None}


@router.get("/markets")
def list_markets(conn: sqlite3.Connection = Depends(get_db)) -> dict:
    return {"markets": _markets(conn)}


class MarketUpdate(BaseModel):
    agreement: str | None = None
    pref_rate_pct: float | None = Field(None, ge=0, le=500)
    extra_duty_pct: float = Field(..., ge=0, le=500)
    extra_duty_status: str = Field(..., pattern="^(none|verified|user_input)$")
    extra_duty_basis: str | None = None
    source: str | None = None
    as_of: str | None = None
    note: str | None = None


@router.patch("/markets/{market_id}")
def update_market(market_id: str, body: MarketUpdate, conn: sqlite3.Connection = Depends(get_db),
                  user: dict = Depends(require_admin)) -> dict:
    before = row(conn, "SELECT * FROM markets WHERE id = ?", (market_id,))
    if before is None:
        raise HTTPException(404, f"market {market_id} not found")
    data = body.model_dump()
    conn.execute("UPDATE markets SET agreement = ?, pref_rate_pct = ?, extra_duty_pct = ?, extra_duty_status = ?, "
                 "extra_duty_basis = ?, source = ?, as_of = ?, note = ? WHERE id = ?",
                 (data["agreement"], data["pref_rate_pct"], data["extra_duty_pct"], data["extra_duty_status"],
                  data["extra_duty_basis"], data["source"], data["as_of"], data["note"], market_id))
    conn.commit()
    log_action(conn, user, "market.update", "market", market_id,
               {"before": {k: before[k] for k in data}, "after": data})
    return {"market": next(m for m in _markets(conn) if m["id"] == market_id)}


@router.get("/baskets")
def list_baskets(conn: sqlite3.Connection = Depends(get_db)) -> dict:
    return {"baskets": rows(conn, "SELECT b.id, b.name, b.description, b.source, COUNT(c.hs6) AS n_codes FROM baskets b "
                                  "LEFT JOIN basket_codes c ON c.basket_id = b.id GROUP BY b.id ORDER BY b.sort_order")}


@router.get("/{key}")
def overview(key: str, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    return build_overview(conn, _scope(conn, key))


@router.get("/{key}/readiness")
def readiness(key: str, market: str | None = Query(None), extra_duty: float | None = Query(None, ge=0, le=500),
              conn: sqlite3.Connection = Depends(get_db)) -> dict:
    return build_readiness(conn, _scope(conn, key), market, extra_duty)


__all__ = ["router", "build_overview", "build_readiness", "WEIGHTS"]
