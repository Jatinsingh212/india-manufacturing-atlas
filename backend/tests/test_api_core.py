"""API core tests (owner C1): system, auth / RBAC, meta, HSN explorer, ministry and sector dashboards.

Runs against the real ``data/atlas.db`` through the fixtures of ``tests/conftest.py`` (skipped when the database
is not built). Tests that write (register, audit) use the private ``mutable_*`` copy.
"""
from __future__ import annotations

import base64
import json
import sqlite3
import time
from pathlib import Path

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.common import bcd_display, fmt_pct, fts_query, parse_code_query, provenance
from app.security import (GOV_ROLES, TokenError, can_access_ministry, create_access_token, decode_jwt, encode_jwt,
                          hash_password, require_admin, require_gov, require_roles, require_user, verify_password)

CURATED = Path(__file__).resolve().parents[1] / "data" / "curated"
PERF_BUDGET_S = 1.5  # SPEC section 9: no endpoint slower than 1.5 s on the full DB

PRODUCT_SUMMARY_KEYS = {
    "hsn8", "hs6", "hs4", "hs2", "description", "full_description", "ministry_id", "ministry_short",
    "ministry_name", "sector_id", "sector_name", "mapping_status", "mapping_source", "mapping_confidence",
    "exports", "imports", "world_trade", "rca", "mfn_tariff", "bcd_display", "lines_in_hs6", "trade_level",
}
PRODUCT_DETAIL_KEYS = PRODUCT_SUMMARY_KEYS | {
    "hierarchy", "ministries", "mapping", "trade", "series", "tariff", "trade_policy", "top_destinations",
    "top_sources", "world_top_suppliers", "world_top_markets", "scores", "value_chains", "upstream", "downstream",
    "schemes", "production", "siblings", "data_quality_score",
}
TRADE_KEYS = {"year", "exports", "imports", "world_trade", "trade_balance", "rca", "india_world_share",
              "india_supplier_rank", "n_suppliers", "world_supplier_hhi", "india_import_hhi", "top_import_source",
              "top_import_source_share", "china_import_share", "export_cagr", "import_cagr", "world_cagr",
              "export_yoy", "import_yoy", "trade_level", "lines_in_hs6", "provenance"}
COUNTRY_VALUE_KEYS = {"country_id", "country", "iso3", "value", "share", "rank"}
PROVENANCE_KEYS = {"source", "status", "label", "year"}
DASHBOARD_KPI_KEYS = {"codes", "accepted", "secondary_codes", "exports", "imports", "trade_balance", "world_trade",
                      "sectors_covered", "chains_involved", "open_tickets", "pending_claims"}
DASHBOARD_KEYS = {"kpis", "chapter_mix", "top_exports", "top_imports", "dependency_hotspots", "opportunities",
                  "value_chains", "schemes", "trend"}


def _demo_password() -> str:
    return json.loads((CURATED / "ops_seed.json").read_text(encoding="utf-8"))["demo_password"]


def _assert_provenance(p: dict) -> None:
    assert PROVENANCE_KEYS <= set(p)
    assert p["status"] in ("verified", "not_verified", "not_available")


# =========================================================================== system

def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["latest_year"] == 2024
    assert body["products"] > 10_000
    assert body["built_at"]
    assert {"auth", "meta", "hsn", "ministries", "sectors"} <= set(body["routers"]["loaded"])
    assert "X-Process-Time-Ms" in r.headers


def test_openapi_docs_under_api(client):
    assert client.get("/api/docs").status_code == 200
    spec = client.get("/api/openapi.json").json()
    assert "/api/hsn/search" in spec["paths"]
    assert "/api/ministries/{ministry_id}" in spec["paths"]


def test_unknown_api_path_is_json_404(client):
    r = client.get("/api/does-not-exist")
    assert r.status_code == 404
    assert r.json() == {"detail": "Not Found"}


def test_cors_preflight_allows_vite_dev_server(client):
    r = client.options("/api/meta/overview", headers={"Origin": "http://localhost:5173",
                                                       "Access-Control-Request-Method": "GET"})
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "http://localhost:5173"
    r = client.get("/api/health", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in r.headers


def test_gzip_for_large_responses(client):
    r = client.get("/api/meta/countries", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200
    assert r.headers.get("content-encoding") == "gzip"


def test_spa_fallback_and_static_files(tmp_path, db_path):
    from app.main import create_app
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>Atlas</title>", encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("top secret", encoding="utf-8")
    spa = TestClient(create_app(db_path=db_path, frontend_dist=dist))
    assert "<title>Atlas</title>" in spa.get("/").text
    assert "<title>Atlas</title>" in spa.get("/ministry/mot").text          # client-side route
    asset = spa.get("/assets/app.js")
    assert asset.text == "console.log(1)" and "immutable" in asset.headers["cache-control"]
    assert spa.get("/api/nothing-here").status_code == 404                  # never index.html for /api
    assert spa.get("/api/nothing-here").json()["detail"] == "Not Found"
    assert "top secret" not in spa.get("/..%2fsecret.txt").text              # no escape from dist
    assert spa.get("/api/health").json()["status"] == "ok"


def test_without_frontend_build_only_api(tmp_path, db_path):
    from app.main import create_app
    api_only = create_app(db_path=db_path, frontend_dist=tmp_path / "missing")
    assert api_only.state.spa_mounted is False
    assert TestClient(api_only).get("/").status_code == 404


def test_missing_router_modules_are_skipped(monkeypatch, db_path):
    import app.main as main
    monkeypatch.setattr(main, "ROUTER_MODULES", ("auth", "meta", "no_such_router"))
    built = main.create_app(db_path=db_path)
    assert built.state.routers_loaded == ["auth", "meta"]
    assert "no_such_router" in built.state.routers_unavailable


def test_health_without_database(tmp_path):
    from app.main import create_app
    missing = TestClient(create_app(db_path=tmp_path / "none.db", frontend_dist=tmp_path))
    body = missing.get("/api/health").json()
    assert body["status"] == "no_database"
    assert missing.get("/api/meta/overview").status_code == 503
    assert not (tmp_path / "none.db").exists()  # the API never creates an empty database


# =========================================================================== security primitives

def test_password_hash_format_and_verify():
    stored = hash_password("s3cret-pass")
    algo, iterations, salt_hex, digest = stored.split("$")
    assert algo == "pbkdf2_sha256" and iterations == "200000"
    assert len(bytes.fromhex(salt_hex)) == 16 and len(digest) == 64
    assert verify_password("s3cret-pass", stored)
    assert not verify_password("wrong", stored)
    assert not verify_password("s3cret-pass", "garbage")
    assert not verify_password("s3cret-pass", None)


def test_seeded_demo_hashes_follow_the_spec_format(db_conn):
    for user in db_conn.execute("SELECT password_hash FROM users WHERE is_demo = 1").fetchall():
        assert user["password_hash"].startswith("pbkdf2_sha256$200000$")
        assert verify_password(_demo_password(), user["password_hash"])


def test_jwt_roundtrip_tamper_and_expiry():
    token = encode_jwt({"sub": "1", "role": "admin", "exp": time.time() + 60}, "k")
    header = json.loads(base64.urlsafe_b64decode(token.split(".")[0] + "=="))
    assert header == {"alg": "HS256", "typ": "JWT"}
    assert decode_jwt(token, "k")["role"] == "admin"
    with pytest.raises(TokenError):
        decode_jwt(token, "other-secret")
    h, p, s = token.split(".")
    forged = base64.urlsafe_b64encode(json.dumps({"sub": "1", "role": "admin", "exp": 9e9}).encode()).rstrip(b"=")
    with pytest.raises(TokenError):
        decode_jwt(f"{h}.{forged.decode()}.{s}", "k")
    with pytest.raises(TokenError, match="expired"):
        decode_jwt(encode_jwt({"sub": "1", "exp": time.time() - 1}, "k"), "k")
    none_header = base64.urlsafe_b64encode(b'{"alg":"none","typ":"JWT"}').rstrip(b"=").decode()
    with pytest.raises(TokenError):
        decode_jwt(f"{none_header}.{p}.", "k")
    with pytest.raises(TokenError):
        decode_jwt("not-a-token", "k")


def test_can_access_ministry():
    assert can_access_ministry({"role": "admin"}, "mot")
    assert can_access_ministry({"role": "ministry", "ministry_id": "mot"}, "mot")
    assert not can_access_ministry({"role": "ministry", "ministry_id": "mot"}, "dpiit")
    assert not can_access_ministry({"role": "analyst"}, "mot")
    assert not can_access_ministry({"role": "industry"}, "mot")
    assert not can_access_ministry(None, "mot")
    assert GOV_ROLES == ("analyst", "ministry", "admin")


def test_require_roles_rejects_unknown_role():
    with pytest.raises(ValueError):
        require_roles("superuser")


# =========================================================================== auth endpoints

def test_me_anonymous_is_public(client):
    assert client.get("/api/auth/me").json() == {
        "id": None, "email": None, "name": None, "role": "public", "ministry_id": None, "organisation": None}


def test_me_with_invalid_token_is_public(client):
    r = client.get("/api/auth/me", headers={"Authorization": "Bearer abc.def.ghi"})
    assert r.status_code == 200 and r.json()["role"] == "public"


@pytest.mark.parametrize("role", ["admin", "ministry", "analyst", "industry"])
def test_demo_login_each_role(client, role):
    r = client.post("/api/auth/demo-login", json={"role": role})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["token_type"] == "bearer" and body["access_token"].count(".") == 2
    assert body["user"]["role"] == role
    assert "password_hash" not in body["user"]
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"}).json()
    assert me == body["user"]
    claims = decode_jwt(body["access_token"])
    assert claims["sub"] == str(body["user"]["id"]) and claims["role"] == role
    assert 11.9 * 3600 < claims["exp"] - time.time() <= 12 * 3600


def test_demo_login_ministry_users(client):
    default = client.post("/api/auth/demo-login", json={"role": "ministry"}).json()["user"]
    assert default["ministry_id"] == "mot"
    dpiit = client.post("/api/auth/demo-login", json={"role": "ministry", "ministry_id": "dpiit"}).json()["user"]
    assert dpiit["ministry_id"] == "dpiit"
    assert client.post("/api/auth/demo-login", json={"role": "ministry", "ministry_id": "nope"}).status_code == 404


def test_demo_login_validation_and_demo_mode_off(client, monkeypatch):
    assert client.post("/api/auth/demo-login", json={"role": "public"}).status_code == 422
    assert client.post("/api/auth/demo-login", json={}).status_code == 422
    monkeypatch.setenv("ATLAS_DEMO_MODE", "0")
    assert client.post("/api/auth/demo-login", json={"role": "admin"}).status_code == 404


def test_login_with_seeded_credentials(client):
    r = client.post("/api/auth/login", json={"email": "Analyst@Atlas.gov.in", "password": _demo_password()})
    assert r.status_code == 200, r.text
    assert r.json()["user"]["role"] == "analyst"
    assert client.post("/api/auth/login", json={"email": "analyst@atlas.gov.in", "password": "wrong"}).status_code == 401
    assert client.post("/api/auth/login", json={"email": "nobody@x.in", "password": "whatever"}).status_code == 401
    assert client.post("/api/auth/login", json={"email": "a@b.c"}).status_code == 422


def test_register_creates_industry_user_and_audits(mutable_client, mutable_conn):
    body = {"email": "New.User@Example.com", "password": "longenough1", "name": "New User",
            "organisation": "Acme Tyres"}
    r = mutable_client.post("/api/auth/register", json=body)
    assert r.status_code == 200, r.text
    user = r.json()["user"]
    assert user["role"] == "industry" and user["email"] == "new.user@example.com"
    assert user["organisation"] == "Acme Tyres" and user["ministry_id"] is None
    token = r.json()["access_token"]
    assert mutable_client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).json()["id"] == user["id"]
    # login with the new password, duplicate email, validation
    assert mutable_client.post("/api/auth/login", json={"email": body["email"], "password": body["password"]}
                               ).status_code == 200
    assert mutable_client.post("/api/auth/register", json=body).status_code == 400
    assert mutable_client.post("/api/auth/register", json={**body, "email": "x@y.z", "password": "short"}
                               ).status_code == 422
    assert mutable_client.post("/api/auth/register", json={**body, "email": "not-an-email"}).status_code == 422
    stored = mutable_conn.execute("SELECT role, is_demo, password_hash FROM users WHERE email = ?",
                                  ("new.user@example.com",)).fetchone()
    assert stored["role"] == "industry" and stored["is_demo"] == 0
    assert verify_password(body["password"], stored["password_hash"])
    actions = [r["action"] for r in mutable_conn.execute(
        "SELECT action FROM audit_log WHERE user_id = ? ORDER BY id", (user["id"],)).fetchall()]
    assert actions[:2] == ["user.register", "login"]


def test_deactivated_user_loses_access(mutable_client, mutable_conn, auth_headers):
    headers = auth_headers("industry")
    assert mutable_client.get("/api/auth/me", headers=headers).json()["role"] == "industry"
    mutable_conn.execute("UPDATE users SET active = 0 WHERE email = 'industry@example.com'")
    mutable_conn.commit()
    assert mutable_client.get("/api/auth/me", headers=headers).json()["role"] == "public"
    r = mutable_client.post("/api/auth/login", json={"email": "industry@example.com", "password": _demo_password()})
    assert r.status_code == 401


# =========================================================================== RBAC dependencies

@pytest.fixture(scope="module")
def rbac_client(db_path):
    """A tiny app exercising the security dependencies against the real users table."""
    probe = FastAPI()
    probe.state.db_path = db_path

    @probe.get("/user")
    def _user(user: dict = Depends(require_user)):
        return user

    @probe.get("/gov")
    def _gov(user: dict = Depends(require_gov)):
        return user

    @probe.get("/admin")
    def _admin(user: dict = Depends(require_admin)):
        return user

    @probe.get("/ministry-or-industry")
    def _mixed(user: dict = Depends(require_roles("ministry", "industry"))):
        return user

    return TestClient(probe)


@pytest.mark.parametrize("path, role, expected", [
    ("/user", None, 401), ("/user", "industry", 200), ("/user", "admin", 200),
    ("/gov", None, 401), ("/gov", "industry", 403), ("/gov", "analyst", 200), ("/gov", "ministry", 200),
    ("/gov", "admin", 200),
    ("/admin", None, 401), ("/admin", "analyst", 403), ("/admin", "ministry", 403), ("/admin", "admin", 200),
    ("/ministry-or-industry", "analyst", 403), ("/ministry-or-industry", "industry", 200),
    ("/ministry-or-industry", "ministry", 200), ("/ministry-or-industry", "admin", 200),  # admin always passes
])
def test_require_roles_matrix(rbac_client, auth_headers, path, role, expected):
    headers = auth_headers(role) if role else {}
    r = rbac_client.get(path, headers=headers)
    assert r.status_code == expected, r.text
    if expected == 401:
        assert r.headers.get("www-authenticate") == "Bearer"
    if expected == 200:
        assert r.json()["role"] == role


def test_rbac_bad_and_expired_tokens_are_401(rbac_client, db_conn):
    assert rbac_client.get("/gov", headers={"Authorization": "Bearer nonsense"}).status_code == 401
    analyst = db_conn.execute("SELECT * FROM users WHERE role = 'analyst' AND is_demo = 1").fetchone()
    expired = create_access_token(analyst, expires_in_s=-10)
    r = rbac_client.get("/gov", headers={"Authorization": f"Bearer {expired}"})
    assert r.status_code == 401 and "expired" in r.json()["detail"]
    ghost = create_access_token({"id": 987654, "email": "ghost@x", "role": "admin"})
    assert rbac_client.get("/admin", headers={"Authorization": f"Bearer {ghost}"}).status_code == 401


def test_role_is_read_from_database_not_token(rbac_client, db_conn):
    industry = db_conn.execute("SELECT * FROM users WHERE role = 'industry' AND is_demo = 1").fetchone()
    forged_role = create_access_token({**industry, "role": "admin"})  # validly signed, but the DB says industry
    assert rbac_client.get("/admin", headers={"Authorization": f"Bearer {forged_role}"}).status_code == 403


# =========================================================================== common helpers

def test_common_formatting_helpers():
    assert fmt_pct(12.5) == "12.5%" and fmt_pct(20) == "20%" and fmt_pct(None) is None
    assert fmt_pct(0.0307, fraction=True) == "3.07%"
    assert bcd_display("20", 7.5) == "20%" and bcd_display("20%", None) == "20%"
    assert bcd_display(None, 12.5) == "12.5%" and bcd_display(None, None) is None
    assert provenance("baci", year=2024) == {"source": "baci", "status": "verified",
                                             "label": "CEPII BACI 2024 (via OEC)", "year": 2024}
    assert provenance("rule")["status"] == "not_verified"
    assert provenance("curated")["status"] == "not_verified"
    assert provenance(None)["status"] == "not_available"


def test_query_parsing_helpers():
    assert parse_code_query("4011.10.10") == "40111010"
    assert parse_code_query("HS 6109") == "6109"
    assert parse_code_query("hsn: 61 09 10 00") == "61091000"
    assert parse_code_query("4011 radial") is None
    assert parse_code_query("tyre") is None
    expr = fts_query('tyre "cord" OR')
    assert '"tyrecord"*' in expr and expr.startswith("{hsn8 description full_description}")
    assert fts_query("!!!") is None


# =========================================================================== meta

def test_overview_kpis_and_distributions(client, db_conn):
    body = client.get("/api/meta/overview").json()
    k = body["kpis"]
    current = db_conn.execute("SELECT COUNT(*) AS n FROM products WHERE is_current = 1").fetchone()["n"]
    assert k["total_codes"] == current
    assert k["accepted_codes"] + k["residual_codes"] == k["total_codes"]
    assert k["ministries_assigned"] == 31
    assert k["latest_year"] == 2024
    totals = db_conn.execute("SELECT SUM(india_exports) AS x, SUM(india_imports) AS m FROM hs6_metrics").fetchone()
    assert k["india_exports"] == pytest.approx(totals["x"]) and k["india_imports"] == pytest.approx(totals["m"])
    assert 0 < k["hs6_with_trade"] <= 6000

    assert "guidebook_baseline" not in body

    dist = body["distribution_by_ministry"]
    assert all(d["ministry_id"] != "residual" for d in dist)
    assert [d["codes"] for d in dist] == sorted((d["codes"] for d in dist), reverse=True)
    assert sum(d["codes"] for d in dist) == k["accepted_codes"]
    assert {"ministry_id", "short_name", "name", "color", "codes", "exports", "imports"} <= set(dist[0])
    assert sum(d["exports"] for d in dist) <= k["india_exports"] * 1.0001

    sectors = body["sector_distribution"]
    assert sum(s["codes"] for s in sectors) == k["total_codes"]
    assert {"sector_id", "name", "color", "codes", "exports", "imports"} <= set(sectors[0])
    assert sum(m["codes"] for m in body["mapping_sources"]) == k["total_codes"]
    assert {m["source"] for m in body["mapping_sources"]} == {"dpiit_guidebook", "unmapped", "residual"}
    levels = {row["level"]: row for row in body["mapping_by_level"]}
    assert set(levels) == {2, 4, 6, 8}
    assert levels[8]["mapped_lines"] == k["accepted_codes"] and levels[8]["lines"] == k["total_codes"]
    for level in (2, 4, 6):
        assert levels[level]["method"] == "aggregated_from_8_digit_lines"
        assert 0 <= levels[level]["node_coverage"] <= 1
        assert 0 <= levels[level]["line_coverage"] <= 1
        assert levels[level]["mapped_lines"] <= levels[level]["lines"]
    assert all({"source_id", "name", "last_refreshed"} <= set(f) for f in body["data_freshness"])
    _assert_provenance(body["provenance"]["trade"])
    assert body["provenance"]["trade"]["status"] == "verified"
    assert body["provenance"]["mapping"]["status"] == "verified"
    assert body["provenance"]["mapping"]["source"] == "dpiit_guidebook"


def test_meta_ministries(client):
    data = client.get("/api/meta/ministries").json()
    assert len(data) == 34 and data[-1]["id"] == "residual"
    keys = {"id", "short_name", "name", "parent_ministry", "kind", "website", "color", "codes", "accepted",
            "exports", "imports"}
    assert all(keys <= set(m) for m in data)
    assert sum(1 for m in data if m["id"] != "residual" and m["codes"] >= 1) == 31  # two active ministries have no Guidebook code
    assert data[-1]["accepted"] == 0
    mot = next(m for m in data if m["id"] == "mot")
    assert mot["name"] == "Ministry of Textiles" and mot["accepted"] == mot["codes"]
    assert client.get("/api/ministries").json() == data


def test_meta_sectors_sections_countries_info(client):
    sectors = client.get("/api/meta/sectors").json()
    assert {"id", "name", "description", "color", "icon", "codes", "exports", "imports"} <= set(sectors[0])
    assert any(s["id"] == "textiles" and s["name"] == "Textiles & Apparel" for s in sectors)
    assert client.get("/api/sectors").json() == sectors

    sections = client.get("/api/meta/sections").json()
    assert len(sections) == 21 and sections[0]["id"] == "I"
    xi = next(s for s in sections if s["id"] == "XI")
    assert [c["code"] for c in xi["chapters"]] == [f"{n}" for n in range(50, 64)]
    assert {"code", "description", "codes"} <= set(xi["chapters"][0])

    countries = client.get("/api/meta/countries").json()
    india = next(c for c in countries if c["id"] == "asind")
    assert india == {"id": "asind", "iso3": "IND", "name": "India", "continent": "Asia"}

    info = client.get("/api/meta/info").json()
    assert len(info) == 4
    assert all({"id", "title", "icon", "body_md", "links"} <= set(card) and isinstance(card["links"], list)
               for card in info)


# =========================================================================== HSN: lookup and product detail

def test_lookup_example_61091000(client):
    """61091000 -> Ministry of Textiles, Textiles; official TRADESTAT line trade and WITS tariff."""
    r = client.get("/api/hsn/lookup/61091000")
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "product"
    p = body["product"]
    assert PRODUCT_DETAIL_KEYS <= set(p)
    assert "playbook" not in p
    assert p["hsn8"] == "61091000" and p["hs6"] == "610910"
    assert p["ministry_id"] == "mot" and p["ministry_name"] == "Ministry of Textiles"
    assert p["sector_name"] == "Textiles & Apparel"
    assert p["mapping"]["source"] == "dpiit_guidebook" and p["mapping"]["provenance"]["status"] == "verified"
    assert p["trade_level"] == "hs8"
    assert p["exports"] > 0
    assert TRADE_KEYS <= set(p["trade"])
    assert p["trade"]["provenance"]["source"] == "tradestat" and p["trade"]["provenance"]["status"] == "verified"
    assert p["trade"]["provenance"]["label"].startswith("DGFT/DGCIS TRADESTAT FY2024-25 (this 8-digit line)")
    # the WITS line is non-ad-valorem, so no BCD percentage is shown
    assert p["bcd_display"] is None and p["tariff"]["bcd_source"] is None
    assert p["tariff"]["provenance"]["source"] == "wits"
    assert [h["level"] for h in p["hierarchy"]] == [0, 2, 4, 6]
    assert p["hierarchy"][0]["code"] == "XI"
    assert [s["year"] for s in p["series"]] == list(range(2018, 2025))
    assert all(COUNTRY_VALUE_KEYS <= set(c) for c in p["top_destinations"] + p["world_top_suppliers"])
    assert any(c["country_id"] == "asind" for c in p["world_top_suppliers"])
    assert len(p["world_top_markets"]) == 10 and len(p["top_sources"]) <= 10
    assert p["ministries"][0]["id"] == "mot" and p["ministries"][0]["role"] == "primary"
    assert isinstance(p["data_quality_score"], int) and 0 <= p["data_quality_score"] <= 100


def test_lookup_ignores_dots_and_spaces(client):
    assert client.get("/api/hsn/lookup/6109.10.00").json()["product"]["hsn8"] == "61091000"
    assert client.get("/api/hsn/lookup/6109 10 00").json()["product"]["hsn8"] == "61091000"


def test_parent_level_ownership_is_derived_from_guidebook(client):
    """2/4/6-digit nodes expose owners of the accepted 8-digit lines under them."""
    for code, level in (("84", 2), ("8471", 4), ("847130", 6)):
        body = client.get(f"/api/hsn/lookup/{code}").json()
        assert body["type"] == "node" and body["node"]["level"] == level
        own = body["node"]["ownership"]
        assert own["source"] == "dpiit_guidebook"
        assert own["method"] == "aggregated_from_8_digit_lines"
        assert own["total_lines"] == body["node"]["n_products"]
        assert 0 <= own["coverage"] <= 1 and own["mapped_lines"] <= own["total_lines"]
        assert own["n_owners"] == len(own["owners"])
        if own["owners"]:
            assert own["owners"][0]["role"] == "primary"
        if level < 6:
            assert body["children"] and all("ownership" in c for c in body["children"])
    tree = client.get("/api/hsn/tree", params={"code": "8471"}).json()
    assert tree and all("ownership" in row for row in tree)


def test_residual_line_reports_derived_parent_hint(client):
    p = client.get("/api/hsn/product/87042219").json()
    assert p["mapping_status"] == "residual"
    hint = p["parent_ownership"]
    assert hint and hint["parent_code"] == "8704" and hint["owner"]["id"] == "mhi"
    assert hint["level"] == 4 and hint["coverage"] >= 0.5
    assert hint["method"] == "aggregated_from_8_digit_lines"


def test_cotton_dress_product_62044290(client):
    p = client.get("/api/hsn/product/62044290").json()
    assert p["ministry_id"] == "mot" and p["bcd_display"] is None
    assert "playbook" not in p
    assert p["mapping"]["source"] == "dpiit_guidebook" and p["mapping"]["provenance"]["status"] == "verified"
    assert p["exports"] > 0
    assert len(p["siblings"]) == p["lines_in_hs6"] - 1


def test_tyre_product_detail(client, db_conn):
    p = client.get("/api/hsn/product/40111090").json()
    assert PRODUCT_DETAIL_KEYS <= set(p)
    assert p["ministry_id"] == "dpiit" and p["sector_id"] == "rubber_tyre"
    assert p["mapping"]["source"] == "dpiit_guidebook" and p["mapping"]["provenance"]["status"] == "verified"
    assert p["tariff"]["mfn_avg"] is not None and p["bcd_display"].endswith("%")
    assert p["tariff"]["bcd_source"] == "wits"
    assert p["tariff"]["provenance"]["source"] == "wits"
    chains = {vc["chain_id"] for vc in p["value_chains"]}
    assert "tyre" in chains
    assert p["upstream"], "tyres must have curated inputs (rubber, carbon black ...)"
    assert all({"code", "description", "relation", "chain_id"} <= set(u) for u in p["upstream"] + p["downstream"])
    assert any(u["code"].startswith("4001") for u in p["upstream"])
    assert any(s["kind"] in ("PLI", "QCO") for s in p["schemes"])
    assert {s["hsn8"] for s in p["siblings"]} == {r["hsn8"] for r in db_conn.execute(
        "SELECT hsn8 FROM products WHERE hs6 = '401110' AND hsn8 <> '40111090'").fetchall()}
    if p["scores"] is not None:  # compute_scores (C2) may not have run
        assert {"export_potential_score", "vulnerability_score", "archetype", "forecast"} <= set(p["scores"])


def test_petroleum_lines_use_heading_aggregate(client, db_conn):
    heading = db_conn.execute("SELECT india_exports, world_trade FROM hs6_metrics WHERE hs6 = '271000'").fetchone()
    assert heading["india_exports"] > 50e9 and heading["world_trade"] > 0
    line_x = db_conn.execute("SELECT india_exports FROM trade_hs8 WHERE hsn8 = '27101944' AND year = 2024"
                             ).fetchone()["india_exports"]
    p = client.get("/api/hsn/product/27101944").json()          # published line: its own TRADESTAT value
    assert p["trade"]["trade_level"] == "hs8" and p["trade"]["metric_hs6"] == "271000"
    assert p["trade"]["exports"] == pytest.approx(line_x) and p["trade"]["rca"] is not None
    for hsn8 in ("27101211", "27101910"):                       # not published for FY2024-25: heading context only
        p = client.get(f"/api/hsn/product/{hsn8}").json()
        assert p["trade"]["trade_level"] == "hs4_aggregate"
        assert p["trade"]["metric_hs6"] == "271000"
        assert p["trade"]["heading_lines"] == 69
        assert p["trade"]["exports"] is None and p["trade"]["world_trade"] == pytest.approx(heading["world_trade"])
        assert len(p["series"]) == 7
        assert p["top_destinations"] and p["top_sources"]
        if p["scores"] is not None:  # compute_scores (C2) may not have run
            assert {"export_potential_score", "vulnerability_score", "archetype"} <= set(p["scores"])
    node = client.get("/api/hsn/lookup/271012").json()["node"]
    assert node["trade"]["trade_level"] == "hs4_aggregate"
    assert node["trade"]["metric_hs6"] == "271000"
    assert node["trade"]["exports"] == pytest.approx(heading["india_exports"])
    tree = client.get("/api/hsn/tree", params={"code": "2710"}).json()
    petroleum = [r for r in tree if r["code"] in ("271012", "271019")]
    assert petroleum and all(r["trade_level"] == "hs4_aggregate" for r in petroleum)
    assert all(r["exports"] == pytest.approx(heading["india_exports"]) for r in petroleum)


def test_unreported_lines_stay_not_available(client):
    # Not published by DGCIS for FY2024-25: no value of its own (not zero), heading context still shown.
    p = client.get("/api/hsn/product/27101211").json()
    assert p["exports"] is None and p["imports"] is None
    # Monetary gold: DGCIS lists exports as 0.00 and has no import row.
    p = client.get("/api/hsn/product/71082000").json()
    assert p["exports"] == 0 and p["imports"] is None
    assert p["scores"] is None or p["scores"]["export_potential_score"] is None  # no BACI world total to rank


def test_primary_owner_is_listed(client):
    p = client.get("/api/hsn/product/28112200").json()       # silica: DCPC owns the line
    roles = {(m["id"], m["role"]) for m in p["ministries"]}
    assert ("dcpc", "primary") in roles


def test_residual_product_detail(client, db_conn):
    hsn8 = db_conn.execute("SELECT hsn8 FROM products WHERE mapping_status = 'residual' ORDER BY hsn8 LIMIT 1"
                           ).fetchone()["hsn8"]
    p = client.get(f"/api/hsn/product/{hsn8}").json()
    assert p["ministry_id"] == "residual" and p["mapping"]["provenance"]["status"] == "not_verified"
    assert p["ministries"][0]["id"] == "residual"


def test_node_lookup_4011(client, db_conn):
    body = client.get("/api/hsn/lookup/4011").json()
    assert body["type"] == "node"
    node = body["node"]
    assert {"code", "level", "description", "parent", "section_id"} <= set(node)
    assert node["code"] == "4011" and node["level"] == 4 and node["parent"] == "40"
    assert all(c["level"] == 6 and c["code"].startswith("4011") for c in body["children"])
    assert all({"code", "level", "description", "n_products"} <= set(c) for c in body["children"])
    n_lines = db_conn.execute("SELECT COUNT(*) AS n FROM products WHERE hsn8 LIKE '4011%'").fetchone()["n"]
    assert len(body["products"]) == min(n_lines, 50) and node["n_products"] == n_lines
    assert sum(c["n_products"] for c in body["children"]) == n_lines
    assert all(PRODUCT_SUMMARY_KEYS <= set(p) for p in body["products"])
    exports = db_conn.execute("SELECT SUM(india_exports) AS x FROM hs6_metrics WHERE hs6 LIKE '4011%'"
                              ).fetchone()["x"]
    assert node["trade"]["exports"] == pytest.approx(exports)    # ~US$ 3.1 bn


def test_node_lookup_subheading_children_are_lines(client):
    body = client.get("/api/hsn/lookup/401110").json()
    assert body["type"] == "node" and all(c["level"] == 8 for c in body["children"])


@pytest.mark.parametrize("code", ["12345", "99999999", "abc", "4"])
def test_lookup_404(client, code):
    assert client.get(f"/api/hsn/lookup/{code}").status_code == 404


def test_product_404_for_non_line(client):
    assert client.get("/api/hsn/product/6109").status_code == 404
    assert client.get("/api/hsn/product/00000000").status_code == 404


# =========================================================================== HSN: search and suggest

def test_text_search_tyre_cord(client):
    body = client.get("/api/hsn/search", params={"q": "tyre cord"}).json()
    assert {"items", "total", "page", "page_size"} <= set(body)
    assert body["total"] >= 3 and body["match"] == "text"
    codes = [i["hsn8"] for i in body["items"]]
    assert any(c.startswith("5902") for c in codes)       # 'tyrecord' fabric
    assert any(c.startswith("560750") for c in codes)     # nylon / viscose tyre cord
    assert all(PRODUCT_SUMMARY_KEYS <= set(i) for i in body["items"])


def test_code_prefix_search_4011(client, db_conn):
    body = client.get("/api/hsn/search", params={"q": "4011"}).json()
    n = db_conn.execute("SELECT COUNT(*) AS n FROM products WHERE hsn8 LIKE '4011%'").fetchone()["n"]
    prefix_hits = [i for i in body["items"] if i["hsn8"].startswith("4011")]
    assert len(prefix_hits) == n and body["match"] == "code"
    # code-prefix matches come first, in code order
    assert [i["hsn8"] for i in body["items"][:n]] == sorted(i["hsn8"] for i in prefix_hits)
    dotted = client.get("/api/hsn/search", params={"q": "4011.10"}).json()
    assert dotted["items"][0]["hsn8"].startswith("401110")


def test_exact_code_ranks_first(client):
    items = client.get("/api/hsn/search", params={"q": "61091000"}).json()["items"]
    assert items[0]["hsn8"] == "61091000"


def test_search_facets_sort_and_pagination(client, db_conn):
    mot = client.get("/api/hsn/search", params={"ministry_id": "mot", "sort": "exports", "page_size": 50}).json()
    exports = [i["exports"] for i in mot["items"] if i["exports"] is not None]
    assert exports == sorted(exports, reverse=True)
    assert all(i["ministry_id"] == "mot" for i in mot["items"])
    asc = client.get("/api/hsn/search", params={"ministry_id": "mot", "sort": "exports", "order": "asc"}).json()
    assert asc["items"][0]["exports"] <= asc["items"][-1]["exports"]

    ch61 = client.get("/api/hsn/search", params={"chapter": "61", "page_size": 200}).json()
    assert ch61["total"] == db_conn.execute("SELECT COUNT(*) AS n FROM products WHERE hs2 = '61'").fetchone()["n"]
    assert all(i["hs2"] == "61" for i in ch61["items"])

    guidebook = client.get("/api/hsn/search", params={"mapping_source": "dpiit_guidebook"}).json()
    assert guidebook["total"] == db_conn.execute(
        "SELECT COUNT(*) AS n FROM products WHERE mapping_source = 'dpiit_guidebook'").fetchone()["n"]
    assert client.get("/api/hsn/search", params={"mapping_source": "playbook"}).status_code == 422
    rca = client.get("/api/hsn/search", params={"rca_min": 1, "rca_max": 2, "min_exports": 1e8}).json()
    assert rca["total"] > 0 and all(1 <= i["rca"] <= 2 and i["exports"] >= 1e8 for i in rca["items"])

    page1 = client.get("/api/hsn/search", params={"q": "cotton", "page_size": 10}).json()
    page2 = client.get("/api/hsn/search", params={"q": "cotton", "page_size": 10, "page": 2}).json()
    assert page1["page"] == 1 and page2["page"] == 2 and page1["page_size"] == 10
    assert not {i["hsn8"] for i in page1["items"]} & {i["hsn8"] for i in page2["items"]}
    assert page1["total"] == page2["total"] > 10


def test_search_combined_text_and_facet(client):
    body = client.get("/api/hsn/search", params={"q": "rubber", "ministry_id": "dpiit"}).json()
    assert body["total"] > 0 and all(i["ministry_id"] == "dpiit" for i in body["items"])


def test_search_validation(client):
    assert client.get("/api/hsn/search", params={"page_size": 500}).status_code == 422
    assert client.get("/api/hsn/search", params={"sort": "bogus"}).status_code == 422
    assert client.get("/api/hsn/search", params={"mapping_status": "maybe"}).status_code == 422
    assert client.get("/api/hsn/search", params={"chapter": "abc"}).status_code == 400


@pytest.mark.parametrize("q", ['"tyre" OR NOT', "NEAR(", "*", "a AND", "'; DROP TABLE products; --", "{hsn8}:"])
def test_search_is_injection_safe(client, q):
    r = client.get("/api/hsn/search", params={"q": q})
    assert r.status_code == 200, r.text


def test_search_no_match(client):
    body = client.get("/api/hsn/search", params={"q": "zzqxv"}).json()
    assert body["total"] == 0 and body["items"] == []


def test_suggest(client):
    items = client.get("/api/hsn/suggest", params={"q": "t-shirt"}).json()
    assert 0 < len(items) <= 8 and "61091000" in [i["hsn8"] for i in items]
    assert {"hsn8", "description", "ministry_short"} <= set(items[0])
    assert client.get("/api/hsn/suggest", params={"q": "6109"}).json()[0]["hsn8"].startswith("6109")
    assert client.get("/api/hsn/suggest", params={"q": " "}).json() == []


# =========================================================================== HSN: tree and compare

def test_tree_navigation_section_to_line(client):
    sections = client.get("/api/hsn/tree").json()
    assert len(sections) == 21 and all(s["level"] == 0 and s["has_children"] for s in sections)
    keys = {"code", "level", "description", "n_products", "exports", "imports", "has_children"}
    assert all(keys <= set(s) for s in sections)

    chapters = client.get("/api/hsn/tree", params={"code": "VII"}).json()
    assert [c["code"] for c in chapters] == ["39", "40"] and all(c["level"] == 2 for c in chapters)
    headings = client.get("/api/hsn/tree", params={"code": "40"}).json()
    tyres = next(h for h in headings if h["code"] == "4011")
    assert tyres["level"] == 4 and tyres["has_children"] and tyres["n_products"] > 0
    subs = client.get("/api/hsn/tree", params={"code": "4011"}).json()
    assert all(s["level"] == 6 for s in subs)
    first = next(s for s in subs if s["n_products"] > 0)
    lines = client.get("/api/hsn/tree", params={"code": first["code"]}).json()
    assert len(lines) == first["n_products"]
    assert all(line["level"] == 8 and not line["has_children"] for line in lines)
    assert client.get("/api/hsn/tree", params={"code": lines[0]["code"]}).json() == []
    # section product counts add up to the catalogue
    assert sum(s["n_products"] for s in sections) == client.get("/api/health").json()["products"]


def test_tree_lowercase_section_and_404(client):
    assert client.get("/api/hsn/tree", params={"code": "xi"}).status_code == 200
    assert client.get("/api/hsn/tree", params={"code": "XXX"}).status_code == 404
    assert client.get("/api/hsn/tree", params={"code": "00"}).status_code == 404


def test_compare(client):
    body = client.get("/api/hsn/compare", params={"codes": "61091000,62044290,40111090"}).json()
    assert [i["hsn8"] for i in body["items"]] == ["61091000", "62044290", "40111090"]
    for item in body["items"]:
        assert PRODUCT_SUMMARY_KEYS | {"series", "india_world_share", "export_cagr", "import_cagr"} <= set(item)
        assert [s["year"] for s in item["series"]] == list(range(2018, 2025))
    partial = client.get("/api/hsn/compare", params={"codes": "61091000,99999999"}).json()
    assert partial["not_found"] == ["99999999"] and len(partial["items"]) == 1
    too_many = ",".join(["61091000", "62044290", "40111090", "40111010", "40112010", "40113000"])
    assert client.get("/api/hsn/compare", params={"codes": too_many}).status_code == 400
    assert client.get("/api/hsn/compare", params={"codes": "6109"}).status_code == 400
    assert client.get("/api/hsn/compare", params={"codes": "99999999"}).status_code == 404


# =========================================================================== ministries and sectors

def _check_dashboard(body: dict) -> None:
    assert DASHBOARD_KEYS <= set(body)
    assert DASHBOARD_KPI_KEYS <= set(body["kpis"])
    assert all(PRODUCT_SUMMARY_KEYS <= set(p) for p in body["top_exports"] + body["top_imports"])
    assert len(body["top_exports"]) <= 10 and len(body["top_imports"]) <= 10
    for key in ("top_exports", "top_imports", "dependency_hotspots", "opportunities"):
        hs6 = [p["hs6"] for p in body[key]]
        assert len(hs6) == len(set(hs6)), f"{key} repeats an HS6"
    values = [p["exports"] for p in body["top_exports"]]
    assert values == sorted(values, reverse=True)
    for h in body["dependency_hotspots"]:
        assert {"vulnerability_score", "top_import_source", "top_import_source_share",
                "china_import_share"} <= set(h)
    for o in body["opportunities"]:
        assert {"export_potential_score", "untapped_potential_usd", "archetype"} <= set(o)
    assert all({"hs2", "description", "codes", "exports", "imports"} <= set(c) for c in body["chapter_mix"])
    assert all({"chain_id", "name", "stages"} <= set(v) for v in body["value_chains"])
    assert all({"id", "name", "kind"} <= set(s) for s in body["schemes"])
    assert [t["year"] for t in body["trend"]] == list(range(2018, 2025))
    assert body["kpis"]["chains_involved"] == len(body["value_chains"])
    assert body["kpis"]["trade_balance"] == pytest.approx(body["kpis"]["exports"] - body["kpis"]["imports"])


def test_ministry_dashboard_mot(client, db_conn):
    body = client.get("/api/ministries/mot").json()
    _check_dashboard(body)
    m = body["ministry"]
    assert {"id", "short_name", "name", "color", "parent_ministry", "kind", "website"} <= set(m)
    assert m["name"] == "Ministry of Textiles"
    listed = next(x for x in client.get("/api/meta/ministries").json() if x["id"] == "mot")
    assert body["kpis"]["codes"] == listed["codes"]
    assert body["kpis"]["exports"] == pytest.approx(listed["exports"])
    assert body["sector_mix"][0]["sector_id"] == "textiles"
    assert all({"sector_id", "name", "color", "codes", "exports", "imports"} <= set(s) for s in body["sector_mix"])
    assert "61091000" in [p["hsn8"] for p in body["top_exports"]]   # a flagship MoT line
    assert all(p["ministry_id"] == "mot" for p in body["top_exports"])
    assert "cotton_apparel" in {v["chain_id"] for v in body["value_chains"]}
    own = {r["id"] for r in db_conn.execute("SELECT id FROM schemes WHERE ministry_id = 'mot'").fetchall()}
    assert {s["id"] for s in body["schemes"]} == own
    expected_tickets = db_conn.execute("SELECT COUNT(*) AS n FROM tickets WHERE routed_ministry_id = 'mot' "
                                       "AND status <> 'resolved'").fetchone()["n"]
    assert body["kpis"]["open_tickets"] == expected_tickets


def test_ministry_dashboard_dpiit(client):
    body = client.get("/api/ministries/dpiit").json()
    _check_dashboard(body)
    assert body["kpis"]["codes"] > 2000
    tyre = next(v for v in body["value_chains"] if v["chain_id"] == "tyre")   # DPIIT leads tyres
    assert "Finished Goods" in tyre["stages"]
    assert body["sector_mix"] and body["chapter_mix"]


def test_residual_and_unknown_ministry(client):
    body = client.get("/api/ministries/residual").json()
    assert body["kpis"]["codes"] > 0 and body["kpis"]["accepted"] == 0
    assert client.get("/api/ministries/nope").status_code == 404
    assert client.get("/api/ministries/nope/products").status_code == 404


def test_ministry_products_table(client, db_conn):
    body = client.get("/api/ministries/mot/products", params={"sort": "exports", "page_size": 20}).json()
    total = db_conn.execute("SELECT COUNT(*) AS n FROM products WHERE ministry_id = 'mot'").fetchone()["n"]
    assert body["total"] == total and len(body["items"]) == 20
    assert all(i["ministry_id"] == "mot" for i in body["items"])
    assert body["items"][0]["hsn8"] == "61091000"
    q = client.get("/api/ministries/mot/products", params={"q": "cotton"}).json()
    assert 0 < q["total"] < total
    secondary = client.get("/api/ministries/dcpc/products", params={"role": "secondary"}).json()
    expected = db_conn.execute("SELECT COUNT(*) AS n FROM product_ministries WHERE ministry_id = 'dcpc' "
                               "AND role = 'secondary'").fetchone()["n"]
    assert secondary["total"] == expected
    assert any(i["hsn8"] == "28112200" for i in
               client.get("/api/ministries/dcpc/products", params={"role": "any", "q": "28112200"}).json()["items"])


def test_sector_dashboard_and_products(client, db_conn):
    body = client.get("/api/sectors/textiles").json()
    _check_dashboard(body)
    assert body["sector"]["name"] == "Textiles & Apparel" and "61" in body["sector"]["chapters"]
    assert "ministry_mix" in body and "sector_mix" not in body
    assert body["ministry_mix"][0]["ministry_id"] == "mot"
    assert all({"ministry_id", "short_name", "name", "color", "codes", "exports", "imports"} <= set(m)
               for m in body["ministry_mix"])
    assert sum(m["codes"] for m in body["ministry_mix"]) == body["kpis"]["codes"]
    products = client.get("/api/sectors/textiles/products", params={"ministry_id": "mot", "page_size": 5}).json()
    assert all(i["sector_id"] == "textiles" and i["ministry_id"] == "mot" for i in products["items"])
    tyres = client.get("/api/sectors/rubber_tyre").json()
    assert "tyre" in {v["chain_id"] for v in tyres["value_chains"]}
    assert client.get("/api/sectors/nope").status_code == 404


# =========================================================================== performance budget

@pytest.mark.parametrize("path", [
    "/api/health", "/api/meta/overview", "/api/meta/ministries", "/api/meta/sectors", "/api/meta/sections",
    "/api/hsn/search?q=tyre%20cord", "/api/hsn/search?q=4011", "/api/hsn/search?q=t", "/api/hsn/search",
    "/api/hsn/search?ministry_id=dpiit&sort=exports", "/api/hsn/suggest?q=cott", "/api/hsn/lookup/61091000",
    "/api/hsn/lookup/84", "/api/hsn/product/40111090", "/api/hsn/tree", "/api/hsn/tree?code=84",
    "/api/hsn/compare?codes=61091000,62044290,40111090,40111010,40112010", "/api/ministries/dpiit",
    "/api/ministries/mot", "/api/ministries/residual", "/api/ministries/dpiit/products?sort=imports",
    "/api/sectors/engineering", "/api/sectors/textiles", "/api/sectors/chemicals/products?q=acid",
])
def test_endpoint_within_budget(timed_get, path):
    response, seconds = timed_get(path)
    assert response.status_code == 200, response.text
    assert seconds < PERF_BUDGET_S, f"{path} took {seconds:.2f}s"


def test_api_indexes_present(db_path):
    from app.db import API_INDEXES
    conn = sqlite3.connect(str(db_path))
    try:
        names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
    finally:
        conn.close()
    assert {name for name, _ in API_INDEXES} <= names


# =========================================================================== review fixes: login throttle,
# persisted signing secret, domestic production on the ministry / sector dashboards

def test_login_throttles_repeated_failures(mutable_client):
    """F5: after 5 failed attempts for one email the endpoint answers 429 before running PBKDF2."""
    from app.routers import auth as auth_router
    auth_router.login_limiter.reset()
    try:
        email = "throttle.probe@example.com"
        for _ in range(auth_router.LOGIN_FAILURES_PER_MINUTE):
            assert mutable_client.post("/api/auth/login", json={"email": email, "password": "wrong"}).status_code == 401
        start = time.perf_counter()
        r = mutable_client.post("/api/auth/login", json={"email": email, "password": "wrong"})
        assert r.status_code == 429 and int(r.headers["Retry-After"]) >= 1
        assert time.perf_counter() - start < 0.2            # rejected without the 0.4 s hash check
        assert "try again" in r.json()["detail"].lower()
        # another account from the same client is still allowed (per-address limit is higher)
        assert mutable_client.post("/api/auth/login", json={"email": "other@example.com", "password": "wrong"}
                                   ).status_code == 401
        # the right password is accepted again once the window is cleared
        auth_router.login_limiter.reset()
        r = mutable_client.post("/api/auth/login", json={"email": "analyst@atlas.gov.in", "password": _demo_password()})
        assert r.status_code == 200, r.text
    finally:
        auth_router.login_limiter.reset()


def test_rate_limiter_semantics():
    from app.security import RateLimiter
    limiter = RateLimiter()
    assert limiter.peek("k", 2) is None
    limiter.record("k")
    limiter.record("k")
    assert limiter.peek("k", 2) is not None and limiter.check("k", 2) is not None
    assert limiter.peek("k", 0) is None                          # 0 disables the limit
    limiter.reset()
    assert limiter.check("k", 2) is None and limiter.check("k", 2) is None and limiter.check("k", 2) is not None


def test_jwt_secret_is_generated_and_persisted(tmp_path, monkeypatch):
    """F5: without ATLAS_JWT_SECRET the server signs with a random secret kept in a file, not a public string."""
    from app import config
    secret_file = tmp_path / "secrets" / ".jwt_secret"
    monkeypatch.delenv("ATLAS_JWT_SECRET", raising=False)
    monkeypatch.setenv("ATLAS_JWT_SECRET_FILE", str(secret_file))
    first = config.persisted_jwt_secret()
    assert first and len(first) >= config.MIN_SECRET_LENGTH and first != config.DEV_JWT_SECRET
    assert secret_file.is_file() and secret_file.read_text(encoding="utf-8").strip() == first
    assert config.persisted_jwt_secret() == first                 # stable within the process
    config._file_secret.pop(str(secret_file), None)             # and across processes (re-read from the file)
    assert config.persisted_jwt_secret() == first
    settings = config.get_settings()
    assert settings.jwt_secret == first and settings.jwt_secret_source == "file"
    assert settings.jwt_secret_is_default is False
    # a token forged with the public development secret is rejected
    forged = encode_jwt({"sub": "1", "role": "admin", "exp": int(time.time()) + 600}, config.DEV_JWT_SECRET)
    with pytest.raises(TokenError):
        decode_jwt(forged, settings.jwt_secret)
    # the environment variable still wins
    monkeypatch.setenv("ATLAS_JWT_SECRET", "env-secret-override-value")
    assert config.get_settings().jwt_secret_source == "env"


def test_forged_dev_secret_token_is_rejected_by_the_api(client, monkeypatch):
    """Against the running app: an admin token signed with the documented dev secret must not open /api/admin."""
    from app import config
    monkeypatch.delenv("ATLAS_JWT_SECRET", raising=False)
    if config.get_settings().jwt_secret_source == "development":
        pytest.skip("no writable secret file on this machine - development secret in use")
    forged = encode_jwt({"sub": "1", "email": "x", "role": "admin", "ministry_id": None, "name": "x",
                         "exp": int(time.time()) + 600}, config.DEV_JWT_SECRET)
    assert client.get("/api/admin/users", headers={"Authorization": f"Bearer {forged}"}).status_code == 401


def test_dashboards_show_domestic_production(client, db_conn):
    """Each ministry sees the domestic production figures of its chains and codes."""
    body = client.get("/api/ministries/dpiit").json()
    production = body["production"]
    assert production and body["kpis"]["production_figures"] == len(production)
    keys = {"scope", "key", "label", "display_label", "year", "value", "unit", "source", "status", "provenance",
            "chain_id", "n_rows"}
    assert all(keys <= set(p) for p in production)
    assert all("playbook_value" not in p and "playbook_unit" not in p for p in production)
    tyre = next(p for p in production if p["scope"] == "chain" and p["key"] == "tyre" and p["label"] == "india_production")
    assert (tyre["value"], tyre["unit"], tyre["status"], tyre["source"]) == (217e6, "units", "verified", "atma")
    assert tyre["provenance"]["status"] == "verified" and "ATMA" in tyre["provenance"]["label"]
    assert "Tyre" in tyre["display_label"]
    output = next(p for p in production if p["scope"] == "chain" and p["key"] == "tyre" and p["label"] == "india_output")
    assert output["source"] == "unido_indstat" and output["value"] == pytest.approx(12_915_508_082)
    assert body["provenance"]["production"]["status"] == "verified"
    doc = client.get("/api/ministries/doc").json()["production"]
    assert {p["key"] for p in doc if p["scope"] == "chain"} >= {"natural_rubber", "tyre"}
    sector = client.get("/api/sectors/rubber_tyre").json()
    assert any(p["key"] == "tyre" for p in sector["production"]) and "production" in sector["provenance"]
    # a ministry outside every chain (and without code-level rows) says Not available instead of inventing a figure
    for mid in [r["id"] for r in db_conn.execute("SELECT id FROM ministries WHERE id <> 'residual'").fetchall()]:
        dash = client.get(f"/api/ministries/{mid}").json()
        if not dash["value_chains"]:
            assert dash["production"] == [] and dash["provenance"]["production"]["status"] == "not_available"
            break


def test_meta_flow_columns_are_consistent(client):
    """Every column of the ownership flow adds up to the same number of current lines, and links match nodes."""
    d = client.get("/api/meta/flow").json()
    total = d["total_codes"]
    assert total > 10000
    for col in ("sectors", "ministries", "statuses"):
        assert sum(n["codes"] for n in d[col]) == total, col
    assert sum(l["codes"] for l in d["sector_ministry"]) == total
    assert sum(l["codes"] for l in d["ministry_status"]) == total
    sec = {n["id"] for n in d["sectors"]}
    mins = {n["id"] for n in d["ministries"]}
    sts = {n["id"] for n in d["statuses"]}
    assert all(l["source"] in sec and l["target"] in mins for l in d["sector_ministry"])
    assert all(l["source"] in mins and l["target"] in sts for l in d["ministry_status"])
    residual = next(n for n in d["ministries"] if n["id"] == "residual")
    assert residual["codes"] == next(n for n in d["statuses"] if n["id"] == "residual")["codes"]

    # The exact sector x ministry x status combinations add up to every column and every 2-way link,
    # so a drill-down can never disagree with the tree it came from.
    triples = d["sector_ministry_status"]
    assert triples and sum(t["codes"] for t in triples) == total
    assert all(t["sector"] in sec and t["ministry"] in mins and t["status"] in sts for t in triples)
    def fold(idx: int) -> dict[tuple[str, ...], int]:
        out: dict[tuple[str, ...], int] = {}
        for t in triples:
            key = tuple(v for i, v in enumerate((t["sector"], t["ministry"], t["status"])) if i != idx)
            out[key] = out.get(key, 0) + t["codes"]
        return out
    assert fold(2) == {(l["source"], l["target"]): l["codes"] for l in d["sector_ministry"]}
    assert fold(0) == {(l["source"], l["target"]): l["codes"] for l in d["ministry_status"]}


def test_meta_flow_detail_resolves_one_combination(client):
    """A tree click resolves to exact lines: totals, labels, breakdowns and top lines agree with the triple."""
    flow = client.get("/api/meta/flow").json()
    triple = next(t for t in flow["sector_ministry_status"]
                  if t["sector"] not in ("other",) and t["ministry"] not in ("other", "residual")
                  and t["status"] != "residual")
    params = {"sector_id": triple["sector"], "ministry_id": triple["ministry"], "status": triple["status"]}
    d = client.get("/api/meta/flow/detail", params=params).json()
    assert d["filters"] == params
    assert d["total_codes"] == triple["codes"] and d["total_codes"] > 0
    assert d["total_codes_all"] == flow["total_codes"]
    assert d["share"] == pytest.approx(triple["codes"] / flow["total_codes"], abs=1e-6)
    assert d["exports"] == pytest.approx(triple["exports"], rel=1e-6)
    assert d["labels"]["sector"] and d["labels"]["ministry"] and d["labels"]["status"]
    assert d["labels"]["sector"] != triple["sector"]
    # A concrete combination has exactly one row in each breakdown, each carrying the whole selection.
    for col in ("sectors", "ministries", "statuses"):
        assert len(d["breakdown"][col]) == 1, col
        assert d["breakdown"][col][0]["codes"] == triple["codes"], col
    assert d["breakdown"]["sectors"][0]["id"] == triple["sector"]
    assert d["breakdown"]["ministries"][0]["id"] == triple["ministry"]
    assert d["breakdown"]["statuses"][0]["id"] == triple["status"]
    assert 1 <= len(d["top_lines"]) <= 6
    assert all(l["sector_id"] == triple["sector"] and l["ministry_id"] == triple["ministry"]
               and l["status"] == triple["status"] for l in d["top_lines"])
    assert d["exports"] >= d["top_lines"][0]["exports"] >= d["top_lines"][-1]["exports"]
    assert d["provenance"]["mapping"]["status"] == "verified"


def test_meta_flow_detail_other_and_residual(client):
    """Folded tails stay selectable, resolve to their real members, and the residual status is exact."""
    flow = client.get("/api/meta/flow").json()
    triples = flow["sector_ministry_status"]
    other = client.get("/api/meta/flow/detail", params={"sector_id": "other", "ministry_id": "other"}).json()
    assert other["total_codes"] == sum(t["codes"] for t in triples
                                       if t["sector"] == "other" and t["ministry"] == "other")
    top_sectors = {n["id"] for n in flow["sectors"] if n["id"] != "other"}
    top_ministries = {n["id"] for n in flow["ministries"] if n["id"] not in ("other", "residual")}
    assert other["breakdown"]["sectors"]
    assert all(r["id"] not in top_sectors for r in other["breakdown"]["sectors"])
    assert all(r["id"] not in top_ministries for r in other["breakdown"]["ministries"])
    assert other["labels"]["sector"].endswith("other sectors")
    assert other["labels"]["ministry"].endswith("other ministries")

    residual = next(n for n in flow["ministries"] if n["id"] == "residual")
    d = client.get("/api/meta/flow/detail", params={"status": "residual"}).json()
    assert d["total_codes"] == residual["codes"] == flow["statuses"][-1]["codes"]
    assert d["labels"]["status"] == flow["statuses"][-1]["name"]
    assert [r["id"] for r in d["breakdown"]["statuses"]] == ["residual"]

    unfiltered = client.get("/api/meta/flow/detail").json()
    assert unfiltered["total_codes"] == flow["total_codes"] and unfiltered["share"] == 1
    assert sum(r["codes"] for r in unfiltered["breakdown"]["statuses"]) == flow["total_codes"]


def test_meta_flow_detail_rejects_unknown_nodes(client):
    """Only nodes visible in the tree can be selected; everything else is a 404 rather than a guess."""
    for params in ({"sector_id": "not_a_sector"}, {"ministry_id": "not_a_ministry"},
                   {"status": "not_a_status"}):
        r = client.get("/api/meta/flow/detail", params=params)
        assert r.status_code == 404, params
        assert "Unknown flow" in r.json()["detail"]
