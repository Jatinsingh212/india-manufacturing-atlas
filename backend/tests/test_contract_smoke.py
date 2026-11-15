"""Contract smoke test: every endpoint function of ``frontend/src/api/client.ts`` against the real database.

For each ``api.<fn>`` in client.ts this module calls the backend path with representative parameters under the
role the frontend uses (public / industry / analyst / ministry / admin via ``POST /api/auth/demo-login``), asserts
a 2xx status and checks the *top-level keys* the frontend types in ``frontend/src/api/types.ts`` expect.

It is deliberately shallow (presence of keys, not values) so it catches the class of bug that unit tests miss:
a field renamed on one side of the contract. Deeper behaviour is covered by the per-area test modules.

Read-only calls use the session ``client`` (real ``data/atlas.db``); every mutating call uses
``module_mutable_client`` (a private copy), so the real database is never changed.

Real ids used: products 61091000 / 40111010, ministries mot / dpiit, chain tyre / natural_rubber, sector textiles,
partner asare (UAE), agreement ind_uae_cepa, scheme pli_textiles, data source cbic, ticket 1 / 2, roadmap item
p0_architecture, risk 1.
"""
from __future__ import annotations

import io
import re

import pytest

PRODUCT = "61091000"
PRODUCT_TYRE = "40111010"
MINISTRY = "mot"
MINISTRY_2 = "dpiit"
CHAIN = "tyre"
CHAIN_2 = "natural_rubber"
SECTOR = "textiles"
PARTNER = "asare"
AGREEMENT = "ind_uae_cepa"
SCHEME = "pli_textiles"
SOURCE_NOT_CONFIGURED = "cbic"

# --------------------------------------------------------------------------- expected top-level keys (types.ts)

PRODUCT_SUMMARY = {
    "hsn8", "hs6", "hs4", "hs2", "description", "full_description", "ministry_id", "ministry_short",
    "ministry_name", "sector_id", "sector_name", "mapping_status", "mapping_source", "mapping_confidence",
    "exports", "imports", "world_trade", "rca", "mfn_tariff", "bcd_display", "lines_in_hs6", "trade_level",
}
MINISTRY_REF = {"id", "short_name", "name", "color"}
COUNTRY_VALUE = {"country_id", "country", "iso3", "value", "share", "rank"}
PROVENANCE = {"source", "status", "label", "year"}
PAGINATED = {"items", "total", "page", "page_size"}
USER = {"id", "email", "name", "role", "ministry_id", "organisation"}
AUTH = {"access_token", "token_type", "user"}
HS6_ITEM = {"hs6", "description", "hsn8_sample", "ministry_id", "ministry_short", "sector_id", "sector_name"}
ENTITY_DASHBOARD = {
    "kpis", "chapter_mix", "top_exports", "top_imports", "dependency_hotspots", "opportunities", "value_chains",
    "schemes", "trend",
}
ENTITY_KPIS = {
    "codes", "accepted", "secondary_codes", "exports", "imports", "trade_balance", "world_trade", "sectors_covered",
    "chains_involved", "open_tickets", "pending_claims",
}
ALERT = {"id", "kind", "hs6", "description", "severity", "title", "detail", "value", "created_at"}
TICKET = {
    "id", "hsn8", "subject", "body", "category", "submitter_name", "submitter_org", "submitter_email",
    "submitted_by", "routed_ministry_id", "status", "created_at", "updated_at",
}
TICKET_MESSAGE = {"id", "ticket_id", "author_id", "author_name", "author_role", "body", "ts"}
CLAIM = {
    "id", "hsn8", "description", "ministry", "claimed_by_name", "justification", "status", "created_at",
    "reviewed_at", "review_note",
}
DATA_SOURCE = {
    "id", "name", "owner", "kind", "status", "last_refreshed", "records", "url", "licence", "description",
    "refresh_cron",
}
JOB = {"id", "source_id", "started_at", "finished_at", "status", "records", "message", "triggered_by"}
UPLOAD = {"id", "kind", "filename", "uploaded_by", "ts", "status", "rows_total", "rows_valid", "applied_at"}
ADMIN_USER = {"id", "email", "name", "role", "ministry_id", "organisation", "active", "is_demo", "created_at"}
AUDIT = {"id", "ts", "user_id", "user_email", "action", "entity", "entity_id"}
ROADMAP_ITEM = {
    "id", "phase", "workstream", "title", "description", "start_month", "end_month", "status", "owner",
    "platform_route", "sort_order",
}
RISK_ROW = {"id", "area", "risk", "mitigation", "likelihood", "impact", "status", "owner", "platform_control"}
SCHEME_ITEM = {
    "id", "name", "kind", "ministry", "outlay_crore", "launched", "description", "url", "n_products", "exports",
    "imports", "source",
}
AGREEMENT_ROW = {
    "id", "name", "short_name", "partners", "status", "year", "url", "notes", "india_exports_to",
    "india_imports_from",
}
VC_LIST_ITEM = {
    "id", "name", "title", "anchor_hs", "lead_ministry", "description", "n_stages", "n_items", "india_exports",
    "world_trade", "india_share",
}
NETWORK_NODE = {
    "id", "code", "label", "description", "level", "ministry_id", "ministry_short", "color", "sector_id", "exports",
    "imports", "world_trade", "rca", "vulnerability_score", "production", "chain_ids", "stage_id", "is_center",
}
NETWORK_EDGE = {"id", "source", "target", "relation", "chain_id", "source_kind"}
TREE_NODE = {"code", "level", "description", "n_products", "exports", "imports", "has_children"}
VC_ITEM = {
    "id", "item_name", "hs_code", "hsn8", "description", "ministry_text", "ministries", "exports", "imports", "rca",
    "mfn_tariff", "linked",
}
VC_STAGE = {"stage_id", "name", "order", "ministry_text", "ministries", "items"}
VC_KPI = {"key", "label", "value", "unit", "year", "provenance"}
MAPPING_ROW = {"s_no", "stage_id", "stage", "item", "hs_code", "description", "ministry_text", "linked_hsn8"}


# --------------------------------------------------------------------------- helpers

def ok(response, expect=(200, 201)):
    assert response.status_code in expect, f"{response.request.method} {response.url} -> {response.status_code}: {response.text[:400]}"
    return response


def keys(obj, expected, where="response"):
    assert isinstance(obj, dict), f"{where}: expected an object, got {type(obj).__name__}: {str(obj)[:200]}"
    missing = set(expected) - set(obj)
    assert not missing, f"{where}: missing keys {sorted(missing)}; got {sorted(obj)}"
    return obj


def first(items, where="list"):
    assert isinstance(items, list), f"{where}: expected a list, got {type(items).__name__}"
    assert items, f"{where}: expected a non-empty list"
    return items[0]


def as_list(data):
    """client.ts asList(): a plain list or {items: [...]}."""
    return data if isinstance(data, list) else data.get("items", [])


def as_page(data):
    """client.ts asPage(): a plain list becomes an envelope."""
    if isinstance(data, list):
        return {"items": data, "total": len(data), "page": 1, "page_size": len(data)}
    return data


# =========================================================================== 6.1 system / auth

def test_health(client):
    body = keys(ok(client.get("/api/health")).json(), {"status", "built_at", "latest_year", "products", "db_path"})
    assert body["status"] == "ok"


def test_me_public_and_signed_in(client, admin_headers):
    anon = keys(ok(client.get("/api/auth/me")).json(), USER)
    assert anon["role"] == "public" and anon["id"] is None
    me = keys(ok(client.get("/api/auth/me", headers=admin_headers)).json(), USER)
    assert me["role"] == "admin"


@pytest.mark.parametrize("role", ["admin", "ministry", "analyst", "industry"])
def test_demo_login(module_mutable_client, role):
    body = keys(ok(module_mutable_client.post("/api/auth/demo-login", json={"role": role})).json(), AUTH)
    assert body["token_type"] == "bearer"
    keys(body["user"], USER, "user")
    assert body["user"]["role"] == role


def test_login_with_password(module_mutable_client, db_conn):
    import json
    from pathlib import Path
    seed = json.loads((Path(__file__).resolve().parents[1] / "data" / "curated" / "ops_seed.json").read_text("utf-8"))
    body = ok(module_mutable_client.post("/api/auth/login",
                                         json={"email": "analyst@atlas.gov.in", "password": seed["demo_password"]})).json()
    keys(body, AUTH)
    keys(body["user"], USER, "user")


def test_register(module_mutable_client):
    body = ok(module_mutable_client.post("/api/auth/register", json={
        "email": "smoke-register@example.com", "password": "Smoke-Test-2026!", "name": "Smoke Tester",
        "organisation": "Smoke Industries"})).json()
    keys(body, AUTH)
    assert body["user"]["role"] == "industry"


# =========================================================================== 6.2 meta

def test_overview(client):
    body = keys(ok(client.get("/api/meta/overview")).json(), {
        "kpis", "distribution_by_ministry", "sector_distribution", "mapping_sources", "data_freshness", "provenance"})
    keys(body["kpis"], {"total_codes", "accepted_codes", "residual_codes", "ministries_assigned", "sectors",
                        "hs6_with_trade", "india_exports", "india_imports", "world_trade", "latest_year"}, "kpis")
    keys(first(body["distribution_by_ministry"]), {"ministry_id", "short_name", "name", "color", "codes", "exports", "imports"})
    keys(first(body["sector_distribution"]), {"sector_id", "name", "color", "codes", "exports", "imports"})
    keys(first(body["mapping_sources"]), {"source", "codes"})
    keys(first(body["data_freshness"]), {"source_id", "name", "last_refreshed"})
    keys(body["provenance"]["trade"], PROVENANCE, "provenance.trade")
    keys(body["provenance"]["mapping"], PROVENANCE, "provenance.mapping")


def test_meta_lists(client):
    m = first(ok(client.get("/api/meta/ministries")).json())
    keys(m, {"id", "short_name", "name", "parent_ministry", "kind", "website", "color", "codes", "accepted", "exports", "imports"})
    s = first(ok(client.get("/api/meta/sectors")).json())
    keys(s, {"id", "name", "description", "color", "icon", "codes", "exports", "imports"})
    sec = first(ok(client.get("/api/meta/sections")).json())
    keys(sec, {"id", "num", "name", "chapters"})
    keys(first(sec["chapters"]), {"code", "description", "codes"})
    keys(first(ok(client.get("/api/meta/countries")).json()), {"id", "iso3", "name", "continent"})
    card = keys(first(ok(client.get("/api/meta/info")).json()), {"id", "title", "icon", "body_md", "links"})
    assert isinstance(card["links"], list)


# =========================================================================== 6.3 HSN

def test_search_products(client):
    body = keys(ok(client.get("/api/hsn/search", params={"q": "cotton", "sort": "exports", "order": "desc",
                                                         "page": 1, "page_size": 10})).json(), PAGINATED)
    keys(first(body["items"]), PRODUCT_SUMMARY)
    faceted = ok(client.get("/api/hsn/search", params={"ministry_id": MINISTRY, "sector_id": SECTOR, "chapter": "61",
                                                       "mapping_status": "accepted", "mapping_source": "rule",
                                                       "min_exports": 1, "rca_min": 0.1, "rca_max": 50,
                                                       "sort": "rca"})).json()
    keys(faceted, PAGINATED)


def test_suggest(client):
    keys(first(ok(client.get("/api/hsn/suggest", params={"q": "tyre"})).json()), {"hsn8", "description", "ministry_short"})


def test_lookup_product_and_node(client):
    body = ok(client.get(f"/api/hsn/lookup/{PRODUCT}")).json()
    assert body["type"] == "product"
    keys(body["product"], PRODUCT_SUMMARY | {"hierarchy", "trade"}, "product")
    node = ok(client.get("/api/hsn/lookup/4011")).json()
    assert node["type"] == "node"
    keys(node, {"node", "children", "products"})
    keys(node["node"], {"code", "level", "description", "parent", "section_id"}, "node")
    keys(first(node["children"]), {"code", "level", "description", "n_products"})
    keys(first(node["products"]), PRODUCT_SUMMARY)


@pytest.mark.parametrize("hsn8", [PRODUCT, PRODUCT_TYRE])
def test_product_detail(client, hsn8):
    body = keys(ok(client.get(f"/api/hsn/product/{hsn8}")).json(), PRODUCT_SUMMARY | {
        "hierarchy", "ministries", "mapping", "trade", "series", "tariff", "top_destinations",
        "top_sources", "world_top_suppliers", "world_top_markets", "scores", "value_chains", "upstream", "downstream",
        "schemes", "production", "siblings", "data_quality_score"})
    keys(first(body["hierarchy"]), {"code", "level", "description"})
    keys(first(body["ministries"]), MINISTRY_REF | {"role"})
    keys(body["mapping"], {"status", "source", "confidence", "rule", "provenance"}, "mapping")
    keys(body["trade"], {"year", "exports", "imports", "world_trade", "trade_balance", "rca", "india_world_share",
                         "india_supplier_rank", "n_suppliers", "world_supplier_hhi", "india_import_hhi",
                         "top_import_source", "top_import_source_share", "china_import_share", "export_cagr",
                         "import_cagr", "world_cagr", "export_yoy", "import_yoy", "trade_level", "lines_in_hs6",
                         "provenance"}, "trade")
    keys(first(body["series"]), {"year", "exports", "imports", "world_trade"})
    keys(body["tariff"], {"mfn_avg", "mfn_min", "mfn_max", "n_lines", "year", "bcd_display", "provenance"}, "tariff")
    keys(first(body["top_destinations"]), COUNTRY_VALUE)
    keys(first(body["world_top_suppliers"]), COUNTRY_VALUE)
    keys(body["scores"], {"export_potential_score", "untapped_potential_usd", "import_dependency_score",
                          "vulnerability_score", "substitution_score", "archetype", "ml_cluster", "forecast"}, "scores")
    keys(body["scores"]["forecast"], {"exports", "imports"}, "forecast")
    assert isinstance(body["siblings"], list)  # 610910 has a single national line -> no siblings
    for s in body["siblings"]:
        keys(s, {"hsn8", "description", "ministry_short"}, "sibling")
    assert "playbook" not in body
    for link in body["upstream"] + body["downstream"]:
        keys(link, {"code", "description", "relation", "chain_id"}, "link")
    for vc in body["value_chains"]:
        keys(vc, {"chain_id", "name", "stage_id", "stage_name"}, "value_chain")
    for s in body["schemes"]:
        keys(s, {"id", "name", "kind"}, "scheme")
    for p in body["production"]:
        keys(p, {"year", "value", "unit", "label", "source", "status"}, "production")


def test_tree_levels(client):
    sections = ok(client.get("/api/hsn/tree")).json()
    keys(first(sections), TREE_NODE)
    chapters = ok(client.get("/api/hsn/tree", params={"code": sections[0]["code"]})).json()
    keys(first(chapters), TREE_NODE)
    lines = ok(client.get("/api/hsn/tree", params={"code": "610910"})).json()
    assert first(lines)["level"] == 8


def test_compare(client):
    body = ok(client.get("/api/hsn/compare", params={"codes": f"{PRODUCT},{PRODUCT_TYRE}"})).json()
    item = keys(first(body["items"]), PRODUCT_SUMMARY | {"series", "india_world_share", "export_cagr", "import_cagr"})
    keys(first(item["series"]), {"year", "exports", "imports"})


# =========================================================================== 6.4 ministries & sectors

def test_ministry_dashboard(client):
    body = keys(ok(client.get(f"/api/ministries/{MINISTRY}")).json(), ENTITY_DASHBOARD | {"ministry", "sector_mix"})
    keys(body["ministry"], MINISTRY_REF | {"parent_ministry", "kind", "website"}, "ministry")
    keys(body["kpis"], ENTITY_KPIS, "kpis")
    keys(first(body["sector_mix"]), {"sector_id", "name", "color", "codes", "exports", "imports"})
    keys(first(body["chapter_mix"]), {"hs2", "description", "codes", "exports", "imports"})
    keys(first(body["top_exports"]), PRODUCT_SUMMARY)
    keys(first(body["dependency_hotspots"]), PRODUCT_SUMMARY | {"vulnerability_score", "top_import_source",
                                                                 "top_import_source_share", "china_import_share"})
    keys(first(body["opportunities"]), PRODUCT_SUMMARY | {"export_potential_score", "untapped_potential_usd", "archetype"})
    keys(first(body["value_chains"]), {"chain_id", "name", "stages"})
    keys(first(body["trend"]), {"year", "exports", "imports"})


def test_ministry_products(client):
    body = keys(ok(client.get(f"/api/ministries/{MINISTRY}/products", params={"q": "cotton", "sort": "imports",
                                                                               "order": "desc", "page": 1,
                                                                               "page_size": 5})).json(), PAGINATED)
    keys(first(body["items"]), PRODUCT_SUMMARY)


def test_sector_dashboard_and_products(client):
    body = keys(ok(client.get(f"/api/sectors/{SECTOR}")).json(), ENTITY_DASHBOARD | {"sector", "ministry_mix"})
    keys(body["sector"], {"id", "name", "description", "color", "icon"}, "sector")
    keys(body["kpis"], ENTITY_KPIS, "kpis")
    keys(first(body["ministry_mix"]), {"ministry_id", "short_name", "name", "color", "codes", "exports", "imports"})
    page = keys(ok(client.get(f"/api/sectors/{SECTOR}/products", params={"page_size": 5})).json(), PAGINATED)
    keys(first(page["items"]), PRODUCT_SUMMARY)


# =========================================================================== 6.5 value chains & network

def test_value_chains_list(client):
    item = keys(first(ok(client.get("/api/valuechains")).json()), VC_LIST_ITEM)
    keys(item["lead_ministry"], MINISTRY_REF, "lead_ministry")


@pytest.mark.parametrize("chain_id", [CHAIN, CHAIN_2])
def test_value_chain_detail(client, chain_id):
    body = keys(ok(client.get(f"/api/valuechains/{chain_id}")).json(), {
        "chain", "kpis", "india_rank", "stages", "world_top_suppliers", "world_top_markets", "india_top_destinations",
        "india_top_sources", "top_export_categories", "manufacturers", "clusters", "skill_council", "schemes",
        "risk_flags"})
    keys(body["chain"], {"id", "name", "title", "anchor_hs", "description", "phase", "source", "lead_ministry"}, "chain")
    kpi = keys(first(body["kpis"]), VC_KPI)
    keys(kpi["provenance"], PROVENANCE, "kpi.provenance")
    assert [k["key"] for k in body["kpis"]][:6] == ["global_production", "india_production", "global_exports",
                                                     "india_exports", "india_share", "india_imports"]
    keys(body["india_rank"], {"rank", "n_suppliers", "text"}, "india_rank")
    stage = keys(first(body["stages"]), VC_STAGE)
    item = keys(first(stage["items"]), VC_ITEM)
    for m in item["ministries"]:
        keys(m, MINISTRY_REF, "item.ministry")
    keys(first(body["world_top_suppliers"]), COUNTRY_VALUE)
    keys(first(body["top_export_categories"]), {"code", "label", "value"})
    for m in body["manufacturers"]:
        keys(m, {"name", "url"}, "manufacturer")
    for c in body["clusters"]:
        keys(c, {"id", "name", "state", "district", "products", "lat", "lon"}, "cluster")
    for r in body["risk_flags"]:
        keys(r, {"code", "description", "vulnerability_score", "reason"}, "risk_flag")
    if body["skill_council"] is not None:
        keys(body["skill_council"], {"name", "url"}, "skill_council")


def test_value_chain_mapping(client):
    body = keys(ok(client.get(f"/api/valuechains/{CHAIN}/mapping")).json(), {"chain_id", "title", "rows"})
    keys(first(body["rows"]), MAPPING_ROW)
    stage_id = body["rows"][0]["stage_id"]
    filtered = ok(client.get(f"/api/valuechains/{CHAIN}/mapping", params={"stage_id": stage_id})).json()
    assert filtered["rows"] and all(r["stage_id"] == stage_id for r in filtered["rows"])


def test_network_and_trace(client):
    body = keys(ok(client.get("/api/network", params={"chain_id": CHAIN, "center": PRODUCT_TYRE, "depth": 2,
                                                      "include_parts": "false"})).json(), {"nodes", "edges", "stats"})
    keys(first(body["nodes"]), NETWORK_NODE)
    keys(first(body["edges"]), NETWORK_EDGE)
    keys(body["stats"], {"n_nodes", "n_edges", "chains"}, "stats")
    # 40111010 is not curated in the tyre chain (its sibling 40111090 is): the centre must still be connected
    assert any(n["is_center"] and n["code"] == PRODUCT_TYRE for n in body["nodes"])
    assert any(PRODUCT_TYRE in (e["source"], e["target"]) for e in body["edges"])
    keys(ok(client.get("/api/network")).json(), {"nodes", "edges", "stats"})
    trace = keys(ok(client.get(f"/api/network/trace/{PRODUCT_TYRE}", params={"direction": "both", "depth": 3})).json(),
                 {"nodes", "edges", "stats", "critical_inputs"})
    for ci in trace["critical_inputs"]:
        keys(ci, {"code", "description", "vulnerability_score", "imports", "top_import_source", "reason"}, "critical_input")


# =========================================================================== 6.6 analytics (GOV)

def test_analytics_public_is_denied(client):
    assert client.get("/api/analytics/opportunities").status_code in (401, 403)


def test_opportunities(client, analyst_headers):
    body = keys(ok(client.get("/api/analytics/opportunities", params={"ministry_id": MINISTRY, "limit": 20},
                              headers=analyst_headers)).json(), {"items", "matrix", "summary"})
    keys(first(body["items"]), HS6_ITEM | {"india_exports", "world_trade", "rca", "world_cagr", "export_cagr",
                                           "export_potential_score", "untapped_potential_usd", "archetype",
                                           "india_world_share"})
    keys(first(body["matrix"]), {"hs6", "label", "x", "y", "size", "archetype"})
    keys(body["summary"], {"total_untapped_usd", "n_products"}, "summary")


def test_import_dependency(client, analyst_headers):
    body = keys(ok(client.get("/api/analytics/import-dependency", params={"sector_id": SECTOR, "limit": 20},
                              headers=analyst_headers)).json(), {"items", "by_source_country", "summary"})
    keys(first(body["items"]), HS6_ITEM | {"india_imports", "india_exports", "dependency_ratio", "india_import_hhi",
                                           "top_import_source", "top_import_source_name", "top_import_source_share",
                                           "china_import_share", "import_dependency_score", "vulnerability_score"})
    keys(first(body["by_source_country"]), {"country_id", "country", "imports", "n_products"})
    keys(body["summary"], {"total_imports", "china_share"}, "summary")


def test_import_substitution(client, ministry_headers):
    body = keys(ok(client.get("/api/analytics/import-substitution", params={"chain_id": CHAIN, "limit": 20},
                              headers=ministry_headers)).json(), {"items", "summary"})
    item = keys(first(body["items"]), HS6_ITEM | {"india_imports", "india_exports", "rca", "world_supplier_hhi",
                                                  "mfn_tariff", "substitution_score", "schemes"})
    assert isinstance(item["schemes"], list)


def test_competitiveness(client, analyst_headers):
    body = keys(ok(client.get("/api/analytics/competitiveness", params={"chapter": "61"}, headers=analyst_headers)).json(),
                {"histogram", "by_sector", "top_rca", "summary"})
    keys(first(body["histogram"]), {"bucket", "count", "exports"})
    keys(first(body["by_sector"]), {"sector_id", "name", "rca_weighted", "n_rca_gt1", "exports"})
    keys(first(body["top_rca"]), HS6_ITEM | {"india_exports", "world_trade", "rca"})
    keys(body["summary"], {"n_rca_gt1", "exports_rca_gt1_share"}, "summary")


def test_demand_supply(client, analyst_headers):
    body = keys(ok(client.get("/api/analytics/demand-supply", params={"chain_id": CHAIN}, headers=analyst_headers)).json(),
                {"items"})
    item = keys(first(body["items"]), {"code", "description", "production", "unit", "imports", "exports",
                                       "apparent_consumption", "self_sufficiency", "provenance"})
    keys(item["provenance"], PROVENANCE, "provenance")
    keys(ok(client.get("/api/analytics/demand-supply", params={"sector_id": SECTOR}, headers=analyst_headers)).json(), {"items"})


def test_archetypes(client, analyst_headers):
    body = keys(ok(client.get("/api/analytics/archetypes", headers=analyst_headers)).json(), {"archetypes", "clusters"})
    keys(first(body["archetypes"]), {"name", "n", "exports", "imports", "examples"})
    cl = keys(first(body["clusters"]), {"id", "n", "centroid", "label", "examples"})
    keys(first(cl["examples"]), {"hs6", "description"})


@pytest.mark.parametrize("code", ["610910", PRODUCT])
def test_forecast(client, analyst_headers, code):
    body = keys(ok(client.get(f"/api/analytics/forecast/{code}", headers=analyst_headers)).json(),
                {"code", "description", "history", "forecast", "method"})
    keys(first(body["history"]), {"year", "exports", "imports"})
    keys(body["forecast"], {"exports", "imports"}, "forecast")
    keys(first(body["forecast"]["exports"]), {"year", "value", "lo", "hi"})


@pytest.mark.parametrize("params", [{"level": "total"}, {"level": "ministry", "id": MINISTRY},
                                    {"level": "sector", "id": SECTOR}, {"level": "chapter", "id": "40"}])
def test_trends(client, analyst_headers, params):
    body = keys(ok(client.get("/api/analytics/trends", params=params, headers=analyst_headers)).json(), {"series"})
    keys(first(body["series"]), {"year", "exports", "imports", "world_trade"})


def test_anomalies(client, analyst_headers):
    items = as_list(ok(client.get("/api/analytics/anomalies", params={"severity": "high", "limit": 10},
                                  headers=analyst_headers)).json())
    keys(first(items), ALERT)


# =========================================================================== 6.7 policy

def test_use_cases(client):
    item = keys(first(ok(client.get("/api/policy/use-cases")).json()), {"id", "title", "description", "question", "route", "metrics"})
    assert isinstance(item["metrics"], list)


def test_schemes_and_detail(client):
    all_schemes = ok(client.get("/api/policy/schemes")).json()
    keys(first(all_schemes), SCHEME_ITEM)
    pli = ok(client.get("/api/policy/schemes", params={"kind": "PLI"})).json()
    assert pli and all(s["kind"] == "PLI" for s in pli)
    qco = ok(client.get("/api/policy/schemes", params={"kind": "QCO"})).json()
    assert qco and all(s["kind"] == "QCO" for s in qco)
    detail = keys(ok(client.get(f"/api/policy/schemes/{SCHEME}")).json(), {"scheme", "kpis", "products", "top_dependencies"})
    keys(detail["scheme"], SCHEME_ITEM, "scheme")
    keys(detail["kpis"], {"n_products", "exports", "imports", "trade_balance", "avg_rca"}, "kpis")
    keys(first(detail["products"]), PRODUCT_SUMMARY)
    for d in detail["top_dependencies"]:
        keys(d, PRODUCT_SUMMARY | {"vulnerability_score", "top_import_source", "top_import_source_share",
                                   "china_import_share"}, "top_dependency")


def test_agreements(client):
    row = keys(first(ok(client.get("/api/policy/agreements")).json()), AGREEMENT_ROW)
    keys(first(row["partners"]), {"id", "name"})


@pytest.mark.parametrize("params", [{"partner": PARTNER}, {"agreement": AGREEMENT}])
def test_negotiation(client, analyst_headers, params):
    body = keys(ok(client.get("/api/policy/negotiation", params=params, headers=analyst_headers)).json(),
                {"partners", "bilateral", "offensive", "defensive", "summary"})
    keys(first(body["partners"]), {"id", "name"})
    keys(body["bilateral"], {"india_exports_to", "india_imports_from", "balance", "top_exports", "top_imports"}, "bilateral")
    keys(first(body["bilateral"]["top_exports"]), {"hs6", "description", "value"})
    keys(first(body["offensive"]), {"hs6", "description", "partner_imports_world", "india_exports_to_partner",
                                    "india_rca", "gap_usd", "india_mfn"})
    keys(first(body["defensive"]), {"hs6", "description", "india_imports_from_partner", "partner_rca", "india_rca",
                                    "india_mfn", "reason"})
    keys(body["summary"], {"n_offensive", "n_defensive", "total_gap_usd"}, "summary")


def test_simulate_tariff(client, analyst_headers):
    body = keys(ok(client.post("/api/policy/simulate-tariff", headers=analyst_headers,
                               json={"codes": [PRODUCT_TYRE, "400110"], "new_tariff_pct": 25, "elasticity": 2.5,
                                     "substitution_share": 0.5, "input_cost_share": 0.1})).json(),
                {"results", "downstream", "totals", "assumptions"})
    keys(first(body["results"]), {"code", "hs6", "description", "tariff_before", "tariff_after", "imports_before",
                                  "imports_after", "delta_imports", "revenue_before", "revenue_after",
                                  "domestic_opportunity_usd"})
    for d in body["downstream"]:
        keys(d, {"code", "description", "via", "cost_increase_pct"}, "downstream")
    keys(body["totals"], {"imports_before", "imports_after", "delta_imports", "revenue_before", "revenue_after",
                          "domestic_opportunity_usd"}, "totals")
    keys(body["assumptions"], {"elasticity", "substitution_share", "input_cost_share", "formula"}, "assumptions")


@pytest.mark.parametrize("params", [{}, {"chain_id": CHAIN}, {"sector_id": SECTOR}])
def test_skilling(client, params):
    keys(first(ok(client.get("/api/policy/skilling", params=params)).json()), {"id", "name", "url", "sectors", "chains"})


# =========================================================================== 6.8 risk (GOV)

def test_risk_overview(client, ministry_headers):
    body = keys(ok(client.get("/api/risk/overview", headers=ministry_headers)).json(),
                {"kpis", "top_vulnerable", "by_sector", "by_source_country", "alerts"})
    keys(body["kpis"], {"high_risk_products", "imports_at_risk_usd", "china_dependent_imports_usd", "concentrated_products"}, "kpis")
    keys(first(body["top_vulnerable"]), HS6_ITEM | {"vulnerability_score", "top_import_source_name", "china_import_share"})
    keys(first(body["by_sector"]), {"sector_id", "name", "avg_vulnerability", "imports_at_risk"})
    keys(first(body["by_source_country"]), {"country_id", "country", "imports_at_risk", "n_products"})
    keys(first(body["alerts"]), ALERT)
    assert len(body["alerts"]) <= 20
    keys(ok(client.get("/api/risk/overview", params={"sector_id": SECTOR}, headers=ministry_headers)).json(), {"kpis"})


def test_risk_alerts(client, analyst_headers):
    items = as_list(ok(client.get("/api/risk/alerts", params={"kind": "import_surge", "severity": "high", "limit": 5},
                                  headers=analyst_headers)).json())
    keys(first(items), ALERT)
    assert all(a["kind"] == "import_surge" and a["severity"] == "high" for a in items)


# =========================================================================== 6.9 residual workbench

def test_residual_list_and_suggest(client, ministry_headers):
    body = keys(ok(client.get("/api/residual", params={"q": "other", "page": 1, "page_size": 10},
                              headers=ministry_headers)).json(), PAGINATED)
    row = keys(first(body["items"]), PRODUCT_SUMMARY | {"pending_claims"})
    sugg = keys(ok(client.get(f"/api/residual/suggest/{row['hsn8']}", headers=ministry_headers)).json(), {"hsn8", "suggestions"})
    s = keys(first(sugg["suggestions"]), {"ministry", "score", "similar"})
    keys(s["ministry"], MINISTRY_REF, "suggestion.ministry")
    for sim in s["similar"]:
        keys(sim, {"hsn8", "description"}, "similar")


def test_residual_claim_flow(module_mutable_client, auth_headers):
    mc = module_mutable_client
    hsn8 = "09030000"  # residual line without a seeded claim
    claim = keys(ok(mc.post(f"/api/residual/{hsn8}/claim", headers=auth_headers("ministry", MINISTRY),
                            json={"ministry_id": MINISTRY, "justification": "Smoke-test claim"})).json(), CLAIM)
    keys(claim["ministry"], MINISTRY_REF, "claim.ministry")
    pending = as_list(ok(mc.get("/api/residual/claims", params={"status": "pending"}, headers=auth_headers("admin"))).json())
    keys(first(pending), CLAIM)
    assert any(c["id"] == claim["id"] for c in pending)
    keys(as_list(ok(mc.get("/api/residual/claims", headers=auth_headers("analyst"))).json())[0], CLAIM)
    reviewed = ok(mc.post(f"/api/residual/claims/{claim['id']}/review", headers=auth_headers("admin"),
                          json={"decision": "approve", "note": "Smoke-test approval"})).json()
    # client.ts types the review response as ResidualClaim; the backend wraps it as {claim, product, ...}.
    claim_obj = reviewed.get("claim", reviewed)
    keys(claim_obj, CLAIM, "review.claim")
    assert claim_obj["status"] == "approved"
    product = ok(mc.get(f"/api/hsn/product/{hsn8}")).json()
    assert product["mapping_status"] == "accepted" and product["ministry_id"] == MINISTRY


# =========================================================================== 6.10 helpdesk

def test_ticket_route_preview(client):
    body = keys(ok(client.get("/api/tickets/route", params={"hsn8": PRODUCT})).json(), {"routed_ministry", "reason", "product"})
    keys(body["routed_ministry"], MINISTRY_REF, "routed_ministry")


def test_ticket_flow(module_mutable_client, auth_headers):
    mc = module_mutable_client
    created = keys(ok(mc.post("/api/tickets", json={
        "hsn8": PRODUCT, "subject": "Smoke-test query", "body": "Which BCD applies?", "category": "tariff",
        "submitter_name": "Smoke Tester", "submitter_org": "Smoke Industries", "submitter_email": "smoke@example.com",
    })).json(), {"ticket", "routed_ministry"})
    keys(created["ticket"], TICKET, "ticket")
    keys(created["routed_ministry"], MINISTRY_REF, "routed_ministry")
    assert created["ticket"]["routed_ministry_id"] == MINISTRY

    mine = keys(ok(mc.post("/api/tickets", headers=auth_headers("industry"), json={
        "subject": "Signed-in query", "body": "General question", "category": "other"})).json(), {"ticket", "routed_ministry"})
    assert mine["ticket"]["submitted_by"] is not None

    page = as_page(ok(mc.get("/api/tickets", params={"status": "open", "page": 1}, headers=auth_headers("industry"))).json())
    keys(page, PAGINATED)
    keys(first(page["items"]), TICKET)
    routed = as_page(ok(mc.get("/api/tickets", headers=auth_headers("ministry", MINISTRY))).json())
    assert routed["items"] and all(t["routed_ministry_id"] == MINISTRY for t in routed["items"])
    all_tickets = as_page(ok(mc.get("/api/tickets", headers=auth_headers("admin"))).json())
    assert all_tickets["total"] >= 7

    detail = keys(ok(mc.get("/api/tickets/2", headers=auth_headers("admin"))).json(), {"ticket", "messages", "product"})
    keys(detail["ticket"], TICKET, "ticket")
    keys(first(detail["messages"]), TICKET_MESSAGE)
    keys(detail["product"], PRODUCT_SUMMARY, "product")

    reply = keys(ok(mc.post("/api/tickets/2/messages", headers=auth_headers("ministry", MINISTRY),
                            json={"body": "Smoke-test reply"})).json(), {"message", "ticket"})
    assert keys(reply["message"], TICKET_MESSAGE, "message")["ticket_id"] == 2
    keys(reply["ticket"], TICKET, "ticket")
    updated = keys(ok(mc.post("/api/tickets/2/status", headers=auth_headers("ministry", MINISTRY),
                              json={"status": "resolved"})).json(), {"ticket"})
    assert keys(updated["ticket"], TICKET, "ticket")["status"] == "resolved"
    forwarded = ok(mc.post("/api/tickets/2/status", headers=auth_headers("admin"),
                           json={"status": "open", "routed_ministry_id": MINISTRY_2})).json()
    assert forwarded["ticket"]["routed_ministry_id"] == MINISTRY_2
    stats = keys(ok(mc.get("/api/tickets/stats", headers=auth_headers("analyst"))).json(),
                 {"by_status", "by_ministry", "avg_resolution_hours"})
    keys(first(stats["by_status"]), {"status", "n"})
    keys(first(stats["by_ministry"]), {"ministry_id", "n"})


# =========================================================================== 6.11 data hub

def test_data_sources_public(client):
    keys(first(ok(client.get("/api/datahub/sources")).json()), DATA_SOURCE)


def test_refresh_and_jobs(module_mutable_client, auth_headers):
    mc = module_mutable_client
    body = keys(ok(mc.post(f"/api/datahub/sources/{SOURCE_NOT_CONFIGURED}/refresh", headers=auth_headers("admin"))).json(), {"job"})
    keys(body["job"], JOB, "job")
    jobs = as_list(ok(mc.get("/api/datahub/jobs", headers=auth_headers("analyst"))).json())
    keys(first(jobs), JOB)
    assert any(j["id"] == body["job"]["id"] for j in jobs)


def test_upload_apply_and_list(module_mutable_client, auth_headers):
    mc = module_mutable_client
    csv = f"hsn8,ministry_id\n{PRODUCT_TYRE},{MINISTRY_2}\n25169090,mot\n99999999,mot\n".encode()
    body = keys(ok(mc.post("/api/datahub/upload", headers=auth_headers("admin"), data={"kind": "ministry_mapping"},
                           files={"file": ("mapping.csv", io.BytesIO(csv), "text/csv")})).json(),
                {"upload", "preview", "errors"})
    keys(body["upload"], UPLOAD, "upload")
    assert isinstance(body["preview"], list) and body["preview"]
    assert body["errors"] and keys(body["errors"][0], {"row", "error"}, "error")
    applied = keys(ok(mc.post(f"/api/datahub/uploads/{body['upload']['id']}/apply", headers=auth_headers("admin"))).json(), {"upload"})
    assert applied["upload"]["status"] == "applied"
    uploads = as_list(ok(mc.get("/api/datahub/uploads", headers=auth_headers("ministry", MINISTRY))).json())
    keys(first(uploads), UPLOAD)
    product = ok(mc.get(f"/api/hsn/product/{PRODUCT_TYRE}")).json()
    assert product["mapping_source"] == "official_upload" and product["ministry_id"] == MINISTRY_2


@pytest.mark.parametrize("kind", ["ministry_mapping", "production", "value_chain_edges"])
def test_upload_template(client, ministry_headers, kind):
    response = ok(client.get(f"/api/datahub/templates/{kind}", headers=ministry_headers))
    assert "text/csv" in response.headers.get("content-type", "")
    assert "attachment" in response.headers.get("content-disposition", "")
    assert response.text.splitlines()[0].count(",") >= 1


def test_quality(client, analyst_headers):
    body = keys(ok(client.get("/api/datahub/quality", headers=analyst_headers)).json(),
                {"coverage", "by_ministry", "cross_checks", "quality_histogram"})
    keys(body["coverage"], {"products", "with_trade", "with_tariff", "with_production",
                            "mapping_rule", "mapping_official", "mapping_manual", "residual"}, "coverage")
    keys(first(body["by_ministry"]), {"ministry_id", "short_name", "codes", "with_trade_pct", "verified_pct", "avg_quality"})
    keys(first(body["quality_histogram"]), {"bucket", "count"})
    for c in body["cross_checks"]:
        keys(c, {"hs6", "year", "flow", "comtrade_value", "baci_value", "diff_pct"}, "cross_check")


# =========================================================================== 6.12 reports

def _disposition_name(response) -> str:
    cd = response.headers.get("content-disposition", "")
    assert cd.startswith("attachment"), cd
    m = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)"?', cd)
    assert m, cd
    return m.group(1)


@pytest.mark.parametrize("kind,entity,fmt,role", [
    ("product", PRODUCT, "pdf", None), ("product", PRODUCT_TYRE, "csv", None), ("product", PRODUCT, "xlsx", None),
    ("ministry", MINISTRY, "xlsx", None), ("ministry", MINISTRY_2, "pdf", None),
    ("valuechain", CHAIN, "pdf", None), ("valuechain", CHAIN_2, "csv", None),
    ("sector", SECTOR, "csv", "industry"), ("sector", SECTOR, "pdf", "industry"),
])
def test_reports(client, auth_headers, kind, entity, fmt, role):
    headers = auth_headers(role) if role else {}
    response = ok(client.get(f"/api/reports/{kind}/{entity}", params={"format": fmt}, headers=headers))
    assert _disposition_name(response).endswith(f".{fmt}")
    assert len(response.content) > 100
    if fmt == "pdf":
        assert response.content.startswith(b"%PDF")


@pytest.mark.parametrize("fmt", ["csv", "xlsx"])
def test_search_report(client, industry_headers, fmt):
    response = ok(client.get("/api/reports/search", params={"q": "tyre", "ministry_id": MINISTRY_2, "sort": "exports",
                                                            "format": fmt}, headers=industry_headers))
    assert _disposition_name(response).endswith(f".{fmt}")
    assert client.get("/api/reports/search", params={"format": fmt}).status_code == 401


# =========================================================================== 6.13 admin, roadmap, risks, watchlist

def test_admin_users_flow(module_mutable_client, auth_headers):
    mc = module_mutable_client
    users = as_list(ok(mc.get("/api/admin/users", headers=auth_headers("admin"))).json())
    u = keys(first(users), ADMIN_USER)
    assert "password_hash" not in u
    created = keys(ok(mc.post("/api/admin/users", headers=auth_headers("admin"), json={
        "email": "smoke-user@atlas.gov.in", "password": "Smoke-Pass-2026!", "name": "Smoke Ministry User",
        "role": "ministry", "ministry_id": MINISTRY_2, "organisation": "DPIIT"})).json(), ADMIN_USER)
    updated = keys(ok(mc.patch(f"/api/admin/users/{created['id']}", headers=auth_headers("admin"),
                               json={"name": "Smoke Renamed", "active": False, "role": "analyst", "ministry_id": None})).json(), ADMIN_USER)
    assert updated["name"] == "Smoke Renamed" and not updated["active"] and updated["role"] == "analyst"
    assert mc.get("/api/admin/users", headers=auth_headers("analyst")).status_code == 403


def test_audit(module_mutable_client, auth_headers):
    page = as_page(ok(module_mutable_client.get("/api/admin/audit", params={"page": 1, "page_size": 10},
                                                headers=auth_headers("admin"))).json())
    keys(page, PAGINATED)
    keys(first(page["items"]), AUDIT)
    filtered = as_page(ok(module_mutable_client.get("/api/admin/audit", params={"action": "login.demo"},
                                                    headers=auth_headers("admin"))).json())
    assert all(e["action"] == "login.demo" for e in filtered["items"])


def test_roadmap_and_update(client, module_mutable_client, auth_headers):
    body = keys(ok(client.get("/api/roadmap")).json(), {"phases", "progress"})
    phase = keys(first(body["phases"]), {"phase", "label", "months", "items"})
    keys(first(phase["items"]), ROADMAP_ITEM)
    keys(body["progress"], {"done", "in_progress", "planned", "pct"}, "progress")
    item = keys(ok(module_mutable_client.patch("/api/roadmap/p0_architecture", headers=auth_headers("admin"),
                                               json={"status": "in_progress"})).json(), ROADMAP_ITEM)
    assert item["status"] == "in_progress"


def test_risks_and_update(client, module_mutable_client, auth_headers):
    rows = as_list(ok(client.get("/api/risks")).json())
    keys(first(rows), RISK_ROW)
    row = keys(ok(module_mutable_client.patch("/api/risks/1", headers=auth_headers("admin"),
                                              json={"status": "open", "owner": "Smoke Owner", "likelihood": 2, "impact": 4})).json(), RISK_ROW)
    assert row["status"] == "open" and row["owner"] == "Smoke Owner"


def test_watchlist_flow(module_mutable_client, auth_headers):
    mc = module_mutable_client
    h = auth_headers("industry")
    assert mc.get("/api/watchlist").status_code == 401
    ok(mc.post(f"/api/watchlist/{PRODUCT}", headers=h))
    items = as_list(ok(mc.get("/api/watchlist", headers=h)).json())
    keys(first(items), PRODUCT_SUMMARY)
    assert any(p["hsn8"] == PRODUCT for p in items)
    ok(mc.delete(f"/api/watchlist/{PRODUCT}", headers=h), expect=(200, 204))
    assert all(p["hsn8"] != PRODUCT for p in as_list(mc.get("/api/watchlist", headers=h).json()))


# =========================================================================== 6.14 AI assistant

def test_assistant_status_and_chat(client):
    status = keys(ok(client.get("/api/assistant/status")).json(), {"mode", "model"})
    assert status["mode"] in ("claude", "offline")
    body = keys(ok(client.post("/api/assistant/chat", json={"messages": [
        {"role": "user", "content": f"Which ministry owns {PRODUCT}?"}]})).json(),
                {"reply", "citations", "mode", "tools_used"})
    assert body["reply"].strip()
    for c in body["citations"]:
        keys(c, {"type", "id", "label", "route"}, "citation")
