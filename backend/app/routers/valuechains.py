"""Value-chain sector deep-dives (docs/SPEC.md section 6.5). Owner: C2. Public.

Endpoints
---------
* ``GET /api/valuechains``                       the curated chains with headline trade of their anchor code
* ``GET /api/valuechains/{id}``                  the sector deep-dive
* ``GET /api/valuechains/{id}/mapping?stage_id=`` the ministry-wise product mapping table

Decisions (the SPEC leaves them open)
-------------------------------------
* **Chain KPIs** sum the distinct HS6 codes under ``anchor_hs`` (``4011`` -> its eight subheadings, a chapter
  anchor such as ``52`` -> every HS6 of the chapter) in the latest year. ``india_share`` is a fraction
  (X / W); ``unit`` is ``usd`` | ``fraction`` | the production unit (``tonnes``, ``units`` ...).
* **Production KPIs** come from ``production`` (``scope = 'chain'``, ``label`` ``global_production`` /
  ``india_production`` / ``india_output``) through the shared chooser ``app.common.production_record`` over
  real sources; a missing value is ``null`` with provenance status ``not_available``.
* **Per-row provenance.** Every stage item and mapping row carries ``provenance``; curated rows are not
  verified ("Curated by the Atlas team, awaiting ministry validation"). The chain-level
  ``provenance.mapping`` carries the row counts.
* **Ministries** are the Atlas's product mapping (``products.ministry_id`` + secondary owners, read live so an
  approved claim or official upload shows at once).
* **India's rank** = India's position among the world's exporters of the summed anchor HS6 set
  (``world_suppliers``, latest year); ``n_suppliers`` counts exporters with a positive value.
* **Stage items** carry HS6-level trade (the item's subheading; a 4-digit item sums the distinct HS6 under it;
  a line whose HS6 the source reports only as a heading aggregate, e.g. petroleum oils ``2710 -> 271000``,
  shows that aggregate with ``trade_level = "hs4_aggregate"``). ``linked`` = the code resolves to trade data.
* **Country panels**: top 10 world suppliers (India appended with its true rank when outside the top 10), top
  10 world markets, India's top 10 destinations and sources, all summed over the anchor HS6 set.
* **Risk flags** = distinct item subheadings with imports >= US$ 1 mn that are vulnerable (score >= 50),
  import-dependent (dependency ratio >= 0.5) or China-dependent (China share >= 0.5), plus any automated
  alert on them; most vulnerable first (max 12).
* **Skill council**: ``skill_council_json``; a missing URL is filled from ``skill_councils`` when the name matches.
* **Schemes**: PLI / QCO schemes whose HS prefix covers, or lies under, any code of the chain.
* Responses are cached per data fingerprint (``app.services.scoring.cached``).
"""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query

from app.common import country_values, latest_year, parse_json, production_record, provenance
from app.db import get_db, in_json, json_param, rows, scalar
from app.services.graph import chain_codes
from app.services.scoring import aggregate, analytics_frame, cached

router = APIRouter(prefix="/api/valuechains", tags=["value chains"])

KPI_KEYS = ("global_production", "india_production", "global_exports", "india_exports", "india_share",
            "india_imports")
COUNTRY_LIMIT = 10
TOP_CATEGORIES = 5
RISK_MIN_IMPORTS = 1e6
RISK_MIN_VULNERABILITY = 50.0
RISK_MIN_SHARE = 0.5
MAX_RISK_FLAGS = 12

_TRADE_LABELS = {
    "global_exports": "Global exports",
    "india_exports": "India's exports",
    "india_share": "India's share in global exports",
    "india_imports": "India's imports",
}
_PRODUCTION_LABELS = {"global_production": "Global production", "india_production": "India's production",
                      "india_output": "India's output"}
CURATED_LABEL = "Curated by the Atlas team, awaiting ministry validation (ministry = the Atlas's product mapping)"
_SCORES_LABEL = "Model estimate - see /about#methodology"


# --------------------------------------------------------------------------- small helpers

def ordinal(n: int) -> str:
    """``1 -> "1st"``, ``2 -> "2nd"``, ``8 -> "8th"``, ``11 -> "11th"``, ``23 -> "23rd"``."""
    if 10 <= n % 100 <= 20:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def _num(value) -> float | None:
    try:
        return None if value is None or isinstance(value, bool) else float(value)
    except (TypeError, ValueError):
        return None


def _ministry_index(conn: sqlite3.Connection) -> dict[str, dict]:
    return {r["id"]: r for r in rows(conn, "SELECT id, short_name, name, color FROM ministries")}


def _chain_row(conn: sqlite3.Connection, chain_id: str) -> dict:
    chain = rows(conn, "SELECT * FROM value_chains WHERE id = ?", (chain_id,))
    if not chain:
        raise HTTPException(status_code=404, detail=f"Unknown value chain '{chain_id}'")
    return chain[0]


def _notes(chain: dict) -> list[str]:
    notes = parse_json(chain.get("notes_json"), []) if "notes_json" in chain else []
    return [str(n) for n in notes if n] if isinstance(notes, list) else []


def _chain_meta(chain: dict, ministries: dict[str, dict]) -> dict:
    return {"id": chain["id"], "name": chain["name"], "title": chain.get("title"), "anchor_hs": chain["anchor_hs"],
            "description": chain.get("description"), "phase": chain.get("phase"), "source": chain.get("source"),
            "lead_ministry": ministries.get(chain.get("lead_ministry_id") or ""), "notes": _notes(chain)}


# --------------------------------------------------------------------------- row provenance

def row_provenance(source: str | None) -> dict:
    """Provenance of one value-chain row (all rows are Atlas-curated, so not verified)."""
    return provenance(source or "curated", "not_verified", CURATED_LABEL)


def chain_mapping_provenance(chain: dict, sources: list[str | None]) -> dict:
    """Chain-level mapping provenance with the number of curated rows."""
    prov = provenance(chain.get("source") or "curated", "not_verified",
                      "Curated value chain (official trade-aligned mapping)")
    prov["counts"] = {"curated": len(sources)}
    return prov


def tier_mapping_provenance(source: str | None, sources: list[str | None]) -> dict:
    """Tier-level mapping provenance: the tier's own source and the number of curated rows.

    The tier structure (levels, descriptions, example supplier types) is curated from the study, so the
    tier rows carry the study as their source - not the chain's `curated` - and are Not verified until
    a ministry validates them, exactly like the chain mapping.
    """
    prov = provenance(source or "curated", "not_verified",
                      "Curated supplier tiers (ministry = the Atlas's product mapping)")
    prov["counts"] = {"curated": len(sources)}
    return prov


def _live_owners(conn: sqlite3.Connection, hsn8s: list[str]) -> dict[str, list[str]]:
    """``{hsn8: [primary, secondary...]}`` from the current product mapping ('residual' when unmapped)."""
    codes = sorted({c for c in hsn8s if c})
    if not codes:
        return {}
    owners: dict[str, list[str]] = {}
    for r in rows(conn, f"SELECT hsn8, ministry_id FROM products WHERE {in_json('hsn8')}", (json_param(codes),)):
        owners[r["hsn8"]] = [r["ministry_id"]]
    for r in rows(conn, f"""SELECT hsn8, ministry_id FROM product_ministries
                            WHERE role = 'secondary' AND {in_json('hsn8')} ORDER BY hsn8, ministry_id""",
                  (json_param(codes),)):
        if r["hsn8"] in owners and r["ministry_id"] not in owners[r["hsn8"]]:
            owners[r["hsn8"]].append(r["ministry_id"])
    return owners


# --------------------------------------------------------------------------- supplier tiers

def _tier_items(conn: sqlite3.Connection, chain_id: str) -> list[dict]:
    """The chain's tier items with live owners and per-row provenance."""
    items = rows(conn, """SELECT id, tier_level, item_order, item_name, hs_code, hsn8, description, ministry_text,
                                 ministry_ids_json, source
                          FROM vc_tier_items WHERE chain_id = ? ORDER BY tier_level, item_order, id""",
                 (chain_id,))
    hsn8s = [it["hsn8"] for it in items if it["hsn8"]]
    gst = _gst_descriptions(conn, hsn8s)
    live = _live_owners(conn, hsn8s)
    for it in items:
        ids = parse_json(it.get("ministry_ids_json"), []) or []
        if it["hsn8"] in live and live[it["hsn8"]] != ids:
            ids = live[it["hsn8"]]
        it["ministry_ids"] = ids
        it["gst_description"] = gst.get(it["hsn8"]) if it["hsn8"] else None
    return items


def _build_tiers(conn: sqlite3.Connection, chain_id: str) -> dict:
    """The chain's supplier tiers with each item's live trade figures.

    The tier structure (levels, descriptions, example supplier types) is curated from the study; the
    trade figures come from the Atlas's own tables, so every number carries its usual provenance.
    """
    chain = _chain_row(conn, chain_id)
    tiers = rows(conn, """SELECT tier_level, name, description, examples_json, sort_order, source
                          FROM vc_tiers WHERE chain_id = ? ORDER BY sort_order, tier_level""", (chain_id,))
    items = _tier_items(conn, chain_id)
    if not tiers:
        return {"chain_id": chain_id, "title": chain.get("title") or chain["name"], "tiers": [],
                "notes": _notes(chain), "provenance": {"mapping": provenance("curated", "not_verified",
                                                                            CURATED_LABEL)}}
    by_tier: dict[int, list[dict]] = {}
    for it in items:
        by_tier.setdefault(it["tier_level"], []).append(it)
    ministries = _ministry_index(conn)
    frame = analytics_frame(conn)
    out = []
    for t in tiers:
        tier_items = []
        for it in by_tier.get(t["tier_level"], []):
            code = it["hs_code"] or ""
            hs6s, level = frame.resolve(code) if code else ([], None)
            agg = aggregate(frame, hs6s)
            rec = frame.by_hs6[hs6s[0]] if len(hs6s) == 1 else None
            tier_items.append({
                "id": it["id"], "item_name": it["item_name"], "hs_code": it["hs_code"], "hsn8": it["hsn8"],
                "description": it["description"], "ministry_text": it["ministry_text"],
                "ministries": [ministries[m] for m in dict.fromkeys(it["ministry_ids"]) if m in ministries],
                "exports": agg["exports"], "imports": agg["imports"],
                "rca": rec.get("rca") if rec else agg["rca"],
                "mfn_tariff": rec.get("mfn_tariff") if rec else agg["mfn_tariff"],
                "vulnerability_score": agg["vulnerability_score"],
                "linked": bool(hs6s), "hs6": hs6s[0] if len(hs6s) == 1 else None,
                "trade_level": level if hs6s else None, "item_order": it["item_order"], "source": it["source"],
                "gst_description": it["gst_description"], "provenance": row_provenance(it["source"]),
            })
        out.append({
            "tier_level": t["tier_level"], "name": t["name"], "description": t["description"],
            "examples": parse_json(t.get("examples_json"), []) or [],
            "items": tier_items,
            "provenance": tier_mapping_provenance(t["source"], [i["source"] for i in tier_items])
            if tier_items else None,
        })
    return {
        "chain_id": chain_id, "title": chain.get("title") or chain["name"], "tiers": out,
        "notes": _notes(chain),
        "provenance": {"mapping": tier_mapping_provenance(
                           tiers[0]["source"] if tiers else None, [i["source"] for i in items]),
                       "trade": provenance("baci", year=latest_year(conn))},
    }


def _gst_descriptions(conn: sqlite3.Connection, hsn8s: list[str]) -> dict[str, str]:
    codes = sorted({c for c in hsn8s if c})
    if not codes:
        return {}
    return {r["hsn8"]: r["description"] for r in rows(
        conn, f"SELECT hsn8, description FROM products WHERE {in_json('hsn8')}", (json_param(codes),))}


def _ministry_text(index: dict[str, dict], ids: list[str]) -> str | None:
    names = []
    for mid in ids:
        if mid == "residual":
            names.append("Residual (no owning ministry yet)")
        elif mid in index:
            names.append(index[mid]["name"])
    return ", ".join(names) or None


# --------------------------------------------------------------------------- list

def _build_list(conn: sqlite3.Connection) -> list[dict]:
    frame = analytics_frame(conn)
    ministries = _ministry_index(conn)
    counts = {r["chain_id"]: r for r in rows(conn, """
        SELECT s.chain_id, COUNT(DISTINCT s.stage_id) AS n_stages,
               (SELECT COUNT(*) FROM vc_items i WHERE i.chain_id = s.chain_id) AS n_items
        FROM vc_stages s GROUP BY s.chain_id""")}
    out = []
    for chain in rows(conn, "SELECT * FROM value_chains ORDER BY sort_order, id"):
        hs6s, level = frame.resolve(chain["anchor_hs"])
        agg = aggregate(frame, hs6s)
        c = counts.get(chain["id"], {})
        out.append({**_chain_meta(chain, ministries),
                    "n_stages": int(c.get("n_stages") or 0), "n_items": int(c.get("n_items") or 0),
                    "india_exports": agg["exports"], "india_imports": agg["imports"],
                    "world_trade": agg["world_trade"], "india_share": agg["india_share"],
                    "n_hs6": agg["n_hs6"], "sort_order": chain.get("sort_order")})
    return out


@router.get("", summary="Curated value chains with headline trade")
def list_value_chains(conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    return cached(conn, "vc_list", _build_list)


@router.get("/clusters/all", summary="List all manufacturing clusters across India")
def list_all_clusters(conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    cluster_rows = rows(conn, """
        SELECT c.id, c.name, c.state, c.district, c.products, c.chain_ids_json, c.sector_ids_json, c.lat, c.lon, c.source
        FROM clusters c
        ORDER BY c.state, c.name
    """)
    out = []
    for r in cluster_rows:
        chain_ids = parse_json(r.get("chain_ids_json"), [])
        sector_ids = parse_json(r.get("sector_ids_json"), [])
        out.append({
            "id": r["id"],
            "name": r["name"],
            "state": r["state"],
            "district": r["district"],
            "products": r["products"],
            "chain_ids": chain_ids,
            "sector_ids": sector_ids,
            "lat": r["lat"],
            "lon": r["lon"],
            "source": r["source"],
            "provenance": provenance("dpiit_guidebook", "verified", "DPIIT & State Industrial Agencies (IILB aligned)")
        })
    return out


# --------------------------------------------------------------------------- detail

def _production_kpi(conn: sqlite3.Connection, chain: dict, key: str) -> dict:
    """KPI dict for a real production figure from the shared chooser."""
    rec = production_record(conn, "chain", chain["id"], key)[0]
    label = _PRODUCTION_LABELS[key]
    if rec is None or _num(rec.get("value")) is None:
        return {"key": key, "label": label, "value": None, "unit": None, "year": None,
                "provenance": provenance(None, "not_available", "Not available")}
    source = rec.get("source") or "manual"
    year = rec.get("year")
    return {"key": key, "label": label, "value": _num(rec["value"]), "unit": rec.get("unit"), "year": year,
            "provenance": provenance(source, rec.get("status"), None, year)}


def _kpis(conn: sqlite3.Connection, chain: dict, agg: dict, year: int) -> list[dict]:
    trade_prov = provenance("tradestat", year=year) if agg["n_hs6"] else provenance(None)
    values = {"global_exports": (agg["world_trade"], "usd"), "india_exports": (agg["exports"], "usd"),
              "india_share": (agg["india_share"], "fraction"), "india_imports": (agg["imports"], "usd")}
    out = []
    for key in KPI_KEYS:
        if key in _PRODUCTION_LABELS:
            out.append(_production_kpi(conn, chain, key))
            continue
        value, unit = values[key]
        out.append({"key": key, "label": _TRADE_LABELS[key], "value": value, "unit": unit,
                    "year": year if value is not None else None,
                    "provenance": trade_prov if value is not None else provenance(None)})
    return out


def _india_rank(conn: sqlite3.Connection, hs6s: list[str], suppliers: list[dict]) -> dict:
    if not hs6s:
        return {"rank": None, "n_suppliers": None, "text": None}
    n = scalar(conn, """SELECT COUNT(DISTINCT country_id) FROM world_suppliers
                        WHERE value > 0 AND hs6 IN (SELECT value FROM json_each(?))""",
               (json_param(hs6s),), 0)
    india = next((s for s in suppliers if s["country_id"] == "asind"), None)
    rank = india["rank"] if india and (india.get("value") or 0) > 0 else None
    text = f"India's rank is {ordinal(rank)} in global suppliers" if rank else "India is not among the suppliers"
    return {"rank": rank, "n_suppliers": int(n) if n else None, "text": text,
            "india_value": india["value"] if india else None, "india_share": india["share"] if india else None}


def _item_rows(conn: sqlite3.Connection, chain_id: str) -> list[dict]:
    return rows(conn, """SELECT id, stage_id, item_order, item_name, hs_code, hsn8, description, ministry_text,
                                ministry_ids_json, source
                         FROM vc_items WHERE chain_id = ? ORDER BY item_order, id""", (chain_id,))


def _decorate_items(conn: sqlite3.Connection, chain: dict, items: list[dict], ministries: dict[str, dict]) -> None:
    """Add live owners and per-row provenance to raw ``vc_items`` rows (in place)."""
    hsn8s = [it["hsn8"] for it in items if it["hsn8"]]
    gst = _gst_descriptions(conn, hsn8s)
    live = _live_owners(conn, [it["hsn8"] for it in items if it["hsn8"]])
    for it in items:
        ids = parse_json(it.get("ministry_ids_json"), []) or []
        if it["hsn8"] in live and live[it["hsn8"]] != ids:
            ids = live[it["hsn8"]]
            it["ministry_text"] = _ministry_text(ministries, ids)
        it["ministry_ids"] = ids
        it["gst_description"] = gst.get(it["hsn8"]) if it["hsn8"] else None
        it["provenance"] = row_provenance(it["source"])


def _items_and_stages(conn: sqlite3.Connection, chain: dict, frame, ministries: dict[str, dict]) -> list[dict]:
    chain_id = chain["id"]
    stages = rows(conn, """SELECT stage_id, name, stage_order, ministry_text, ministry_ids_json FROM vc_stages
                           WHERE chain_id = ? ORDER BY stage_order, stage_id""", (chain_id,))
    items = _item_rows(conn, chain_id)
    _decorate_items(conn, chain, items, ministries)
    by_stage: dict[str, list[dict]] = {}
    for it in items:
        code = it["hs_code"] or ""
        hs6s, level = frame.resolve(code) if code else ([], None)
        agg = aggregate(frame, hs6s)
        rec = frame.by_hs6.get(hs6s[0]) if len(hs6s) == 1 else None
        by_stage.setdefault(it["stage_id"], []).append({
            "id": it["id"], "item_name": it["item_name"], "hs_code": it["hs_code"], "hsn8": it["hsn8"],
            "description": it["description"], "ministry_text": it["ministry_text"],
            "ministries": [ministries[m] for m in dict.fromkeys(it["ministry_ids"]) if m in ministries],
            "exports": agg["exports"], "imports": agg["imports"],
            "rca": rec.get("rca") if rec else agg["rca"],
            "mfn_tariff": rec.get("mfn_tariff") if rec else agg["mfn_tariff"],
            "vulnerability_score": agg["vulnerability_score"],
            "linked": bool(hs6s), "hs6": hs6s[0] if len(hs6s) == 1 else None,
            "trade_level": level if hs6s else None, "item_order": it["item_order"], "source": it["source"],
            "gst_description": it["gst_description"], "provenance": it["provenance"],
        })
    out = []
    for s in stages:
        stage_items = by_stage.get(s["stage_id"], [])
        stage_ids = parse_json(s["ministry_ids_json"], []) or []
        text = s["ministry_text"]
        if stage_items:
            derived = list(dict.fromkeys(m["id"] for i in stage_items for m in i["ministries"] if m["id"] != "residual"))
            if derived and derived != stage_ids:
                stage_ids, text = derived, _ministry_text(ministries, derived)
        out.append({"stage_id": s["stage_id"], "name": s["name"], "order": s["stage_order"],
                    "ministry_text": text, "ministries": [ministries[m] for m in stage_ids if m in ministries],
                    "items": stage_items,
                    "provenance": chain_mapping_provenance(chain, [i["source"] for i in stage_items])
                    if stage_items else None})
    return out


def _top_categories(frame, hs6s: list[str], total_exports: float | None) -> list[dict]:
    recs = [frame.by_hs6[h] for h in hs6s if (frame.by_hs6[h].get("india_exports") or 0) > 0]
    recs.sort(key=lambda r: (-(r.get("india_exports") or 0), r["hs6"]))
    return [{"code": r["hs6"], "label": r["description"], "value": r.get("india_exports"),
             "share": (r["india_exports"] / total_exports) if total_exports else None}
            for r in recs[:TOP_CATEGORIES]]


def _clusters(conn: sqlite3.Connection, chain_id: str) -> list[dict]:
    return rows(conn, """SELECT c.id, c.name, c.state, c.district, c.products, c.lat, c.lon, c.source
                         FROM clusters c
                         WHERE EXISTS (SELECT 1 FROM json_each(COALESCE(c.chain_ids_json, '[]')) j
                                       WHERE j.value = ?)
                         ORDER BY c.state, c.name""", (chain_id,))


def _skill_council(conn: sqlite3.Connection, chain: dict) -> dict | None:
    council = parse_json(chain.get("skill_council_json"), None)
    if not isinstance(council, dict) or not council.get("name"):
        match = rows(conn, """SELECT s.name, s.url FROM skill_councils s
                              WHERE EXISTS (SELECT 1 FROM json_each(COALESCE(s.chain_ids_json, '[]')) j
                                            WHERE j.value = ?) ORDER BY s.id LIMIT 1""", (chain["id"],))
        return {"name": match[0]["name"], "url": match[0]["url"]} if match else None
    url = council.get("url")
    if not url:
        url = scalar(conn, "SELECT url FROM skill_councils WHERE lower(name) = lower(?) AND url IS NOT NULL",
                     (council["name"],))
    return {"name": council["name"], "url": url}


def _schemes(conn: sqlite3.Connection, codes: list[str]) -> list[dict]:
    from app.routers.analytics import scheme_index  # shared C2 helper (cached prefix index)

    out: dict[str, dict] = {}
    for s in scheme_index(conn):
        p = s["prefix"]
        hits = [c for c in codes if c.startswith(p) or p.startswith(c)]
        if hits:
            entry = out.setdefault(s["id"], {"id": s["id"], "name": s["name"], "kind": s["kind"], "codes": []})
            entry["codes"] = sorted(set(entry["codes"]) | set(hits))
    return sorted(out.values(), key=lambda s: (s["kind"], s["name"]))


def _risk_flags(conn: sqlite3.Connection, frame, stages: list[dict]) -> list[dict]:
    """Vulnerable inputs of the chain (see module docstring), one flag per distinct HS6."""
    alerts: dict[str, list[str]] = {}
    seen: set[str] = set()
    candidates = []
    for stage in stages:
        for it in stage["items"]:
            code = it["hs_code"]
            if not code or not it["linked"]:
                continue
            hs6s, _level = frame.resolve(code)
            key = ",".join(hs6s)
            if key in seen:
                continue
            seen.add(key)
            candidates.append((stage, it, hs6s))
    all_hs6 = sorted({h for _, _, hs6s in candidates for h in hs6s})
    if all_hs6:
        for a in rows(conn, """SELECT hs6, title FROM alerts WHERE hs6 IN (SELECT value FROM json_each(?))
                               ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id""",
                      (json_param(all_hs6),)):
            alerts.setdefault(a["hs6"], []).append(a["title"].split(":")[0])
    flags = []
    for stage, it, hs6s in candidates:
        agg = aggregate(frame, hs6s)
        imports = agg["imports"] or 0.0
        exports = agg["exports"] or 0.0
        vuln = agg["vulnerability_score"]
        dep = imports / (imports + exports) if imports + exports > 0 else None
        china = None
        top_name, top_share = None, None
        if len(hs6s) == 1:
            rec = frame.by_hs6[hs6s[0]]
            china = rec.get("china_import_share")
            top_name, top_share = rec.get("top_import_source_name"), rec.get("top_import_source_share")
        elif imports > 0:
            top = country_values(conn, "india_partners", hs6s, flow="M", limit=10)
            if top:
                top_name, top_share = top[0]["country"], top[0]["share"]
                china = next((t["share"] for t in top if t["country_id"] == "aschn"), 0.0)
        reasons = []
        if vuln is not None and vuln >= RISK_MIN_VULNERABILITY:
            reasons.append(f"vulnerability score {vuln:.0f}/100")
        if dep is not None and dep >= RISK_MIN_SHARE:
            reasons.append(f"imports are {dep:.0%} of India's trade in it")
        if china is not None and china >= RISK_MIN_SHARE:
            reasons.append(f"{china:.0%} of imports come from China")
        item_alerts = sorted({(t if len(hs6s) == 1 else f"{t} in HS {h}") for h in hs6s for t in alerts.get(h, [])})
        if imports < RISK_MIN_IMPORTS or not (reasons or item_alerts):
            continue
        if top_name and top_share is not None and not (china is not None and china >= RISK_MIN_SHARE
                                                       and top_name == "China"):
            reasons.append(f"top source {top_name} ({top_share:.0%})")
        reasons += [f"alert: {t}" for t in item_alerts]
        text = "; ".join(reasons)
        flags.append({"code": it["hs_code"], "hs6": hs6s[0] if len(hs6s) == 1 else None,
                      "item_name": it["item_name"], "stage_id": stage["stage_id"], "stage": stage["name"],
                      "description": it["description"] or frame.by_hs6[hs6s[0]]["description"],
                      "vulnerability_score": vuln, "imports": imports, "dependency_ratio": dep,
                      "china_import_share": china, "top_import_source": top_name,
                      "reason": text[:1].upper() + text[1:]})
    flags.sort(key=lambda f: (-(f["vulnerability_score"] or 0), -(f["imports"] or 0), f["code"]))
    return flags[:MAX_RISK_FLAGS]


def _build_detail(conn: sqlite3.Connection, chain_id: str) -> dict:
    chain = _chain_row(conn, chain_id)
    frame = analytics_frame(conn)
    ministries = _ministry_index(conn)
    year = latest_year(conn)
    hs6s, level = frame.resolve(chain["anchor_hs"])
    agg = aggregate(frame, hs6s)
    suppliers = country_values(conn, "world_suppliers", hs6s, limit=COUNTRY_LIMIT, include_india=True)
    stages = _items_and_stages(conn, chain, frame, ministries)
    codes = chain_codes(conn, chain_id) or [chain["anchor_hs"]]
    item_sources = [i["source"] for s in stages for i in s["items"]]
    return {
        "chain": _chain_meta(chain, ministries),
        "notes": _notes(chain),
        "kpis": _kpis(conn, chain, agg, year),
        "india_rank": _india_rank(conn, hs6s, suppliers),
        "stages": stages,
        "has_tiers": scalar(conn, "SELECT COUNT(*) FROM vc_tiers WHERE chain_id = ?", (chain_id,)) > 0,
        "world_top_suppliers": suppliers,
        "world_top_markets": country_values(conn, "world_markets", hs6s, limit=COUNTRY_LIMIT),
        "india_top_destinations": country_values(conn, "india_partners", hs6s, flow="X", limit=COUNTRY_LIMIT),
        "india_top_sources": country_values(conn, "india_partners", hs6s, flow="M", limit=COUNTRY_LIMIT),
        "top_export_categories": _top_categories(frame, hs6s, agg["exports"]),
        "manufacturers": parse_json(chain.get("manufacturers_json"), []) or [],
        "clusters": _clusters(conn, chain_id),
        "skill_council": _skill_council(conn, chain),
        "schemes": _schemes(conn, codes),
        "risk_flags": _risk_flags(conn, frame, stages),
        "anchor": {"code": chain["anchor_hs"], "trade_level": level if hs6s else None, "n_hs6": agg["n_hs6"],
                   "hs6_codes": hs6s[:60], "rca": agg["rca"]},
        "provenance": {"trade": provenance("tradestat", year=year) if hs6s else provenance(None),
                       "mapping": chain_mapping_provenance(chain, item_sources),
                       "scores": provenance("model", "not_verified", _SCORES_LABEL)},
    }


@router.get("/{chain_id}/tiers", summary="Supplier tiers: how deep the supply chain runs")
def value_chain_tiers(chain_id: str, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    """The chain's supplier tiers (Tier 1 = direct suppliers .. Tier 3 = basic materials).

    Every tier carries the study's definition and example supplier types plus the Atlas's HS-coded
    items, each with the live trade figures of its HS6 line.
    """
    _chain_row(conn, chain_id)  # 404 before touching the cache
    return cached(conn, "vc_tiers", _build_tiers, chain_id)


@router.get("/{chain_id}", summary="Sector deep-dive")
def value_chain(chain_id: str, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    _chain_row(conn, chain_id)  # 404 before touching the cache
    return cached(conn, "vc_detail", _build_detail, chain_id)


# --------------------------------------------------------------------------- mapping table

@router.get("/{chain_id}/mapping", summary="Ministry-wise product mapping table")
def value_chain_mapping(chain_id: str, stage_id: str | None = Query(None, description="Restrict to one stage"),
                        conn: sqlite3.Connection = Depends(get_db)) -> dict:
    chain = _chain_row(conn, chain_id)
    stages = rows(conn, """SELECT stage_id, name, stage_order, ministry_text FROM vc_stages WHERE chain_id = ?
                           ORDER BY stage_order, stage_id""", (chain_id,))
    if stage_id and stage_id not in {s["stage_id"] for s in stages}:
        raise HTTPException(status_code=404, detail=f"Value chain '{chain_id}' has no stage '{stage_id}'")
    ministries = _ministry_index(conn)
    items = _item_rows(conn, chain_id)
    _decorate_items(conn, chain, items, ministries)
    stage_name = {s["stage_id"]: s["name"] for s in stages}
    stage_order = {s["stage_id"]: s["stage_order"] for s in stages}
    data = []
    for it in sorted(items, key=lambda i: (stage_order.get(i["stage_id"], 0), i["item_order"], i["id"])):
        if stage_id and it["stage_id"] != stage_id:
            continue
        data.append({
            "s_no": it["item_order"], "stage_id": it["stage_id"], "stage": stage_name.get(it["stage_id"]),
            "item": it["item_name"], "hs_code": it["hs_code"], "description": it["description"],
            "ministry_text": it["ministry_text"],
            "ministries": [ministries[m] for m in dict.fromkeys(it["ministry_ids"]) if m in ministries],
            "linked_hsn8": it["hsn8"], "source": it["source"], "item_id": it["id"],
            "gst_description": it["gst_description"], "provenance": it["provenance"],
        })
    return {"chain_id": chain_id, "title": chain.get("title") or chain["name"],
            "stages": [{"stage_id": s["stage_id"], "name": s["name"], "order": s["stage_order"],
                        "ministry_text": s["ministry_text"]} for s in stages],
            "rows": data,
            "notes": _notes(chain),
            "provenance": chain_mapping_provenance(chain, [i["source"] for i in items])}
