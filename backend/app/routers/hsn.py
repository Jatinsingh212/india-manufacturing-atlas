"""HSN explorer endpoints (docs/SPEC.md section 6.3). Public.

* ``GET /api/hsn/search``          - faceted, paginated ``ProductSummary`` search (``app.common.search_products``).
* ``GET /api/hsn/suggest?q=``      - top-8 typeahead ``[{hsn8, description, ministry_short}]``.
* ``GET /api/hsn/lookup/{code}``   - 8 digits -> ``{type: "product", product: ProductDetail}``;
  2/4/6 digits -> ``{type: "node", node, children, products (<= 50)}``; 404 otherwise.
* ``GET /api/hsn/product/{hsn8}``  - ``ProductDetail``.
* ``GET /api/hsn/tree?code=``      - children of a node (no code = the 21 sections).
* ``GET /api/hsn/compare?codes=``  - up to 5 lines side by side.

Codes may be typed with dots / spaces (``4011.10.10``). Builders other routers may reuse (stable):
``build_product_detail(conn, hsn8)``, ``build_node_lookup(conn, code)``, ``tree_children(conn, code)``.

Decisions (SPEC leaves them open)
---------------------------------
* ``ProductDetail.ministries`` lists ``product_ministries`` owners, primary first; a residual line (which has
  no owner rows) lists the residual bucket with role ``primary`` so the UI can still render a pill.
* ``trade`` is the HS6-level ``hs6_metrics`` row (``trade_level: "hs6"``), plus the names of the top import
  source / destination; null when the HS6 has no trade data. When BACI reports the heading only as
  ``<hs4>00`` (2710 -> 271000) the row is that aggregate, ``trade_level`` is ``"hs4_aggregate"`` and
  ``metric_hs6`` names the aggregate code used for series, partners and scores.
* ``tariff`` is the WITS MFN row of the HS6 (``mfn_avg`` null = non-ad-valorem / not available) with
  ``bcd_display`` and ``bcd_source`` (``wits`` when a WITS MFN average is shown); null when there is no
  tariff row.
* ``trade_policy`` is the DGFT ITC-HS import / export policy of the 8-digit code from the public portal
  (``dgft_itc_policy``), per direction. A published code without a policy value is ``not_specified``;
  a code absent from the published tables is ``not_listed``. Duplicate portal records are preserved in
  the table and the current one is the last in portal order. Null when the policy dataset is not loaded.
* ``scores`` is null when ``hs6_scores`` has no row for the HS6 (e.g. ``compute_scores`` not run).
* ``value_chains`` / ``upstream`` / ``downstream`` match the curated items / edges on the line's hsn8, hs6 or
  hs4 (self-links dropped); each link carries its ``source`` (``curated`` | ``hs_text``).
* ``production`` lists ``production`` rows scoped to the line's hsn8 / hs6 / hs4 (chain-level figures belong
  to the value-chain page). ``alerts`` (extra) lists the HS6's automated alerts.
* Tree / node trade figures sum distinct HS6 rows under the code; an 8-digit line in the tree shows its HS6
  values (``trade_level: "hs6"``), like ``ProductSummary``. A 6-digit node whose subheading BACI reports only
  as the heading aggregate shows that total with ``trade_level: "hs4_aggregate"`` and the ``metric_hs6`` code.
"""
from __future__ import annotations

import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from app.common import (code_descriptions, country_names, country_values, country_values_hs8, hs6_trade_totals, latest_year,
                        mapping_provenance, ministry_ref, normalize_code, parse_json, product_summaries,
                        provenance, quality_score, search_products, trade_series)
from app.db import get_db, in_json, json_param, row, rows

router = APIRouter(prefix="/api/hsn", tags=["hsn"])

SortParam = Literal["relevance", "exports", "imports", "rca", "code", "world_trade"]
OrderParam = Literal["asc", "desc"]
MappingStatusParam = Literal["accepted", "residual"]
MappingSourceParam = Literal["dpiit_guidebook", "official_upload", "manual", "rule", "unmapped"]

MAX_COMPARE = 5
NODE_PRODUCTS_LIMIT = 50
LINK_LIMIT = 200
_TRADE_FIELDS = ("trade_balance", "rca", "india_world_share", "india_supplier_rank", "n_suppliers",
                 "world_supplier_hhi", "india_import_hhi", "n_import_sources", "top_import_source",
                 "top_import_source_share", "china_import_share", "top_destination", "top_destination_share",
                 "export_cagr", "import_cagr", "world_cagr", "export_yoy", "import_yoy", "world_yoy", "first_year")
_SCORE_FIELDS = ("export_potential_score", "untapped_potential_usd", "import_dependency_score",
                 "vulnerability_score", "substitution_score", "archetype", "ml_cluster",
                 "product_readiness_index", "readiness_tier")


def _bad_request(exc: ValueError) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


# --------------------------------------------------------------------------- product detail

def _hierarchy(conn: sqlite3.Connection, p: dict) -> list[dict]:
    out: list[dict] = []
    if p.get("section_id"):
        s = row(conn, "SELECT id, name FROM sections WHERE id = ?", (p["section_id"],))
        if s:
            out.append({"code": s["id"], "level": 0, "description": s["name"]})
    nodes = {r["code"]: r for r in rows(conn, "SELECT code, level, description FROM hs_nodes WHERE code IN (?, ?, ?)",
                                        (p["hs2"], p["hs4"], p["hs6"]))}
    out.extend(nodes[c] for c in (p["hs2"], p["hs4"], p["hs6"]) if c in nodes)
    return out


def _ministries(conn: sqlite3.Connection, p: dict) -> list[dict]:
    owners = rows(conn, """
        SELECT mi.id, mi.short_name, mi.name, mi.color, pm.role
        FROM product_ministries pm JOIN ministries mi ON mi.id = pm.ministry_id
        WHERE pm.hsn8 = ? ORDER BY pm.role <> 'primary', mi.short_name""", (p["hsn8"],))
    if not any(o["role"] == "primary" for o in owners):
        primary = ministry_ref(conn, p["ministry_id"])
        if primary:
            owners.insert(0, {**primary, "role": "primary"})
    return owners


def _trade(conn: sqlite3.Connection, p: dict) -> dict | None:
    """Official DGCIS 8-digit India trade, with BACI HS6 world/context indicators."""
    m = row(conn, """SELECT vt.*, (SELECT COUNT(*) FROM products p2 WHERE p2.hs4 = vt.hs4) AS heading_lines
                     FROM v_product_trade vt WHERE vt.hsn8 = ?""", (p["hsn8"],))
    if not m or not m.get("metric_hs6"):
        return None
    level = m.get("trade_level") or "hs6"
    names = country_names(conn, [m.get("top_import_source"), m.get("top_destination")])
    trade = {"year": m["year"], "exports": m["india_exports"], "imports": m["india_imports"],
             "world_trade": m["world_trade"], "world_trade_source": "baci"}
    trade.update({k: m.get(k) for k in _TRADE_FIELDS})
    label = None
    if level == "hs8":
        label = (f"DGFT/DGCIS TRADESTAT FY{m['year']}-{str(m['year'] + 1)[-2:]} "
                 f"(this 8-digit line); world trade: CEPII BACI {m['year']} HS6")
    elif level == "hs4_aggregate":
        label = (f"DGFT/DGCIS TRADESTAT FY{m['year']}-{str(m['year'] + 1)[-2:]} "
                 f"(heading aggregate {m['metric_hs6']} for HS {m['hs4']}, {m['heading_lines']} national lines); "
                 f"world trade: CEPII BACI {m['year']}")
    elif level == "hs6":
        label = (f"DGFT/DGCIS TRADESTAT FY{m['year']}-{str(m['year'] + 1)[-2:]} "
                 f"(HS6 subheading {m['metric_hs6']}; this national line is not published separately); "
                 f"world trade: CEPII BACI {m['year']}")
    trade.update({
        "top_import_source_name": names.get(m.get("top_import_source")),
        "top_destination_name": names.get(m.get("top_destination")),
        "trade_level": level, "lines_in_hs6": p["lines_in_hs6"],
        "metric_hs6": m["metric_hs6"],
        "hs6_exports": m.get("hs6_india_exports"), "hs6_imports": m.get("hs6_india_imports"),
        "heading_lines": m["heading_lines"] if level == "hs4_aggregate" else None,
        "destination_level": "hs8" if level == "hs8" and m["india_exports"] is not None else "hs6",
        "source_level": "hs8" if level == "hs8" and m["india_imports"] is not None else "hs6",
        "provenance": provenance("tradestat", "verified", label, m["year"]),
    })
    return trade


def _tariff(conn: sqlite3.Connection, p: dict) -> dict | None:
    """The WITS MFN row and the displayed BCD (WITS applied average)."""
    t = row(conn, "SELECT mfn_avg, mfn_min, mfn_max, n_lines, n_na_lines, year, source FROM tariffs WHERE hs6 = ?",
            (p["hs6"],))
    if not t:
        return None
    bcd_source = "wits" if t["mfn_avg"] is not None else None
    status = "verified" if t["mfn_avg"] is not None else "not_available"
    label = None if t["mfn_avg"] is not None else (
        "WITS MFN: non-ad-valorem duty (no ad-valorem average)" if (t.get("n_na_lines") or 0) > 0
        else "Not available")
    return {
        "mfn_avg": t["mfn_avg"], "mfn_min": t["mfn_min"], "mfn_max": t["mfn_max"], "n_lines": t["n_lines"],
        "n_na_lines": t["n_na_lines"], "non_ad_valorem": bool(t["mfn_avg"] is None and (t["n_na_lines"] or 0) > 0),
        "year": t["year"], "bcd_display": p["bcd_display"], "bcd_source": bcd_source,
        "provenance": provenance("wits" if t["source"] or t["mfn_avg"] is not None else None,
                                 status, label, t["year"]),
        "bcd_provenance": provenance("wits", year=t["year"]) if bcd_source == "wits" else provenance(None),
    }


def _trade_policy_direction(conn: sqlite3.Connection, hsn8: str, direction: str) -> dict:
    """Current DGFT ITC-HS policy for one direction, with an explicit not-listed / not-specified state."""
    record = row(conn, """
        SELECT description, policy, policy_condition, itc_code_type, notification_no,
               notification_date, notification_date_iso, source_url, fetched_at
        FROM dgft_itc_policy
        WHERE itc_code = ? AND direction = ? AND is_current = 1
        ORDER BY record_index DESC LIMIT 1""", (hsn8, direction))
    if not record:
        return {
            "status": "not_listed", "policy": None, "condition": None, "itc_type": None,
            "notification_no": None, "notification_date": None, "notification_date_iso": None,
            "description": None, "n_records": 0,
            "provenance": provenance("dgft_itc_hs", "not_available",
                                     f"Not listed in the DGFT ITC-HS {direction} policy table"),
        }
    count = row(conn, "SELECT COUNT(*) AS n FROM dgft_itc_policy WHERE itc_code = ? AND direction = ?",
                (hsn8, direction))
    policy = record["policy"] or None
    notification = record["notification_no"]
    if policy:
        label = f"DGFT ITC-HS {direction} policy: {policy}"
        if notification:
            label += f" (notification {notification})"
        status, prov = "specified", provenance("dgft_itc_hs", "verified", label)
    else:
        status, prov = "not_specified", provenance(
            "dgft_itc_hs", "not_available",
            f"DGFT ITC-HS: no {direction} policy specified for this code")
    return {
        "status": status,
        "policy": policy,
        "condition": record["policy_condition"] or None,
        "itc_type": record["itc_code_type"] or None,
        "notification_no": notification or None,
        "notification_date": record["notification_date"] or None,
        "notification_date_iso": record["notification_date_iso"] or None,
        "description": record["description"] or None,
        "n_records": int(count["n"]) if count else 1,
        "provenance": prov,
    }


def _trade_policy(conn: sqlite3.Connection, hsn8: str) -> dict | None:
    """DGFT ITC-HS import / export policy of the line (public portal), or None if not loaded.

    A code absent from the published tables is ``not_listed``; a published code whose policy
    field is empty is ``not_specified``. Neither is replaced by a rule or a parent policy.
    """
    try:
        dataset = row(conn, """SELECT MAX(fetched_at) AS fetched_at, MAX(source_url) AS source_url
                               FROM dgft_itc_policy""")
    except sqlite3.OperationalError:  # database built before the DGFT policy step existed
        return None
    if not dataset or not dataset.get("fetched_at"):
        return None
    fetched_at = dataset["fetched_at"]
    return {
        "import": _trade_policy_direction(conn, hsn8, "import"),
        "export": _trade_policy_direction(conn, hsn8, "export"),
        "chapter": hsn8[:2],
        "source": "dgft_itc_hs",
        "source_url": dataset.get("source_url") or "https://www.dgft.gov.in/CP/?opt=itchs-import-export",
        "fetched_at": fetched_at,
        "provenance": provenance("dgft_itc_hs", "verified",
                                 f"DGFT public ITC-HS policy, fetched {fetched_at[:10]}"),
    }


def _scores(conn: sqlite3.Connection, hs6: str) -> dict | None:
    s = row(conn, "SELECT * FROM hs6_scores WHERE hs6 = ?", (hs6,))
    if not s:
        return None
    forecast = parse_json(s.get("forecast_json"), None)
    if not isinstance(forecast, dict):
        forecast = {}
    out = {k: s.get(k) for k in _SCORE_FIELDS}
    out["forecast"] = {"exports": forecast.get("exports") or [], "imports": forecast.get("imports") or []}
    out["provenance"] = provenance("model", "not_verified", "Model estimate · Atlas analytical model (derived from official trade and policy data)")
    return out


def _value_chains(conn: sqlite3.Connection, p: dict) -> list[dict]:
    data = rows(conn, """
        SELECT i.chain_id, vc.name, i.stage_id, s.name AS stage_name, i.item_name
        FROM vc_items i
        JOIN value_chains vc ON vc.id = i.chain_id
        LEFT JOIN vc_stages s ON s.chain_id = i.chain_id AND s.stage_id = i.stage_id
        WHERE i.hsn8 = ? OR i.hs_code IN (?, ?, ?)
        ORDER BY vc.sort_order, vc.id, s.stage_order, i.item_order""",
                (p["hsn8"], p["hsn8"], p["hs6"], p["hs4"]))
    out: dict[tuple[str, str], dict] = {}
    for r in data:
        key = (r["chain_id"], r["stage_id"])
        entry = out.setdefault(key, {"chain_id": r["chain_id"], "name": r["name"], "stage_id": r["stage_id"],
                                     "stage_name": r["stage_name"] or r["stage_id"], "items": []})
        if r["item_name"] and r["item_name"] not in entry["items"]:
            entry["items"].append(r["item_name"])
    return list(out.values())


def _links(conn: sqlite3.Connection, p: dict) -> tuple[list[dict], list[dict]]:
    """(upstream, downstream) edges touching the line's hsn8, hs6 or hs4."""
    codes = (p["hsn8"], p["hs6"], p["hs4"])
    up = rows(conn, f"""SELECT src AS code, relation, chain_id, source FROM vc_edges
                        WHERE dst IN (?, ?, ?) AND src NOT IN (?, ?, ?)
                        ORDER BY source = 'hs_text', chain_id, src LIMIT {LINK_LIMIT}""", codes + codes)
    down = rows(conn, f"""SELECT dst AS code, relation, chain_id, source FROM vc_edges
                          WHERE src IN (?, ?, ?) AND dst NOT IN (?, ?, ?)
                          ORDER BY source = 'hs_text', chain_id, dst LIMIT {LINK_LIMIT}""", codes + codes)

    def dedupe(items: list[dict]) -> list[dict]:
        seen, out = set(), []
        for it in items:
            key = (it["code"], it["relation"], it["chain_id"])
            if key not in seen:
                seen.add(key)
                out.append(it)
        return out

    up, down = dedupe(up), dedupe(down)
    names = code_descriptions(conn, [it["code"] for it in up + down])
    for it in up + down:
        it["description"] = names.get(it["code"])
    return up, down


def _schemes(conn: sqlite3.Connection, hsn8: str) -> list[dict]:
    data = rows(conn, """
        SELECT s.id, s.name, s.kind, s.ministry_id, sp.hs_prefix AS prefix, sp.note
        FROM scheme_products sp JOIN schemes s ON s.id = sp.scheme_id
        WHERE ? GLOB sp.hs_prefix || '*'
        ORDER BY s.kind, s.name, length(sp.hs_prefix) DESC""", (hsn8,))
    seen, out = set(), []
    for r in data:
        if r["id"] not in seen:
            seen.add(r["id"])
            out.append(r)
    return out


def _production(conn: sqlite3.Connection, p: dict) -> list[dict]:
    return rows(conn, """
        SELECT year, value, unit, label, source, status, scope, key FROM production
        WHERE (scope = 'hsn8' AND key = ?) OR (scope = 'hs6' AND key = ?) OR (scope = 'hs4' AND key = ?)
        ORDER BY year DESC, scope""", (p["hsn8"], p["hs6"], p["hs4"]))


def _alerts(conn: sqlite3.Connection, hs6: str) -> list[dict]:
    return rows(conn, """SELECT id, kind, severity, title, detail, value, created_at FROM alerts WHERE hs6 = ?
                         ORDER BY severity = 'high' DESC, created_at DESC""", (hs6,))


def _top_countries(conn: sqlite3.Connection, trade: dict | None, hsn8: str, hs6: str | None,
                   flow: str) -> list[dict]:
    """Official HS8 partner list for the line, else the HS6 subheading list (labelled by the UI)."""
    if hs6 is None:
        return []
    level = (trade or {}).get("destination_level" if flow == "X" else "source_level")
    if level == "hs8":
        hs8_partners = country_values_hs8(conn, hsn8, flow)
        if hs8_partners:
            return hs8_partners
    return country_values(conn, "india_partners", [hs6], flow=flow, limit=10)


def build_product_detail(conn: sqlite3.Connection, hsn8: str) -> dict | None:
    """The full ``ProductDetail`` of an 8-digit line (SPEC 6.3), or None when the line does not exist."""
    code = normalize_code(hsn8)
    summaries = product_summaries(conn, "p.hsn8 = ?", (code,), limit=1,
                                  extra_select="p.section_id AS _section_id, p.mapping_rule AS _mapping_rule")
    if not summaries:
        return None
    p = summaries[0]
    section_id = p.pop("_section_id")
    mapping_rule = p.pop("_mapping_rule")
    hs6 = p["hs6"]
    trade = _trade(conn, p)
    metric_hs6 = trade["metric_hs6"] if trade else None
    tariff = _tariff(conn, p)
    production = _production(conn, p)
    upstream, downstream = _links(conn, p)
    detail = {
        **p,
        "hierarchy": _hierarchy(conn, {**p, "section_id": section_id}),
        "ministries": _ministries(conn, p),
        "mapping": {"status": p["mapping_status"], "source": p["mapping_source"],
                    "confidence": p["mapping_confidence"], "rule": mapping_rule,
                    "provenance": mapping_provenance(p["mapping_source"], mapping_rule, p["mapping_status"])},
        "parent_ownership": _parent_ownership_hint(conn, code) if p["mapping_status"] == "residual" else None,
        "trade": trade,
        "series": trade_series(conn, [metric_hs6], hsn8=code) if metric_hs6 else [],
        "tariff": tariff,
        "trade_policy": _trade_policy(conn, code),
        "top_destinations": _top_countries(conn, trade, code, metric_hs6, "X"),
        "top_sources": _top_countries(conn, trade, code, metric_hs6, "M"),
        "world_top_suppliers": country_values(conn, "world_suppliers", [metric_hs6], limit=10, include_india=True)
        if metric_hs6 else [],
        "world_top_markets": country_values(conn, "world_markets", [metric_hs6], limit=10)
        if metric_hs6 else [],
        "scores": _scores(conn, metric_hs6) if metric_hs6 else None,
        "value_chains": _value_chains(conn, p),
        "upstream": upstream,
        "downstream": downstream,
        "schemes": _schemes(conn, code),
        "production": production,
        "siblings": rows(conn, """
            SELECT p.hsn8, p.description, mi.short_name AS ministry_short
            FROM products p LEFT JOIN ministries mi ON mi.id = p.ministry_id
            WHERE p.hs6 = ? AND p.hsn8 <> ? ORDER BY p.hsn8""", (hs6, code)),
        "alerts": _alerts(conn, metric_hs6) if metric_hs6 else [],
    }
    has_trade = bool(trade) and any(trade.get(k) is not None for k in ("exports", "imports", "world_trade"))
    has_tariff = bool(tariff) and tariff["mfn_avg"] is not None
    detail["product_readiness_index"] = (detail.get("scores") or {}).get("product_readiness_index")
    detail["readiness_tier"] = (detail.get("scores") or {}).get("readiness_tier")
    detail["data_quality_score"] = quality_score(p["mapping_status"], p["mapping_source"], has_trade, has_tariff,
                                                 bool(production))
    return detail


# --------------------------------------------------------------------------- nodes and tree

def _ownership_summaries(conn: sqlite3.Connection, length: int,
                         prefix: str | None = None) -> dict[str, dict]:
    """Guidebook ownership aggregated from 8-digit lines to a 2/4/6-digit prefix.

    The DPIIT Guidebook accepts 8-digit codes. At chapter/heading/subheading level the Atlas
    therefore reports the owners of the accepted lines *under* the code, plus how many lines are
    covered, rather than inventing a code-level acceptance. ``owners`` is ordered by the number of
    directly-primary lines, then by all owned lines; the first owner is the leading owner.
    """
    if length not in (2, 4, 6):
        raise ValueError("ownership summaries are defined for 2, 4 or 6 digits")
    where = "p.hsn8 GLOB ?" if prefix else "1=1"
    params: tuple = (prefix + "*",) if prefix else ()
    totals = rows(conn, f"""
        SELECT substr(p.hsn8, 1, {length}) AS prefix,
               COUNT(*) AS total_lines,
               SUM(CASE WHEN p.mapping_status = 'accepted' THEN 1 ELSE 0 END) AS mapped_lines
        FROM products p
        WHERE {where}
        GROUP BY prefix""", params)
    owner_rows = rows(conn, f"""
        SELECT substr(p.hsn8, 1, {length}) AS prefix,
               pm.ministry_id AS id, mi.short_name, mi.name, mi.color,
               SUM(CASE WHEN pm.role = 'primary' THEN 1 ELSE 0 END) AS n_primary,
               COUNT(*) AS n_lines
        FROM product_ministries pm
        JOIN products p ON p.hsn8 = pm.hsn8
        JOIN ministries mi ON mi.id = pm.ministry_id
        WHERE {where}
        GROUP BY prefix, pm.ministry_id
        ORDER BY prefix, n_primary DESC, n_lines DESC, pm.ministry_id""", params)

    out: dict[str, dict] = {}
    for t in totals:
        total = t["total_lines"] or 0
        mapped = t["mapped_lines"] or 0
        out[t["prefix"]] = {
            "total_lines": total,
            "mapped_lines": mapped,
            "residual_lines": total - mapped,
            "coverage": round(mapped / total, 4) if total else 0.0,
            "n_owners": 0,
            "owners": [],
            "source": "dpiit_guidebook",
            "method": "aggregated_from_8_digit_lines",
        }
    for o in owner_rows:
        summary = out.get(o["prefix"])
        if summary is None:
            continue
        summary["owners"].append({
            "id": o["id"], "short_name": o["short_name"], "name": o["name"], "color": o["color"],
            "role": "primary" if not summary["owners"] else "secondary",
            "n_primary": o["n_primary"], "n_lines": o["n_lines"],
            "share": round(o["n_lines"] / summary["mapped_lines"], 4) if summary["mapped_lines"] else None,
        })
    for summary in out.values():
        summary["n_owners"] = len(summary["owners"])
    return out


def _parent_ownership_hint(conn: sqlite3.Connection, code: str) -> dict | None:
    """Nearest 6/4/2-digit parent with one accepted owner and >=50% line coverage.

    This is a research hint for a residual 8-digit line, never an official assignment: the line
    itself is absent from the Guidebook's accepted table, so its status stays residual.
    """
    if len(code) != 8:
        return None
    for length in (6, 4, 2):
        parent = code[:length]
        summary = _ownership_summaries(conn, length, parent).get(parent)
        if not summary or not summary["mapped_lines"] or summary["coverage"] < 0.5:
            continue
        primary = [o for o in summary["owners"] if o["n_primary"] > 0]
        if len(primary) != 1:
            continue
        return {"level": length, "parent_code": parent, "owner": primary[0], **summary}
    return None


def _counts_by_prefix(conn: sqlite3.Connection, code: str, length: int) -> dict[str, int]:
    return {r["c"]: r["n"] for r in rows(conn, f"""
        SELECT substr(hsn8, 1, {length}) AS c, COUNT(*) AS n FROM products WHERE hsn8 GLOB ? GROUP BY c""",
                                          (code + "*",))}


def _trade_by_prefix(conn: sqlite3.Connection, code: str, length: int) -> dict[str, dict]:
    return {r["c"]: r for r in rows(conn, f"""
        SELECT substr(hs6, 1, {length}) AS c, SUM(india_exports) AS exports, SUM(india_imports) AS imports,
               SUM(world_trade) AS world_trade
        FROM hs6_metrics WHERE hs6 GLOB ? GROUP BY c""", (code + "*",))}


def _node_hierarchy(conn: sqlite3.Connection, node: dict) -> list[dict]:
    code = node["code"]
    prefixes = [code[:n] for n in (2, 4, 6) if n <= len(code)]
    found = {r["code"]: r for r in rows(conn, f"SELECT code, level, description FROM hs_nodes WHERE {in_json('code')}",
                                        (json_param(prefixes),))}
    out = []
    s = row(conn, "SELECT id, name FROM sections WHERE id = ?", (node["section_id"],))
    if s:
        out.append({"code": s["id"], "level": 0, "description": s["name"]})
    out.extend(found[c] for c in prefixes if c in found)
    return out


def build_node_lookup(conn: sqlite3.Connection, code: str) -> dict | None:
    """``{type: "node", node, children, products}`` for a 2/4/6-digit HS node, or None if unknown."""
    node = row(conn, "SELECT code, level, description, parent, section_id FROM hs_nodes WHERE code = ?", (code,))
    if not node:
        return None
    ownership = _ownership_summaries(conn, len(code), code).get(code)
    if node["level"] < 6:
        children = rows(conn, "SELECT code, level, description FROM hs_nodes WHERE parent = ? ORDER BY code",
                        (code,))
        counts = _counts_by_prefix(conn, code, node["level"] + 2)
        child_ownership = _ownership_summaries(conn, node["level"] + 2, code)
        for c in children:
            c["n_products"] = counts.get(c["code"], 0)
            if c["code"] in child_ownership:
                c["ownership"] = child_ownership[c["code"]]
    else:
        children = rows(conn, "SELECT hsn8 AS code, 8 AS level, description, 1 AS n_products FROM products "
                              "WHERE hs6 = ? ORDER BY hsn8", (code,))
    totals = hs6_trade_totals(conn, [r["hs6"] for r in rows(conn, "SELECT hs6 FROM hs6_metrics WHERE hs6 GLOB ?",
                                                            (code + "*",))])
    trade_level = {2: "hs2", 4: "hs4", 6: "hs6"}[node["level"]]
    metric_hs6 = None
    if node["level"] == 6 and not totals["n_hs6"]:
        # BACI reports a few headings only as <hs4>00 (2710 -> 271000); the subheading inherits that total.
        aggregate = row(conn, """SELECT hs6, india_exports, india_imports, world_trade FROM hs6_metrics
                                 WHERE hs6 = ?""", (code[:4] + "00",))
        if aggregate:
            totals = {"exports": aggregate["india_exports"], "imports": aggregate["india_imports"],
                      "world_trade": aggregate["world_trade"], "n_hs6": 1}
            trade_level, metric_hs6 = "hs4_aggregate", aggregate["hs6"]
    n_products = sum(_counts_by_prefix(conn, code, len(code)).values())
    node.update({"n_products": n_products, "hierarchy": _node_hierarchy(conn, node),
                 "ownership": ownership,
                 "trade": {**totals, "trade_level": trade_level, "metric_hs6": metric_hs6,
                           "provenance": provenance("tradestat", year=latest_year(conn)) if totals["n_hs6"]
                           else provenance(None)}})
    products = product_summaries(conn, "p.hsn8 GLOB ?", (code + "*",), "p.hsn8", limit=NODE_PRODUCTS_LIMIT)
    return {"type": "node", "node": node, "children": children, "products": products}


def tree_children(conn: sqlite3.Connection, code: str | None) -> list[dict] | None:
    """Children of ``code`` for the explorer tree (None = unknown code). See SPEC 6.3 ``/api/hsn/tree``."""
    if not code:
        counts = {r["section_id"]: r["n"] for r in rows(conn, """
            SELECT c.section_id, COUNT(*) AS n FROM products p
            JOIN hs_nodes c ON c.code = p.hs2 AND c.level = 2 GROUP BY c.section_id""")}
        trade = {r["section_id"]: r for r in rows(conn, """
            SELECT c.section_id, SUM(m.india_exports) AS exports, SUM(m.india_imports) AS imports
            FROM hs6_metrics m JOIN hs_nodes c ON c.code = substr(m.hs6, 1, 2) AND c.level = 2
            GROUP BY c.section_id""")}
        with_chapters = {r["section_id"] for r in rows(conn, "SELECT DISTINCT section_id FROM hs_nodes "
                                                             "WHERE level = 2")}
        return [{"code": s["id"], "level": 0, "description": s["name"], "num": s["num"],
                 "n_products": counts.get(s["id"], 0), "exports": trade.get(s["id"], {}).get("exports"),
                 "imports": trade.get(s["id"], {}).get("imports"), "has_children": s["id"] in with_chapters}
                for s in rows(conn, "SELECT id, num, name FROM sections ORDER BY num")]

    section = row(conn, "SELECT id FROM sections WHERE id = ?", (code.upper(),))
    if section:
        chapters = rows(conn, "SELECT code, level, description FROM hs_nodes WHERE level = 2 AND section_id = ? "
                              "ORDER BY code", (section["id"],))
        counts = {r["hs2"]: r["n"] for r in rows(conn, "SELECT hs2, COUNT(*) AS n FROM products GROUP BY hs2")}
        trade = {r["c"]: r for r in rows(conn, """SELECT substr(hs6, 1, 2) AS c, SUM(india_exports) AS exports,
                                                         SUM(india_imports) AS imports
                                                  FROM hs6_metrics GROUP BY c""")}
        ownership = _ownership_summaries(conn, 2)
        return [{**c, "n_products": counts.get(c["code"], 0), "exports": trade.get(c["code"], {}).get("exports"),
                 "imports": trade.get(c["code"], {}).get("imports"), "has_children": True,
                 "ownership": ownership.get(c["code"])} for c in chapters]

    if not code.isdigit():
        return None
    if len(code) == 8:
        return [] if row(conn, "SELECT 1 AS x FROM products WHERE hsn8 = ?", (code,)) else None
    node = row(conn, "SELECT code, level FROM hs_nodes WHERE code = ?", (code,))
    if not node:
        return None
    if node["level"] == 6:
        m = row(conn, "SELECT hs6, india_exports, india_imports FROM hs6_metrics WHERE hs6 = ?", (code,))
        metric_hs6, trade_level = code, "hs6"
        if not m:
            metric_hs6 = code[:4] + "00"
            m = row(conn, "SELECT hs6, india_exports, india_imports FROM hs6_metrics WHERE hs6 = ?", (metric_hs6,))
            trade_level = "hs4_aggregate" if m else "hs6"
        m = m or {}
        lines = rows(conn, """SELECT p.hsn8 AS code, p.description, p.mapping_status, p.lines_in_hs6,
                                     mi.short_name AS ministry_short
                              FROM products p LEFT JOIN ministries mi ON mi.id = p.ministry_id
                              WHERE p.hs6 = ? ORDER BY p.hsn8""", (code,))
        return [{"code": r["code"], "level": 8, "description": r["description"], "n_products": 1,
                 "exports": m.get("india_exports"), "imports": m.get("india_imports"), "has_children": False,
                 "trade_level": trade_level, "metric_hs6": metric_hs6 if m else None,
                 "ministry_short": r["ministry_short"],
                 "mapping_status": r["mapping_status"], "lines_in_hs6": r["lines_in_hs6"]} for r in lines]

    children = rows(conn, "SELECT code, level, description FROM hs_nodes WHERE parent = ? ORDER BY code", (code,))
    length = node["level"] + 2
    counts = _counts_by_prefix(conn, code, length)
    trade = _trade_by_prefix(conn, code, length)
    if length == 4:
        grand = {r["parent"] for r in rows(conn, "SELECT DISTINCT parent FROM hs_nodes WHERE parent GLOB ?",
                                           (code + "*",))}
    else:
        grand = set()
    ownership = _ownership_summaries(conn, length, code)
    out = []
    for c in children:
        n = counts.get(c["code"], 0)
        rec = trade.get(c["code"])
        trade_level = ("hs4" if length == 4 else "hs6") if rec else None
        metric_hs6 = c["code"] if rec else None
        if rec is None and length == 6:
            # 6-digit subheading whose trade BACI reports only as the heading aggregate (<hs4>00).
            agg_code = c["code"][:4] + "00"
            agg = row(conn, """SELECT hs6, india_exports AS exports, india_imports AS imports
                               FROM hs6_metrics WHERE hs6 = ?""", (agg_code,))
            if agg:
                rec, trade_level, metric_hs6 = agg, "hs4_aggregate", agg["hs6"]
        out.append({**c, "n_products": n, "exports": (rec or {}).get("exports"),
                    "imports": (rec or {}).get("imports"), "trade_level": trade_level,
                    "metric_hs6": metric_hs6,
                    "has_children": (c["code"] in grand) if length == 4 else n > 0,
                    "ownership": ownership.get(c["code"])})
    return out


# --------------------------------------------------------------------------- endpoints

@router.get("/search", summary="Search 8-digit lines by code prefix, text and facets")
def search(
    q: str | None = Query(None, max_length=200, description="Code prefix (dots/spaces ignored) or free text"),
    ministry_id: str | None = None,
    sector_id: str | None = None,
    chapter: str | None = Query(None, description="2-digit chapter(s), comma-separated"),
    mapping_status: MappingStatusParam | None = None,
    mapping_source: MappingSourceParam | None = None,
    min_exports: float | None = Query(None, ge=0, description="US$, HS6 level"),
    min_imports: float | None = Query(None, ge=0, description="US$, HS6 level"),
    rca_min: float | None = Query(None, ge=0),
    rca_max: float | None = Query(None, ge=0),
    prefix: str | None = Query(None, max_length=12, description="Restrict to a code prefix, e.g. 4011"),
    sort: SortParam = "relevance",
    order: OrderParam | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    try:
        return search_products(conn, q=q, ministry_id=ministry_id, sector_id=sector_id, chapter=chapter,
                               mapping_status=mapping_status, mapping_source=mapping_source,
                               min_exports=min_exports, min_imports=min_imports, rca_min=rca_min, rca_max=rca_max,
                               prefix=prefix, sort=sort, order=order, page=page, page_size=page_size)
    except ValueError as exc:
        raise _bad_request(exc) from exc


@router.get("/suggest", summary="Typeahead: top matches for a code or text")
def suggest(q: str = Query("", max_length=200), limit: int = Query(8, ge=1, le=20),
            conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    if not q.strip():
        return []
    result = search_products(conn, q=q, page=1, page_size=limit)
    return [{"hsn8": r["hsn8"], "description": r["description"], "ministry_short": r["ministry_short"],
             "ministry_id": r["ministry_id"], "mapping_status": r["mapping_status"]} for r in result["items"]]


@router.get("/lookup/{code}", summary="Look up an 8-digit line (product) or a 2/4/6-digit HS node")
def lookup(code: str, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    norm = normalize_code(code)
    if norm.isdigit() and len(norm) == 8:
        detail = build_product_detail(conn, norm)
        if detail:
            return {"type": "product", "product": detail}
        raise HTTPException(status_code=404, detail=f"No Indian 8-digit tariff line {norm}")
    if norm.isdigit() and len(norm) in (2, 4, 6):
        result = build_node_lookup(conn, norm)
        if result:
            return result
        raise HTTPException(status_code=404, detail=f"No HS2022 node {norm}")
    raise HTTPException(status_code=404, detail="Enter a 2, 4, 6 or 8-digit HS code")


@router.get("/product/{hsn8}", summary="Everything about one 8-digit line (ProductDetail)")
def product(hsn8: str, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    norm = normalize_code(hsn8)
    if not (norm.isdigit() and len(norm) == 8):
        raise HTTPException(status_code=404,
                            detail="A product is an 8-digit line; use /api/hsn/lookup/{code} for 2/4/6 digits")
    detail = build_product_detail(conn, norm)
    if not detail:
        raise HTTPException(status_code=404, detail=f"No Indian 8-digit tariff line {norm}")
    return detail


@router.get("/tree", summary="HS tree: children of a section / chapter / heading / subheading")
def tree(code: str | None = Query(None, max_length=12), conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    norm = normalize_code(code) if code else None
    result = tree_children(conn, norm)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Unknown HS code or section '{code}'")
    return result


@router.get("/compare", summary="Compare up to 5 lines (summary + trend + growth)")
def compare(codes: str = Query(..., description="Comma-separated 8-digit codes (max 5)"),
            conn: sqlite3.Connection = Depends(get_db)) -> dict:
    wanted = list(dict.fromkeys(normalize_code(c) for c in codes.split(",") if c.strip()))
    if not wanted:
        raise HTTPException(status_code=400, detail="Give 1 to 5 comma-separated 8-digit codes")
    if len(wanted) > MAX_COMPARE:
        raise HTTPException(status_code=400, detail=f"At most {MAX_COMPARE} codes can be compared")
    bad = [c for c in wanted if not (c.isdigit() and len(c) == 8)]
    if bad:
        raise HTTPException(status_code=400, detail=f"Not 8-digit codes: {', '.join(bad)}")
    found = {r["hsn8"]: r for r in product_summaries(
        conn, in_json("p.hsn8"), (json_param(wanted),), limit=None,
        extra_select="m.india_world_share, m.export_cagr, m.import_cagr, m.world_cagr")}
    if not found:
        raise HTTPException(status_code=404, detail="None of the codes is an Indian 8-digit tariff line")
    items = []
    for c in wanted:
        if c in found:
            item = found[c]
            item["series"] = trade_series(conn, [item["hs6"]])
            items.append(item)
    return {"items": items, "not_found": [c for c in wanted if c not in found]}


__all__ = ["router", "build_product_detail", "build_node_lookup", "tree_children"]
