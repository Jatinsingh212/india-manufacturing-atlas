"""Product workflow: one product's whole story, step by step, in a single response (public).

Endpoints
---------
* ``GET /api/workflow``                         every value chain with its finished products (the picker)
* ``GET /api/workflow/{chain_id}?product=<hs>``  the workflow of one finished product of the chain (default: the
                                                  finished product India exports most)

Steps of the response
---------------------
1. ``product``      what it is: HS codes, India's exports / imports / balance, world trade, India's world rank and
                    share, RCA, India's import duty and DGFT import / export policy.
2. ``made_by``      who makes it: the chain's manufacturers, the clusters that make it (district, state,
                    coordinates, diagnostic study, input clusters next door) and industrial land in those districts.
3. ``inputs``       what it is made from: every raw material and component of the chain with its HS code, India's
                    imports / exports / balance, India's import duty (BCD), the top import source and China's share,
                    whether it feeds this product directly or through another input, and per-input flags.
4. ``competition``  what other countries do: top world exporters (India's rank appended), top importers and
                    India's own top destinations.
5. ``standards``    QCO / ISI / Hallmark in India and the requirements of each export market, plus QCO schemes.
6. ``markets``      each destination market: duty on Indian goods, the MFN duty most competitors pay, the gap,
                    readiness score and flags (see :func:`market_flags`).

``watch_outs`` lists the flags of every step, most severe first, so the page can open with them.

Tax: the Atlas has India's applied import duty (WITS / TRAINS MFN, i.e. BCD) per HS6. GST rates are not in the
Atlas data, so ``gst`` is reported as not available rather than guessed.
"""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query

from app.common import country_names, country_values, latest_year, provenance
from app.db import get_db, row, rows
from app.routers import deepdive, valuechains

router = APIRouter(prefix="/api/workflow", tags=["workflow"])

IMPORT_DEPENDENT_RATIO = 2.0        # imports at least twice exports ...
IMPORT_DEPENDENT_MIN = 1e6          # ... and at least US$ 1 mn
CHINA_SHARE_FLAG = 0.5
HIGH_INPUT_DUTY = 15.0              # % India's own import duty that raises input costs
HIGH_MARKET_DUTY = 15.0             # % duty on Indian goods in a market
MEDIUM_MARKET_DUTY = 10.0
PENALTY_FLAG = 0.5                  # percentage points above the MFN duty competitors pay
SEVERITY = {"high": 0, "medium": 1, "low": 2}


def _flag(severity: str, step: str, title: str, detail: str) -> dict:
    return {"severity": severity, "step": step, "title": title, "detail": detail}


def _usd(v: float | None) -> str:
    if v is None:
        return "n/a"
    for div, unit in ((1e9, "bn"), (1e6, "mn"), (1e3, "k")):
        if abs(v) >= div:
            return f"US$ {v / div:.1f} {unit}"
    return f"US$ {v:,.0f}"


# --------------------------------------------------------------------------- picker

@router.get("", summary="Value chains and their finished products")
def list_workflows(conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    out = []
    for ch in valuechains.list_value_chains(conn):
        detail = valuechains.value_chain(ch["id"], conn)
        final = detail["stages"][-1] if detail["stages"] else {"items": []}
        out.append({"id": ch["id"], "name": detail["chain"]["name"], "title": detail["chain"]["title"],
                    "anchor_hs": detail["chain"].get("anchor_hs"),
                    "products": [{"hs_code": i["hs_code"], "name": i["item_name"], "exports": i.get("exports")}
                                 for i in final["items"]]})
    return out


# --------------------------------------------------------------------------- steps

def _product_facts(conn: sqlite3.Connection, item: dict, year: int) -> dict:
    hs6 = item.get("hs6") or (item["hs_code"] or "")[:6]
    m = row(conn, "SELECT * FROM hs6_metrics WHERE hs6 = ?", (hs6,)) or {}
    names = country_names(conn, [c for c in (m.get("top_destination"), m.get("top_import_source")) if c])
    tariff = row(conn, "SELECT mfn_avg, year FROM tariffs WHERE hs6 = ?", (hs6,)) or {}
    hsn8 = item.get("hsn8")
    policy = {d["direction"]: d["policy"] for d in rows(
        conn, "SELECT direction, policy FROM dgft_itc_policy WHERE itc_code = ? AND is_current = 1", (hsn8,))} if hsn8 else {}
    line = row(conn, "SELECT india_exports, india_imports, year FROM trade_hs8 WHERE hsn8 = ? "
                     "ORDER BY year DESC LIMIT 1", (hsn8,)) if hsn8 else None
    line = line or {}
    lx, lm = line.get("india_exports"), line.get("india_imports")
    has_line = lx is not None or lm is not None
    return {
        "name": item["item_name"], "hs_code": item["hs_code"], "hsn8": hsn8, "hs6": hs6,
        # India's own trade: the exact 8-digit national line (DGCIS TRADESTAT) when published, else the HS6 subheading
        "trade_level": "hsn8" if has_line else "hs6",
        "exports": lx if has_line else m.get("india_exports"),
        "imports": lm if has_line else m.get("india_imports"),
        "balance": ((lx or 0) - (lm or 0)) if has_line else m.get("trade_balance"),
        "trade_year": line.get("year") if has_line else year,
        "description": item.get("gst_description") or item.get("description"),
        "ministries": item.get("ministries") or [],
        "hs6_description": (row(conn, "SELECT description FROM hs_nodes WHERE code = ?", (hs6,)) or {}).get("description"),
        "india_exports": m.get("india_exports"), "india_imports": m.get("india_imports"),
        "trade_balance": m.get("trade_balance"), "world_trade": m.get("world_trade"),
        "india_world_share": m.get("india_world_share"), "india_rank": m.get("india_supplier_rank"),
        "n_exporters": m.get("n_suppliers"), "rca": m.get("rca"), "export_cagr": m.get("export_cagr"),
        "world_cagr": m.get("world_cagr"),
        "top_destination": names.get(m.get("top_destination")), "top_destination_share": m.get("top_destination_share"),
        "top_import_source": names.get(m.get("top_import_source")),
        "top_import_source_share": m.get("top_import_source_share"), "china_import_share": m.get("china_import_share"),
        "line_trade": line or None,
        "tax": {"import_duty_bcd": tariff.get("mfn_avg"), "import_duty_year": tariff.get("year"),
                "gst": None, "gst_note": "GST rates are not in the Atlas data yet (CBIC rate schedule)."},
        "dgft_policy": policy, "year": year,
        "provenance": provenance("baci", year=year),
    }


def _upstream(conn: sqlite3.Connection, product_code: str, chain_codes: set[str]) -> dict[str, int]:
    """Chain items feeding ``product_code`` and how many links away (1 = direct input)."""
    edges = rows(conn, "SELECT src, dst FROM vc_edges WHERE relation IN ('input_to', 'component_of')")
    feeds: dict[str, set[str]] = {}
    for e in edges:
        feeds.setdefault(e["dst"], set()).add(e["src"])
    depth, frontier, level = {}, {product_code}, 0
    while frontier and level < 6:
        level += 1
        nxt = set()
        for code in frontier:
            for src in feeds.get(code, ()):
                if src in chain_codes and src not in depth:
                    depth[src] = level
                    nxt.add(src)
        frontier = nxt
    return depth


def _inputs(conn: sqlite3.Connection, detail: dict, product_code: str) -> tuple[list[dict], list[dict]]:
    stages = detail["stages"][:-1]
    items = [i for s in stages for i in s["items"]]
    hs6s = sorted({i["hs6"] for i in items if i.get("hs6")})
    metrics = {r["hs6"]: r for r in rows(conn, "SELECT hs6, top_import_source, top_import_source_share, "
                                               "china_import_share, india_supplier_rank FROM hs6_metrics WHERE hs6 IN "
                                               f"({','.join('?' * len(hs6s))})", hs6s)} if hs6s else {}
    names = country_names(conn, {m["top_import_source"] for m in metrics.values() if m.get("top_import_source")})
    depth = _upstream(conn, product_code, {i["hs_code"] for i in items})
    out_stages, flags = [], []
    for s in stages:
        out_items = []
        for i in s["items"]:
            m = metrics.get(i.get("hs6"), {})
            x, mm = i.get("exports"), i.get("imports")
            bal = (x or 0) - (mm or 0) if x is not None or mm is not None else None
            if mm and mm >= IMPORT_DEPENDENT_MIN and mm >= IMPORT_DEPENDENT_RATIO * (x or 0):
                status = "imported"
            elif x and x >= IMPORT_DEPENDENT_MIN and x >= IMPORT_DEPENDENT_RATIO * (mm or 0):
                status = "exported"
            elif x is None and mm is None:
                status = "no_data"
            else:
                status = "both"
            item_flags = []
            if status == "imported":
                item_flags.append("import_dependent")
            if (m.get("china_import_share") or 0) >= CHINA_SHARE_FLAG and (mm or 0) >= IMPORT_DEPENDENT_MIN:
                item_flags.append("china_dependent")
            if (i.get("mfn_tariff") or 0) >= HIGH_INPUT_DUTY and status == "imported":
                item_flags.append("high_input_duty")
            entry = {
                "name": i["item_name"], "hs_code": i["hs_code"], "hs6": i.get("hs6"),
                "description": i.get("gst_description") or i.get("description"),
                "ministries": i.get("ministries") or [], "india_exports": x, "india_imports": mm, "balance": bal,
                "import_duty_bcd": i.get("mfn_tariff"), "status": status,
                "top_import_source": names.get(m.get("top_import_source")),
                "top_import_source_share": m.get("top_import_source_share"),
                "china_import_share": m.get("china_import_share"),
                "feeds_product": depth.get(i["hs_code"]),        # 1 = direct input, 2+ = through another input
                "flags": item_flags,
            }
            out_items.append(entry)
            if entry["feeds_product"] and "import_dependent" in item_flags:
                china = " - mostly from China" if "china_dependent" in item_flags else ""
                duty = f"; India charges {i['mfn_tariff']:.0f}% import duty on it" if "high_input_duty" in item_flags else ""
                flags.append(_flag("medium" if "china_dependent" in item_flags or duty else "low", "inputs",
                                   f"{i['item_name']} is imported",
                                   f"India imports {_usd(mm)} vs exports {_usd(x)}{china}{duty}."))
        out_stages.append({"stage_id": s["stage_id"], "name": s["name"], "ministry_text": s.get("ministry_text"),
                           "items": out_items})
    return out_stages, flags


def _made_by(conn: sqlite3.Connection, detail: dict, hs6: str, hsn8: str | None) -> tuple[dict, list[dict]]:
    codes = [hsn8] if hsn8 else [hs6]
    clusters = deepdive._clusters(conn, codes)
    code = codes[0]
    for c in clusters:   # how specific the cluster's HS mapping is for this product
        best = max((len(p) for p in c["hs_prefixes"] if code.startswith(p) or p.startswith(code)), default=0)
        c["match"] = ("product" if best >= 6 else "family" if best >= 4 else "industry" if best else "chain")
    if any(c["origin"] == "cluster_observatory" and c["match"] in ("product", "family") for c in clusters):
        # the register knows clusters for this product family: the curated chain list would only repeat them
        clusters = [c for c in clusters if c["origin"] == "cluster_observatory"]
    order = {"product": 0, "family": 1, "chain": 2, "industry": 3}
    clusters.sort(key=lambda c: (order[c["match"]], c["name"]))
    land = deepdive._land(conn, [c for c in clusters if c["match"] != "industry"] or clusters)
    flags = []
    if not clusters:
        flags.append(_flag("medium", "made_by", "No registered cluster",
                           "The Cluster Observatory lists no cluster for this product."))
    for d in land.get("by_district") or []:
        if d["parks"] and not d["available_ha"]:
            flags.append(_flag("low", "made_by", f"No free industrial land in {d['district']}",
                               f"{d['parks']} parks in {d['district']} report 0 ha available (India Industrial Land Bank)."))
    return {"manufacturers": detail.get("manufacturers") or [], "clusters": clusters, "land": land}, flags


def _competition(conn: sqlite3.Connection, hs6: str) -> dict:
    return {"world_exporters": country_values(conn, "world_suppliers", hs6, limit=10, include_india=True),
            "world_importers": country_values(conn, "world_markets", hs6, limit=10),
            "india_destinations": country_values(conn, "india_partners", hs6, flow="X", limit=8),
            "india_sources": country_values(conn, "india_partners", hs6, flow="M", limit=8)}


def _standards(conn: sqlite3.Connection, code: str) -> tuple[dict, list[dict]]:
    found = [s for s in deepdive._standards(conn, [code]) if s["hs_prefix"] and code.startswith(s["hs_prefix"])]
    qco = rows(conn, "SELECT s.id, s.name, s.url, sp.hs_prefix FROM schemes s JOIN scheme_products sp "
                     "ON sp.scheme_id = s.id WHERE s.kind = 'QCO'")
    qcos = [q for q in qco if code.startswith(q["hs_prefix"]) or q["hs_prefix"].startswith(code)]
    india = [s for s in found if s["market_id"] == "in"]
    abroad = [s for s in found if s["market_id"] not in ("in", "global")]
    federation = [s for s in found if s["market_id"] == "global"]
    flags = []
    if qcos:
        flags.append(_flag("medium", "standards", "QCO in force",
                           "BIS certification (ISI mark) is compulsory: " + "; ".join(q["name"] for q in qcos)))
    for s in abroad:
        if s["status"] == "mandatory":
            flags.append(_flag("low", "standards", f"{s['market_name']}: {s['scheme']} required", s["name"]))
    return {"india": india, "export_markets": abroad, "federation": federation, "qco_schemes": qcos}, flags


def market_flags(cell: dict, market: dict) -> list[dict]:
    """Flags of one destination market. India's margin is not in the data, so the duty Indian goods pay is compared
    with the MFN duty most competitors pay and read against India's competitiveness (RCA)."""
    out = []
    duty, mfn = cell.get("duty"), cell.get("mfn_rate")
    gap = (duty - mfn) if duty is not None and mfn is not None else None
    exposed = cell.get("india_exports_to_market") or 0
    rca = cell.get("rca")
    name = market["name"]
    if gap is not None and gap >= PENALTY_FLAG:
        sev = "high" if gap >= 10 or (duty or 0) >= HIGH_MARKET_DUTY else "medium"
        out.append({"severity": sev, "kind": "tariff_penalty",
                    "title": f"{name} charges Indian goods {gap:.1f} pts more than competitors",
                    "detail": (f"Duty on Indian goods {duty:.1f}% vs {mfn:.1f}% MFN for most competitors"
                               + (f"; {_usd(exposed)} of India's exports are exposed." if exposed else "."))})
    elif duty is not None and duty >= HIGH_MARKET_DUTY:
        out.append({"severity": "medium", "kind": "high_duty", "title": f"High duty in {name}: {duty:.1f}%",
                    "detail": "Every exporter pays it, but it raises landed prices."})
    if duty is not None and duty >= MEDIUM_MARKET_DUTY and rca is not None and rca < 1:
        out.append({"severity": "high" if duty >= HIGH_MARKET_DUTY else "medium", "kind": "margin_risk",
                    "title": f"Margin at risk in {name}",
                    "detail": (f"A {duty:.1f}% duty on top of a weak competitive position (RCA {rca:.2f} < 1): "
                               "Indian exporters are unlikely to absorb it without losing price competitiveness.")})
    return out


def _markets(conn: sqlite3.Connection, hs6: str, description: str) -> tuple[list[dict], list[dict]]:
    scope = {"kind": "product", "key": hs6, "head": None, "basket": None,
             "entries": [{"hs6": hs6, "description": description}], "codes": [hs6]}
    ready = deepdive.build_readiness(conn, scope, None, None)
    markets = {m["id"]: m for m in ready["markets"]}
    out, flags = [], []
    for cell in ready["cells"]:
        m = markets[cell["market_id"]]
        mflags = market_flags(cell, m)
        gap = (cell["duty"] - cell["mfn_rate"]) if cell.get("duty") is not None and cell.get("mfn_rate") is not None else None
        out.append({"market_id": m["id"], "market": m["name"], "agreement": m.get("agreement"),
                    "extra_duty_status": m.get("extra_duty_status"), "duty_on_india": cell.get("duty"),
                    "competitor_mfn": cell.get("mfn_rate"), "gap_pts": round(gap, 2) if gap is not None else None,
                    "market_imports": cell.get("market_imports"),
                    "india_exports_to_market": cell.get("india_exports_to_market"), "score": cell.get("score"),
                    "band": cell.get("band"), "capped": cell.get("capped"),
                    "mandatory_standards": cell.get("mandatory_standards"), "flags": mflags})
        flags += [{**f, "step": "markets"} for f in mflags]
    out.sort(key=lambda r: -(r["market_imports"] or 0))
    return out, flags


# --------------------------------------------------------------------------- the workflow

def build_workflow(conn: sqlite3.Connection, chain_id: str, product: str | None) -> dict:
    detail = valuechains.value_chain(chain_id, conn)
    if not detail["stages"]:
        raise HTTPException(404, f"value chain {chain_id} has no stages")
    finished = detail["stages"][-1]["items"]
    if not finished:
        raise HTTPException(404, f"value chain {chain_id} has no finished products")
    if product:
        item = next((i for i in finished if i["hs_code"] == product or i.get("hsn8") == product), None)
        if item is None:
            raise HTTPException(404, f"{product} is not a finished product of {chain_id}")
    else:
        lines = {r["hsn8"]: r["india_exports"] or 0 for r in rows(
            conn, "SELECT hsn8, india_exports FROM trade_hs8 WHERE year = (SELECT MAX(year) FROM trade_hs8)")}
        item = max(finished, key=lambda i: lines.get(i.get("hsn8"), i.get("exports") or 0))
    year = latest_year(conn)
    facts = _product_facts(conn, item, year)
    made_by, f_made = _made_by(conn, detail, facts["hs6"], facts["hsn8"])
    inputs, f_inputs = _inputs(conn, detail, item["hs_code"])
    standards, f_std = _standards(conn, facts["hsn8"] or facts["hs6"])
    markets, f_markets = _markets(conn, facts["hs6"], facts["hs6_description"] or facts["name"])
    f_product = []
    if facts["balance"] is not None and facts["balance"] < 0:
        f_product.append(_flag("medium", "product", "India is a net importer",
                               f"Imports {_usd(facts['imports'])} vs exports {_usd(facts['exports'])}."))
    if facts["rca"] is not None and facts["rca"] < 1:
        f_product.append(_flag("low", "product", "Not yet competitive globally",
                               f"RCA {facts['rca']:.2f} (below 1 = India is not specialised in this product)."))
    watch = sorted(f_product + f_made + f_inputs + f_std + f_markets, key=lambda f: SEVERITY[f["severity"]])
    all_inputs = [i for s in inputs for i in s["items"]]
    return {
        "chain": {**detail["chain"], "anchor": detail.get("anchor")},
        "products": [{"hs_code": i["hs_code"], "name": i["item_name"]} for i in finished],
        "product": facts,
        "made_by": made_by,
        "inputs": {"stages": inputs, "summary": {
            "total": len(all_inputs),
            "imported": sum(1 for i in all_inputs if i["status"] == "imported"),
            "exported": sum(1 for i in all_inputs if i["status"] == "exported"),
            "feeding_product": sum(1 for i in all_inputs if i["feeds_product"]),
            "china_dependent": sum(1 for i in all_inputs if "china_dependent" in i["flags"])}},
        "competition": _competition(conn, facts["hs6"]),
        "standards": standards,
        "markets": markets,
        "watch_outs": watch,
        "method": {"margin": ("No cost or price data is in the Atlas, so the margin flag compares the duty Indian goods "
                              "pay with the MFN duty most competitors pay, and with India's RCA."),
                   "tax": "Import duty = India's applied MFN tariff (BCD) from WITS / TRAINS; GST not available."},
    }


@router.get("/{chain_id}", summary="The step-by-step workflow of one finished product")
def workflow(chain_id: str, product: str | None = Query(None, description="HS code of a finished product of the chain"),
             conn: sqlite3.Connection = Depends(get_db)) -> dict:
    return build_workflow(conn, chain_id, product)
