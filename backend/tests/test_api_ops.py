"""Operations API tests (owner C3): residual workbench, helpdesk, data hub + connectors, reports, admin / roadmap /
risks / watchlist and the AI assistant (docs/SPEC.md sections 6.9-6.14).

Run from ``backend/``: ``python -m pytest -q tests/test_api_ops.py``.

* Read-only checks use the session ``client`` on the real database (no writes: reports, lists, the offline
  assistant and the suggestion model only read).
* Everything that writes runs on a private COPY of the database: ``module_mutable_client`` (one copy shared by this
  module - each test creates its own records and asserts on them only) or, for the residual approve flow and the
  OEC connector, the function-scoped ``mutable_client`` / ``mutable_conn`` / ``mutable_db_path``.
* External HTTP is never touched: connector tests replace ``app.services.connectors.base.http_get_json`` and the
  Claude-mode tests inject a fake Anthropic client (or replace ``chat_claude``).
"""
from __future__ import annotations

import csv
import io
import sqlite3
from types import SimpleNamespace

import pytest

# Lines used throughout (present in every build of the Atlas; see the ETL tests).
TYRE_LINE = "40111010"          # new pneumatic radial car tyres (DPIIT, value chain "tyre")
MOT_LINE = "61091000"           # cotton T-shirts - Ministry of Textiles


# --------------------------------------------------------------------------- helpers / fixtures

def _open(path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), timeout=10)
    conn.row_factory = lambda cur, values: {c[0]: v for c, v in zip(cur.description, values)}
    return conn


def _one(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> dict | None:
    return conn.execute(sql, params).fetchone()


@pytest.fixture(autouse=True)
def _no_suggest_warmup(monkeypatch):
    """The residual list starts a background fit of the suggestion model; keep test runs deterministic."""
    from app.services import suggest
    monkeypatch.setattr(suggest, "warm_async", lambda *_a, **_k: None)


@pytest.fixture(autouse=True)
def _offline_assistant(monkeypatch):
    """No test may reach the Anthropic API: the assistant runs offline unless a test injects a fake client."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


@pytest.fixture(scope="module")
def ops(module_mutable_client):
    """The module's mutable client plus a helper connection factory on its database copy."""
    client = module_mutable_client
    client.conn = lambda: _open(client.db_path)
    return client


def _free_residual_line(conn: sqlite3.Connection, chapter: str | None = None) -> dict:
    """A current residual line without any claim (so a test owns its claims)."""
    where = "AND hs2 = ?" if chapter else ""
    params = (chapter,) if chapter else ()
    found = _one(conn, f"""SELECT hsn8, hs2, description FROM products
                          WHERE mapping_status = 'residual' AND is_current = 1 {where}
                            AND hsn8 NOT IN (SELECT hsn8 FROM residual_claims)
                          ORDER BY hsn8 LIMIT 1""", params)
    assert found, "the build has no unclaimed residual line"
    return found


def _accepted_line(conn: sqlite3.Connection, ministry_id: str, offset: int = 0) -> dict:
    found = _one(conn, "SELECT hsn8, description FROM products WHERE ministry_id = ? AND mapping_status = 'accepted' "
                       "AND is_current = 1 ORDER BY hsn8 LIMIT 1 OFFSET ?", (ministry_id, offset))
    assert found, f"no accepted line for {ministry_id}"
    return found


def _csv_bytes(rows: list[list]) -> bytes:
    buffer = io.StringIO()
    csv.writer(buffer, lineterminator="\n").writerows(rows)
    return buffer.getvalue().encode("utf-8")


def _upload(client, headers, kind: str, filename: str, content: bytes):
    media = "text/csv" if filename.endswith(".csv") else \
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    return client.post("/api/datahub/upload", headers=headers, data={"kind": kind},
                       files={"file": (filename, content, media)})


# =========================================================================== 6.9 residual workbench

class TestResidual:
    def test_list_requires_gov(self, client, industry_headers):
        assert client.get("/api/residual").status_code == 401
        assert client.get("/api/residual", headers=industry_headers).status_code == 403

    def test_list_residual_lines(self, client, analyst_headers, db_conn):
        r = client.get("/api/residual?page_size=5", headers=analyst_headers)
        assert r.status_code == 200, r.text
        body = r.json()
        expected = db_conn.execute("SELECT COUNT(*) AS n FROM products WHERE mapping_status = 'residual' "
                                   "AND is_current = 1").fetchone()["n"]
        assert body["total"] == expected > 0
        assert body["page"] == 1 and body["page_size"] == 5 and len(body["items"]) == 5
        for item in body["items"]:
            assert item["mapping_status"] == "residual"
            assert isinstance(item["pending_claims"], int)
            assert {"hsn8", "description", "exports", "imports", "ministry_id"} <= set(item)
        assert body["summary"]["residual_codes"] == expected

    def test_list_text_filter(self, client, analyst_headers):
        r = client.get("/api/residual?q=clay&page_size=50", headers=analyst_headers)
        assert r.status_code == 200
        items = r.json()["items"]
        assert items and all(i["mapping_status"] == "residual" for i in items)

    def test_suggestions(self, client, analyst_headers, db_conn):
        line = _one(db_conn, "SELECT hsn8 FROM products WHERE mapping_status = 'residual' AND hs2 = '25' "
                             "AND description LIKE '%clay%' ORDER BY hsn8 LIMIT 1") \
            or _one(db_conn, "SELECT hsn8 FROM products WHERE mapping_status = 'residual' ORDER BY hsn8 LIMIT 1")
        r = client.get(f"/api/residual/suggest/{line['hsn8']}", headers=analyst_headers)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["hsn8"] == line["hsn8"]
        assert body["provenance"]["source"] == "model" and body["provenance"]["status"] == "not_verified"
        suggestions = body["suggestions"]
        assert suggestions, "expected at least one suggested ministry"
        scores = [s["score"] for s in suggestions]
        assert scores == sorted(scores, reverse=True) and 0 < scores[0] <= 1 and sum(scores) <= 1.0001
        top = suggestions[0]
        assert {"id", "short_name", "name", "color"} <= set(top["ministry"])
        assert top["ministry"]["id"] != "residual"
        assert top["similar"] and all(s["hsn8"] != line["hsn8"] for s in top["similar"])
        # the neighbours that vote are accepted lines of the suggested ministry
        for s in top["similar"]:
            owner = _one(db_conn, "SELECT ministry_id, mapping_status FROM products WHERE hsn8 = ?", (s["hsn8"],))
            assert owner["mapping_status"] == "accepted" and owner["ministry_id"] == top["ministry"]["id"]
        if line["hsn8"].startswith("2508"):  # clays: the Ministry of Mines owns the other chapter-25 clays
            assert top["ministry"]["id"] == "mom"

    def test_suggestions_unknown_code(self, client, analyst_headers):
        assert client.get("/api/residual/suggest/00000000", headers=analyst_headers).status_code == 404
        assert client.get("/api/residual/suggest/40111010").status_code == 401

    def test_claims_list(self, client, analyst_headers, industry_headers):
        r = client.get("/api/residual/claims", headers=analyst_headers)
        assert r.status_code == 200
        for claim in r.json():
            assert {"id", "hsn8", "description", "ministry", "claimed_by_name", "justification", "status",
                    "created_at", "reviewed_at", "review_note"} <= set(claim)
            assert {"id", "short_name", "name", "color"} <= set(claim["ministry"])
        assert client.get("/api/residual/claims", headers=industry_headers).status_code == 403
        pending = client.get("/api/residual/claims?status=pending", headers=analyst_headers).json()
        assert all(c["status"] == "pending" for c in pending)

    def test_claim_rules(self, ops, ministry_headers, analyst_headers, industry_headers):
        conn = ops.conn()
        try:
            line = _free_residual_line(conn)
            accepted = _accepted_line(conn, "mot")
        finally:
            conn.close()
        body = {"justification": "Textile fibres are within the Ministry of Textiles' allocation of business."}
        url = f"/api/residual/{line['hsn8']}/claim"
        assert ops.post(url, json=body).status_code == 401
        assert ops.post(url, json=body, headers=industry_headers).status_code == 403
        assert ops.post(url, json=body, headers=analyst_headers).status_code == 403
        # a ministry user can only claim for its own ministry
        assert ops.post(url, json={**body, "ministry_id": "dpiit"}, headers=ministry_headers).status_code == 403
        assert ops.post(url, json={"justification": "short"}, headers=ministry_headers).status_code == 422
        # an accepted line cannot be claimed
        r = ops.post(f"/api/residual/{accepted['hsn8']}/claim", json=body, headers=ministry_headers)
        assert r.status_code == 409
        r = ops.post(url, json=body, headers=ministry_headers)
        assert r.status_code == 201, r.text
        claim = r.json()
        assert claim["hsn8"] == line["hsn8"] and claim["status"] == "pending"
        assert claim["ministry"]["id"] == "mot" and claim["claimed_by_name"]
        # duplicate pending claim by the same ministry
        assert ops.post(url, json=body, headers=ministry_headers).status_code == 409
        # the workbench list now counts the claim
        listed = ops.get(f"/api/residual?q={line['hsn8']}", headers=analyst_headers).json()["items"]
        row = next(i for i in listed if i["hsn8"] == line["hsn8"])
        assert row["pending_claims"] == 1 and row["claimed_by"] == ["mot"]

    def test_review_requires_admin(self, ops, ministry_headers, analyst_headers, admin_headers):
        conn = ops.conn()
        try:
            line = _free_residual_line(conn)
        finally:
            conn.close()
        claim = ops.post(f"/api/residual/{line['hsn8']}/claim", headers=admin_headers,
                         json={"ministry_id": "dpiit", "justification": "Nodal department until the owner is settled."})
        assert claim.status_code == 201, claim.text
        url = f"/api/residual/claims/{claim.json()['id']}/review"
        assert ops.post(url, json={"decision": "approve"}, headers=ministry_headers).status_code == 403
        assert ops.post(url, json={"decision": "approve"}, headers=analyst_headers).status_code == 403
        assert ops.post(url, json={"decision": "maybe"}, headers=admin_headers).status_code == 422
        r = ops.post(url, json={"decision": "reject", "note": "Insufficient justification"}, headers=admin_headers)
        assert r.status_code == 200, r.text
        assert r.json()["claim"]["status"] == "rejected" and r.json()["claim"]["review_note"]
        assert r.json()["mapping_change"] is None
        assert ops.post(url, json={"decision": "approve"}, headers=admin_headers).status_code == 409
        assert ops.post("/api/residual/claims/999999/review", json={"decision": "approve"},
                        headers=admin_headers).status_code == 404

    def test_approve_flow(self, mutable_client, mutable_conn, ministry_headers, dpiit_headers, admin_headers):
        line = _free_residual_line(mutable_conn)
        hsn8 = line["hsn8"]
        mot = mutable_client.post(f"/api/residual/{hsn8}/claim", headers=ministry_headers,
                                  json={"justification": "Covered by the Ministry of Textiles' business rules."})
        dpiit = mutable_client.post(f"/api/residual/{hsn8}/claim", headers=dpiit_headers,
                                    json={"justification": "DPIIT is the nodal department for this product."})
        assert mot.status_code == 201 and dpiit.status_code == 201
        claim_id = mot.json()["id"]

        r = mutable_client.post(f"/api/residual/claims/{claim_id}/review", headers=admin_headers,
                                json={"decision": "approve", "note": "Agreed in the inter-ministerial meeting"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["claim"]["status"] == "approved" and body["claim"]["reviewed_at"]
        assert body["product"]["ministry_id"] == "mot" and body["product"]["mapping_status"] == "accepted"
        assert body["mapping_change"]["old_ministry_id"] == "residual"
        assert body["mapping_change"]["new_ministry_id"] == "mot"
        assert body["superseded_claims"] == [dpiit.json()["id"]]

        product = _one(mutable_conn, "SELECT rowid AS rid, ministry_id, mapping_status, mapping_source, "
                                     "mapping_confidence, mapping_rule FROM products WHERE hsn8 = ?", (hsn8,))
        assert product["ministry_id"] == "mot" and product["mapping_status"] == "accepted"
        assert product["mapping_source"] == "manual" and product["mapping_confidence"] == 1.0
        assert product["mapping_rule"] == f"claim:{claim_id}"
        owners = mutable_conn.execute("SELECT ministry_id, role FROM product_ministries WHERE hsn8 = ?",
                                      (hsn8,)).fetchall()
        assert {"ministry_id": "mot", "role": "primary"} in owners
        assert not [o for o in owners if o["role"] == "primary" and o["ministry_id"] != "mot"]
        change = _one(mutable_conn, "SELECT * FROM mapping_changes WHERE hsn8 = ? ORDER BY id DESC LIMIT 1", (hsn8,))
        assert change["old_ministry_id"] == "residual" and change["new_ministry_id"] == "mot"
        assert change["source"] == "claim"
        fts = _one(mutable_conn, "SELECT ministry FROM products_fts WHERE rowid = ?", (product["rid"],))
        assert "Textiles" in fts["ministry"]
        other = _one(mutable_conn, "SELECT status, review_note FROM residual_claims WHERE id = ?",
                     (dpiit.json()["id"],))
        assert other["status"] == "rejected" and "Superseded" in other["review_note"]
        actions = {a["action"] for a in mutable_conn.execute(
            "SELECT action FROM audit_log WHERE entity_id IN (?, ?)", (str(claim_id), hsn8)).fetchall()}
        assert {"claim.create", "claim.review", "mapping.change"} <= actions

        # the line has left the residual list and is found under its new owner
        residual = mutable_client.get(f"/api/residual?q={hsn8}", headers=admin_headers).json()["items"]
        assert all(i["hsn8"] != hsn8 for i in residual)
        mot_lines = mutable_client.get(f"/api/hsn/search?q={hsn8}&ministry_id=mot").json()["items"]
        assert any(i["hsn8"] == hsn8 for i in mot_lines)


# =========================================================================== 6.10 helpdesk

class TestTickets:
    def _ticket(self, **extra) -> dict:
        body = {"subject": "Classification of a new product", "category": "classification",
                "submitter_name": "Guest Exporter",
                "body": "Please confirm the correct tariff line and the concerned ministry for our product."}
        body.update(extra)
        return body

    def test_public_ticket_routed_to_owner(self, ops, db_conn):
        owner = _one(db_conn, "SELECT ministry_id FROM products WHERE hsn8 = ?", (MOT_LINE,))["ministry_id"]
        r = ops.post("/api/tickets", json=self._ticket(hsn8=MOT_LINE, submitter_name="Guest Exporter",
                                                         submitter_email="guest@example.com"))
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["routed_ministry"]["id"] == owner
        assert body["ticket"]["routed_ministry_id"] == owner and body["ticket"]["status"] == "open"
        assert body["ticket"]["submitted_by"] is None

    def test_residual_or_no_code_routes_to_dpiit(self, ops):
        conn = ops.conn()
        try:
            residual = _one(conn, "SELECT hsn8 FROM products WHERE mapping_status = 'residual' LIMIT 1")["hsn8"]
        finally:
            conn.close()
        for extra in ({"hsn8": residual}, {}):
            r = ops.post("/api/tickets", json=self._ticket(**extra))
            assert r.status_code == 201, r.text
            assert r.json()["routed_ministry"]["id"] == "dpiit"

    def test_validation(self, ops):
        assert ops.post("/api/tickets", json={"subject": "x", "body": "too short"}).status_code == 422
        anonymous = {k: v for k, v in self._ticket().items() if k != "submitter_name"}
        assert ops.post("/api/tickets", json=anonymous).status_code == 422  # guests must give a name
        r = ops.post("/api/tickets", json=self._ticket(hsn8="12"))
        assert r.status_code in (400, 404, 422)

    def test_role_scoped_lists(self, ops, industry_headers, ministry_headers, analyst_headers, admin_headers):
        mine = ops.post("/api/tickets", json=self._ticket(hsn8=MOT_LINE), headers=industry_headers)
        assert mine.status_code == 201
        assert mine.json()["ticket"]["submitted_by"] is not None
        me = ops.get("/api/auth/me", headers=industry_headers).json()
        assert ops.get("/api/tickets").status_code == 401

        own = ops.get("/api/tickets?page_size=200", headers=industry_headers).json()
        assert own["total"] >= 1 and all(t["submitted_by"] == me["id"] for t in own["items"])
        routed = ops.get("/api/tickets?page_size=200", headers=ministry_headers).json()
        assert routed["total"] >= 1 and all(t["routed_ministry_id"] == "mot" for t in routed["items"])
        everything = ops.get("/api/tickets?page_size=200", headers=analyst_headers).json()
        assert everything["total"] >= routed["total"] and everything["total"] >= own["total"]
        assert ops.get("/api/tickets?page_size=200", headers=admin_headers).json()["total"] == everything["total"]
        assert {"items", "total", "page", "page_size"} <= set(everything)

    def test_detail_messages_and_status(self, ops, industry_headers, ministry_headers, dpiit_headers, admin_headers):
        created = ops.post("/api/tickets", json=self._ticket(hsn8=MOT_LINE), headers=industry_headers).json()
        tid = created["ticket"]["id"]
        detail = ops.get(f"/api/tickets/{tid}", headers=ministry_headers)
        assert detail.status_code == 200
        assert detail.json()["product"]["hsn8"] == MOT_LINE and isinstance(detail.json()["messages"], list)
        assert ops.get(f"/api/tickets/{tid}", headers=dpiit_headers).status_code == 403
        assert ops.get(f"/api/tickets/{tid}").status_code == 401
        assert ops.get("/api/tickets/999999", headers=admin_headers).status_code == 404

        # a reply by the routed ministry moves an open ticket to in_progress
        r = ops.post(f"/api/tickets/{tid}/messages", json={"body": "The applicable line is 6109.10.00."},
                     headers=ministry_headers)
        assert r.status_code in (200, 201), r.text
        assert ops.post(f"/api/tickets/{tid}/messages", json={"body": "Not my ticket"},
                        headers=dpiit_headers).status_code == 403
        detail = ops.get(f"/api/tickets/{tid}", headers=industry_headers).json()
        assert detail["ticket"]["status"] == "in_progress"
        assert any("6109.10.00" in m["body"] for m in detail["messages"])

        # status: only the routed ministry (or an admin)
        assert ops.post(f"/api/tickets/{tid}/status", json={"status": "resolved"},
                        headers=dpiit_headers).status_code == 403
        assert ops.post(f"/api/tickets/{tid}/status", json={"status": "resolved"},
                        headers=industry_headers).status_code == 403
        assert ops.post(f"/api/tickets/{tid}/status", json={"status": "closed"},
                        headers=ministry_headers).status_code == 422
        r = ops.post(f"/api/tickets/{tid}/status", json={"status": "resolved"}, headers=ministry_headers)
        assert r.status_code == 200, r.text
        assert ops.get(f"/api/tickets/{tid}", headers=admin_headers).json()["ticket"]["status"] == "resolved"

    def test_stats(self, ops, analyst_headers, industry_headers):
        assert ops.get("/api/tickets/stats", headers=industry_headers).status_code == 403
        r = ops.get("/api/tickets/stats", headers=analyst_headers)
        assert r.status_code == 200
        body = r.json()
        assert {"by_status", "by_ministry", "avg_resolution_hours"} <= set(body)
        assert sum(s["count"] for s in body["by_status"]) == body["total"]


# =========================================================================== 6.11 data hub

class TestDataHubSources:
    def test_sources_public(self, client):
        r = client.get("/api/datahub/sources")
        assert r.status_code == 200
        sources = {s["id"]: s for s in r.json()}
        assert {"oec_baci", "un_comtrade", "wits_trains", "cbic", "gstn", "dgft"} <= set(sources)
        for s in sources.values():
            assert {"id", "name", "owner", "kind", "status", "last_refreshed", "records", "url", "licence",
                    "description", "refresh_cron", "connector"} <= set(s)
        assert sources["cbic"]["connector"]["configured"] is False
        assert "ATLAS_CBIC_API_KEY" in sources["cbic"]["connector"]["required_env"]
        assert sources["oec_baci"]["connector"]["refreshable"] is True

    def test_refresh_permissions(self, client, analyst_headers, ministry_headers):
        assert client.post("/api/datahub/sources/cbic/refresh").status_code == 401
        assert client.post("/api/datahub/sources/cbic/refresh", headers=analyst_headers).status_code == 403
        assert client.post("/api/datahub/sources/cbic/refresh", headers=ministry_headers).status_code == 403

    @pytest.mark.parametrize("source_id, env", [("cbic", "ATLAS_CBIC_API_KEY"), ("gstn", "ATLAS_GSTN_API_KEY"),
                                                ("dgft", "ATLAS_DGFT_API_KEY")])
    def test_gov_connectors_not_configured(self, ops, admin_headers, monkeypatch, source_id, env):
        monkeypatch.delenv(env, raising=False)
        r = ops.post(f"/api/datahub/sources/{source_id}/refresh", headers=admin_headers)
        assert r.status_code == 200, r.text
        job = r.json()["job"]
        assert job["status"] == "not_configured" and env in job["message"]
        jobs = ops.get(f"/api/datahub/jobs?source_id={source_id}", headers=admin_headers).json()
        assert jobs and jobs[0]["id"] == job["id"]
        source = next(s for s in ops.get("/api/datahub/sources").json() if s["id"] == source_id)
        assert source["status"] == "not_configured"

    def test_refresh_file_and_unknown_sources(self, ops, admin_headers):
        assert ops.post("/api/datahub/sources/gst_hsn/refresh", headers=admin_headers).status_code == 400
        assert ops.post("/api/datahub/sources/nope/refresh", headers=admin_headers).status_code == 404

    def test_jobs_gov_only(self, client, analyst_headers, industry_headers):
        assert client.get("/api/datahub/jobs", headers=analyst_headers).status_code == 200
        assert client.get("/api/datahub/jobs", headers=industry_headers).status_code == 403
        assert client.get("/api/datahub/jobs").status_code == 401

    def test_comtrade_refresh_mocked(self, ops, admin_headers, analyst_headers, monkeypatch):
        """The comtrade connector end to end (background thread) against a fake Comtrade API."""
        from app.services import connectors
        from app.services.connectors import base, comtrade

        conn = ops.conn()
        try:
            baci = {r["hs6"]: r for r in conn.execute(
                "SELECT hs6, india_exports, india_imports FROM trade_hs6 WHERE year = 2023").fetchall()}
            expected_codes = comtrade.chain_hs6_codes(conn)
        finally:
            conn.close()
        assert expected_codes
        calls: list[dict] = []

        def fake_get_json(url, params=None, **_kw):
            assert url == comtrade.COMTRADE_URL
            assert params["reporterCode"] == "699" and params["partnerCode"] == "0"
            assert params["flowCode"] == "X,M" and params["period"] == "2023"
            codes = params["cmdCode"].split(",")
            assert len(codes) <= 250
            calls.append(params)
            data = []
            for code in codes:
                ref = baci.get(code)
                if not ref:
                    continue
                for flow, value in (("X", ref["india_exports"]), ("M", ref["india_imports"])):
                    if value:
                        data.append({"cmdCode": code, "flowCode": flow, "primaryValue": value * 1.05,
                                     "partnerCode": 0, "partner2Code": 0, "customsCode": "C00", "motCode": 0})
                        # a non-aggregate row (by customs procedure) that must be ignored
                        data.append({"cmdCode": code, "flowCode": flow, "primaryValue": 1.0,
                                     "partnerCode": 0, "partner2Code": 0, "customsCode": "C01", "motCode": 0})
            return {"data": data, "error": ""}

        monkeypatch.setattr(base, "http_get_json", fake_get_json)
        monkeypatch.setattr(comtrade, "PAUSE_S", 0)
        r = ops.post("/api/datahub/sources/un_comtrade/refresh", headers=admin_headers)
        assert r.status_code == 200, r.text
        job = r.json()["job"]
        assert connectors.wait_for(job["id"], timeout=60)
        done = ops.get(f"/api/datahub/jobs/{job['id']}", headers=analyst_headers).json()
        assert done["status"] == "success", done["message"]
        assert done["records"] > 0 and calls
        assert sum(len(c["cmdCode"].split(",")) for c in calls) == len(expected_codes)

        quality = ops.get("/api/datahub/quality", headers=analyst_headers).json()
        checks = quality["cross_checks"]
        assert checks
        for c in checks:
            assert {"hs6", "year", "flow", "comtrade_value", "baci_value", "diff_pct"} <= set(c)
            if c["diff_pct"] is not None:
                assert c["diff_pct"] == pytest.approx(0.05, abs=1e-6)
        source = next(s for s in ops.get("/api/datahub/sources").json() if s["id"] == "un_comtrade")
        assert source["status"] == "connected" and source["last_refreshed"]

    def test_comtrade_failure_marks_job_failed(self, ops, admin_headers, monkeypatch):
        from app.services import connectors
        from app.services.connectors import base, comtrade

        def boom(*_a, **_kw):
            raise base.ConnectorError("HTTP 503 from comtrade")

        monkeypatch.setattr(base, "http_get_json", boom)
        monkeypatch.setattr(comtrade, "PAUSE_S", 0)
        job = ops.post("/api/datahub/sources/comtrade/refresh", headers=admin_headers).json()["job"]
        assert connectors.wait_for(job["id"], timeout=60)
        done = ops.get(f"/api/datahub/jobs/{job['id']}", headers=admin_headers).json()
        assert done["status"] == "failed" and "503" in done["message"]

    def test_oec_connector_apply(self, mutable_db_path, monkeypatch):
        """OEC refresh (mocked API) rewrites trade_hs6 and recomputes the India columns of hs6_metrics."""
        from app.db import connect
        from app.services.connectors import base, oec

        conn = connect(mutable_db_path)
        try:
            conn.execute("DROP TABLE IF EXISTS trade_hs8")
            hs6 = "401110"
            before = conn.execute("SELECT india_exports, world_trade FROM trade_hs6 WHERE hs6 = ? AND year = 2024",
                                  (hs6,)).fetchone()
            assert before and before["world_trade"]
            new_value = 4_321_000_000.0

            def fake_get_json(url, params=None, **_kw):
                assert url == oec.OEC_URL and params["cube"] == oec.CUBE
                side = "Exporter" if "Exporter Country" in params else "Importer"
                assert params[f"{side} Country"] == "asind"
                value = new_value if side == "Exporter" else 1_000_000.0
                data = [{"HS6 ID": f"7{hs6}", "Year": y, "Trade Value": value / (1 + (2024 - y) * 0.1)}
                        for y in oec.YEARS]
                return {"data": data, "page": {"total": len(data)}}

            monkeypatch.setattr(base, "http_get_json", fake_get_json)
            monkeypatch.setattr(oec, "MIN_ROWS", 1)
            result = oec.connector.run(conn, base.no_progress)
            assert result.status == "success" and result.records > 0
            after = conn.execute("SELECT india_exports, india_imports FROM trade_hs6 WHERE hs6 = ? AND year = 2024",
                                 (hs6,)).fetchone()
            assert after["india_exports"] == pytest.approx(new_value)
            metrics = conn.execute("SELECT india_exports, india_imports, trade_balance, rca, india_world_share, "
                                   "export_yoy FROM hs6_metrics WHERE hs6 = ?", (hs6,)).fetchone()
            assert metrics["india_exports"] == pytest.approx(new_value)
            assert metrics["trade_balance"] == pytest.approx(new_value - 1_000_000.0)
            assert metrics["india_world_share"] == pytest.approx(new_value / before["world_trade"])
            assert metrics["rca"] is not None and metrics["rca"] > 0
            assert metrics["export_yoy"] == pytest.approx(1.1 - 1.0)
            assert conn.execute("SELECT value FROM meta WHERE key = 'oec_refreshed_at'").fetchone()
        finally:
            conn.close()

    def test_oec_truncated_pull_is_refused(self, monkeypatch):
        from app.services.connectors import base, oec
        monkeypatch.setattr(base, "http_get_json", lambda *_a, **_k: {"data": [], "page": {"total": 0}})
        with pytest.raises(base.ConnectorError):
            oec.connector.fetch_flow("Exporter", base.no_progress)

    def test_wits_parser(self, monkeypatch):
        from app.services.connectors import base, wits
        payload = {
            "structure": {
                "dimensions": {"series": [
                    {"id": "FREQ", "values": [{"id": "A"}]},
                    {"id": "REPORTER", "values": [{"id": "356"}]},
                    {"id": "PRODUCTCODE", "values": [{"id": "401110", "name": "Tyres"},
                                                     {"id": "220421", "name": "Wine"}]}]},
                "attributes": {"observation": [
                    {"id": "TOTALNOOFLINES", "values": [{"name": "3"}, {"name": "1"}]},
                    {"id": "NBR_MFN_LINES", "values": [{"name": "3"}, {"name": "0"}]},
                    {"id": "NBR_NA_LINES", "values": [{"name": "0"}, {"name": "1"}]},
                    {"id": "MIN_RATE", "values": [{"name": "10"}]},
                    {"id": "MAX_RATE", "values": [{"name": "15"}]}]}},
            "dataSets": [{"series": {
                "0:0:0": {"observations": {"0": [12.5, 0, 0, 0, 0, 0]}},
                "0:0:1": {"observations": {"0": [None, 1, 1, 1, None, None]}}}}],
        }
        records = wits.parse_sdmx(payload)
        rows = {r[0]: r for r in (wits.tariff_row(rec, 2022) for rec in records) if r}
        assert rows["401110"][1:4] == (12.5, 10.0, 15.0) and rows["401110"][4] == 3
        assert rows["220421"][1] is None  # non-ad-valorem only -> no average
        monkeypatch.setattr(base, "http_get_json", lambda *_a, **_k: payload)
        with pytest.raises(base.ConnectorError):  # 2 rows << MIN_ROWS: a truncated pull is refused
            wits.connector.run(None, base.no_progress)


class TestDataHubUploads:
    def test_templates(self, client):
        kinds = {t["kind"] for t in client.get("/api/datahub/templates").json()}
        assert kinds == {"ministry_mapping", "production", "value_chain_edges"}
        r = client.get("/api/datahub/templates/ministry_mapping")
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
        assert "attachment" in r.headers["content-disposition"]
        header = r.content.decode("utf-8-sig").splitlines()[0]
        assert "hsn8" in header
        assert client.get("/api/datahub/templates/nope").status_code == 422

    def test_upload_permissions(self, client, industry_headers, analyst_headers):
        content = _csv_bytes([["hsn8", "ministry_id"], [TYRE_LINE, "dpiit"]])
        assert _upload(client, {}, "ministry_mapping", "m.csv", content).status_code == 401
        assert _upload(client, industry_headers, "ministry_mapping", "m.csv", content).status_code == 403
        assert _upload(client, analyst_headers, "ministry_mapping", "m.csv", content).status_code == 403

    def test_upload_rejects_bad_files(self, ops, admin_headers):
        assert _upload(ops, admin_headers, "ministry_mapping", "m.txt", b"hsn8\n1").status_code == 400
        assert _upload(ops, admin_headers, "ministry_mapping", "m.csv", b"").status_code == 400
        assert _upload(ops, admin_headers, "nope", "m.csv", b"hsn8\n").status_code == 422
        # missing required columns -> stored but rejected, with the header row named
        r = _upload(ops, admin_headers, "ministry_mapping", "m.csv", _csv_bytes([["code", "owner"], ["1", "x"]]))
        assert r.status_code == 201, r.text
        assert r.json()["upload"]["status"] == "rejected"
        assert r.json()["errors"][0]["row"] == 1 and "missing column" in r.json()["errors"][0]["error"]

    def test_mapping_upload_validate_preview_apply(self, ops, ministry_headers, admin_headers, analyst_headers):
        conn = ops.conn()
        try:
            residual = _free_residual_line(conn)
            other = _accepted_line(conn, "dpiit", offset=3)
            mot_line = _accepted_line(conn, "mot", offset=5)
        finally:
            conn.close()
        content = _csv_bytes([
            ["hsn8", "ministry_id", "note"],
            ["# comment rows are skipped", "", ""],
            [residual["hsn8"], "mot", "official allocation"],     # row 3 valid
            ["99999999", "mot", ""],                               # row 4 unknown line
            [other["hsn8"], "dpiit", ""],                          # row 5 another ministry's row (ministry user)
            [mot_line["hsn8"], "not_a_ministry", ""],              # row 6 unknown ministry
            [mot_line["hsn8"][1:] if mot_line["hsn8"].startswith("0") else mot_line["hsn8"], "MoT", ""],  # 7 valid
        ])
        r = _upload(ops, ministry_headers, "ministry_mapping", "official_mapping.csv", content)
        assert r.status_code == 201, r.text
        body = r.json()
        upload = body["upload"]
        assert upload["status"] == "validated" and upload["rows_valid"] == 2 and upload["rows_total"] == 5
        assert body["columns"][:2] == ["hsn8", "ministry_id"]
        assert [p["row"] for p in body["preview"]] == [3, 4, 5, 6, 7]
        assert [p["valid"] for p in body["preview"]] == [True, False, False, False, True]
        assert sorted(e["row"] for e in body["errors"]) == [4, 5, 6]

        listed = ops.get("/api/datahub/uploads", headers=analyst_headers).json()
        assert any(u["id"] == upload["id"] for u in listed)
        detail = ops.get(f"/api/datahub/uploads/{upload['id']}", headers=analyst_headers).json()
        assert detail["upload"]["id"] == upload["id"] and len(detail["errors"]) == 3

        url = f"/api/datahub/uploads/{upload['id']}/apply"
        assert ops.post(url, headers=ministry_headers).status_code == 403
        r = ops.post(url, headers=admin_headers)
        assert r.status_code == 200, r.text
        assert r.json()["upload"]["status"] == "applied"
        assert ops.post(url, headers=admin_headers).status_code == 409  # applied once only

        conn = ops.conn()
        try:
            for hsn8 in (residual["hsn8"], mot_line["hsn8"]):
                p = _one(conn, "SELECT rowid AS rid, ministry_id, mapping_status, mapping_source FROM products "
                               "WHERE hsn8 = ?", (hsn8,))
                assert (p["ministry_id"], p["mapping_status"], p["mapping_source"]) == \
                    ("mot", "accepted", "official_upload")
                assert "Textiles" in _one(conn, "SELECT ministry FROM products_fts WHERE rowid = ?",
                                          (p["rid"],))["ministry"]
            change = _one(conn, "SELECT * FROM mapping_changes WHERE hsn8 = ? ORDER BY id DESC LIMIT 1",
                          (residual["hsn8"],))
            assert change["source"] == "official_upload" and change["new_ministry_id"] == "mot"
            untouched = _one(conn, "SELECT ministry_id, mapping_source FROM products WHERE hsn8 = ?", (other["hsn8"],))
            assert untouched["mapping_source"] != "official_upload"
            assert _one(conn, "SELECT id FROM audit_log WHERE action = 'upload.apply' AND entity_id = ?",
                        (str(upload["id"]),))
        finally:
            conn.close()
        product = ops.get(f"/api/hsn/product/{residual['hsn8']}").json()
        assert product["mapping"]["status"] == "verified" or product["mapping_source"] == "official_upload"

    def test_value_chain_edges_upload(self, ops, admin_headers):
        content = _csv_bytes([["src", "dst", "relation", "chain_id"],
                              ["400121", "401110", "input_to", "tyre"],
                              ["4001", "4011", "made_from", ""]])
        r = _upload(ops, admin_headers, "value_chain_edges", "edges.csv", content)
        assert r.status_code == 201, r.text
        assert r.json()["upload"]["rows_valid"] == 1 and r.json()["errors"][0]["row"] == 3
        r = ops.post(f"/api/datahub/uploads/{r.json()['upload']['id']}/apply", headers=admin_headers)
        assert r.status_code == 200, r.text
        conn = ops.conn()
        try:
            edge = _one(conn, "SELECT * FROM vc_edges WHERE src = '400121' AND dst = '401110' "
                              "AND relation = 'input_to'")
            assert edge and edge["source"] == "official_upload" and edge["chain_id"] == "tyre"
        finally:
            conn.close()

    def test_production_upload_xlsx(self, ops, admin_headers):
        from openpyxl import Workbook
        wb = Workbook()
        ws = wb.active
        ws.append(["scope", "key", "year", "value", "unit", "source"])
        ws.append(["hs6", "401110", 2024, 1234567, "units", "Test association annual report 2024"])
        ws.append(["hs6", "401110", "twenty", 5, "units", "bad year"])
        buffer = io.BytesIO()
        wb.save(buffer)
        r = _upload(ops, admin_headers, "production", "production.xlsx", buffer.getvalue())
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["upload"]["rows_valid"] == 1 and [e["row"] for e in body["errors"]] == [3]
        assert ops.post(f"/api/datahub/uploads/{body['upload']['id']}/apply", headers=admin_headers).status_code == 200
        conn = ops.conn()
        try:
            prod = _one(conn, "SELECT * FROM production WHERE scope = 'hs6' AND key = '401110' AND year = 2024 "
                              "ORDER BY id DESC LIMIT 1")
            assert prod["value"] == 1234567 and prod["unit"] == "units"
            assert prod["source"] == "Test association annual report 2024"
        finally:
            conn.close()

    def test_quality(self, client, analyst_headers, db_conn):
        assert client.get("/api/datahub/quality").status_code == 401
        r = client.get("/api/datahub/quality", headers=analyst_headers)
        assert r.status_code == 200
        body = r.json()
        coverage = body["coverage"]
        for key in ("products", "with_trade", "with_tariff", "with_production", "mapping_rule",
                    "mapping_official", "mapping_manual", "residual"):
            assert isinstance(coverage[key], int)
        assert coverage["products"] == db_conn.execute(
            "SELECT COUNT(*) AS n FROM products WHERE is_current = 1").fetchone()["n"]
        assert coverage["with_trade"] <= coverage["products"]
        assert body["by_ministry"] and {"ministry_id", "short_name", "codes", "with_trade_pct", "verified_pct",
                                        "avg_quality"} <= set(body["by_ministry"][0])
        assert sum(b["count"] for b in body["quality_histogram"]) == coverage["products"]
        assert isinstance(body["cross_checks"], list)


# =========================================================================== 6.12 reports

class TestReports:
    @pytest.mark.parametrize("kind, ident", [("product", TYRE_LINE), ("ministry", "mot"), ("valuechain", "tyre")])
    def test_public_reports_all_formats(self, client, kind, ident):
        expected = {"pdf": "application/pdf",
                    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "csv": "text/csv"}
        for fmt, media in expected.items():
            r = client.get(f"/api/reports/{kind}/{ident}?format={fmt}")
            assert r.status_code == 200, (kind, fmt, r.text[:200])
            assert r.headers["content-type"].startswith(media)
            disposition = r.headers["content-disposition"]
            assert disposition.startswith("attachment") and f".{fmt}" in disposition
            assert len(r.content) > 500
            if fmt == "pdf":
                assert r.content[:5] == b"%PDF-"
            elif fmt == "xlsx":
                from openpyxl import load_workbook
                wb = load_workbook(io.BytesIO(r.content), read_only=True)
                assert len(wb.sheetnames) >= 2 and wb.sheetnames[0] == "Summary"
                wb.close()
            else:
                text = r.content.decode("utf-8-sig")
                dotted = f"{ident[:4]}.{ident[4:6]}.{ident[6:]}" if ident.isdigit() else ident
                assert ident in text or dotted in text or ident.upper() in text.upper()

    def test_valuechain_report_names_trade_edition(self, client):
        r = client.get("/api/reports/valuechain/tyre?format=csv")
        assert r.status_code == 200
        text = r.content.decode("utf-8-sig")
        assert 'Trade edition,"India: DGFT/DGCIS TRADESTAT FY2024-25; world: CEPII BACI HS 2022, 2024 (via OEC)"' in text

    def test_product_csv_single_table(self, client):
        r = client.get(f"/api/reports/product/{TYRE_LINE}?format=csv&table=series")
        assert r.status_code == 200
        reader = list(csv.reader(io.StringIO(r.content.decode("utf-8-sig"))))
        assert len(reader) >= 2 and any("year" in h.lower() for h in reader[0])
        bad = client.get(f"/api/reports/product/{TYRE_LINE}?format=csv&table=nope")
        assert bad.status_code == 400 and "series" in bad.json()["detail"]

    def test_sector_report_needs_sign_in(self, client, industry_headers):
        sector = client.get("/api/meta/sectors").json()[0]["id"]
        assert client.get(f"/api/reports/sector/{sector}?format=pdf").status_code == 401
        r = client.get(f"/api/reports/sector/{sector}?format=xlsx", headers=industry_headers)
        assert r.status_code == 200 and len(r.content) > 500

    def test_errors(self, client):
        assert client.get("/api/reports/product/00000000?format=pdf").status_code == 404
        assert client.get("/api/reports/ministry/nope?format=pdf").status_code == 404
        assert client.get(f"/api/reports/product/{TYRE_LINE}?format=docx").status_code == 422
        assert client.get(f"/api/reports/unknown/{TYRE_LINE}").status_code in (404, 422)

    def test_search_export(self, client, industry_headers):
        assert client.get("/api/reports/search?q=rubber&format=csv").status_code == 401
        total = client.get("/api/hsn/search?q=rubber&page_size=1").json()["total"]
        r = client.get("/api/reports/search?q=rubber&format=csv", headers=industry_headers)
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
        assert "attachment" in r.headers["content-disposition"]
        rows = list(csv.reader(io.StringIO(r.content.decode("utf-8-sig"))))
        assert len(rows) - 1 == total  # header + every matching line (not just one page)
        r = client.get("/api/reports/search?q=rubber&format=xlsx", headers=industry_headers)
        assert r.status_code == 200 and r.content[:2] == b"PK"


# =========================================================================== 6.13 admin / roadmap / risks / watchlist

class TestAdmin:
    def test_users_admin_only_and_no_hashes(self, client, admin_headers, analyst_headers, ministry_headers):
        assert client.get("/api/admin/users").status_code == 401
        assert client.get("/api/admin/users", headers=analyst_headers).status_code == 403
        assert client.get("/api/admin/users", headers=ministry_headers).status_code == 403
        r = client.get("/api/admin/users", headers=admin_headers)
        assert r.status_code == 200
        users = r.json()
        assert {u["role"] for u in users} >= {"admin", "ministry", "analyst", "industry"}
        for u in users:
            assert "password_hash" not in u and "password" not in u
        assert "pbkdf2" not in r.text

    def test_create_patch_user_and_login(self, ops, admin_headers):
        body = {"email": "officer.test@atlas.gov.in", "name": "Test Officer", "password": "S3cure-pass!",
                "role": "ministry", "ministry_id": "mot", "organisation": "Ministry of Textiles"}
        r = ops.post("/api/admin/users", json=body, headers=admin_headers)
        assert r.status_code == 201, r.text
        user = r.json()
        assert user["role"] == "ministry" and user["ministry_id"] == "mot" and "password_hash" not in user
        assert ops.post("/api/admin/users", json=body, headers=admin_headers).status_code == 409
        assert ops.post("/api/admin/users", json={**body, "email": "x2@atlas.gov.in", "ministry_id": None},
                        headers=admin_headers).status_code == 400
        assert ops.post("/api/admin/users", json={**body, "email": "x3@atlas.gov.in", "role": "root"},
                        headers=admin_headers).status_code == 422

        login = ops.post("/api/auth/login", json={"email": body["email"], "password": body["password"]})
        assert login.status_code == 200 and login.json()["user"]["ministry_id"] == "mot"

        r = ops.patch(f"/api/admin/users/{user['id']}", json={"role": "analyst", "ministry_id": None},
                      headers=admin_headers)
        assert r.status_code == 200, r.text
        assert r.json()["role"] == "analyst" and "password_hash" not in r.json()
        r = ops.patch(f"/api/admin/users/{user['id']}", json={"active": False}, headers=admin_headers)
        assert r.status_code == 200
        assert ops.post("/api/auth/login", json={"email": body["email"],
                                                 "password": body["password"]}).status_code == 401
        assert ops.patch("/api/admin/users/999999", json={"name": "x"}, headers=admin_headers).status_code == 404

    def test_admin_cannot_lock_themselves_out(self, ops, admin_headers):
        me = ops.get("/api/auth/me", headers=admin_headers).json()
        assert ops.patch(f"/api/admin/users/{me['id']}", json={"active": False},
                         headers=admin_headers).status_code == 400
        assert ops.patch(f"/api/admin/users/{me['id']}", json={"role": "analyst"},
                         headers=admin_headers).status_code == 400

    def test_audit_log(self, ops, admin_headers, analyst_headers):
        ops.post("/api/watchlist/" + TYRE_LINE, headers=admin_headers)  # make sure something is logged
        assert ops.get("/api/admin/audit", headers=analyst_headers).status_code == 403
        r = ops.get("/api/admin/audit?page_size=5", headers=admin_headers)
        assert r.status_code == 200
        body = r.json()
        assert {"items", "total", "page", "page_size"} <= set(body) and body["total"] >= 1
        ts = [i["ts"] for i in body["items"]]
        assert ts == sorted(ts, reverse=True)
        filtered = ops.get("/api/admin/audit?action=watchlist&page_size=50", headers=admin_headers).json()
        assert filtered["items"] and all(i["action"].startswith("watchlist") for i in filtered["items"])


class TestRoadmapRisks:
    def test_roadmap_public(self, client):
        r = client.get("/api/roadmap")
        assert r.status_code == 200
        body = r.json()
        assert [p["phase"] for p in body["phases"]][:3] == ["Phase 0", "Phase I", "Phase II"]
        progress = body["progress"]
        n_items = sum(len(p["items"]) for p in body["phases"])
        assert progress["done"] + progress["in_progress"] + progress["planned"] == n_items
        assert progress["pct"] == pytest.approx(100 * progress["done"] / n_items, abs=0.51)

    def test_roadmap_patch(self, ops, admin_headers, analyst_headers):
        phases = ops.get("/api/roadmap").json()["phases"]
        item = next(i for p in phases for i in p["items"] if i["status"] != "done")
        url = f"/api/roadmap/{item['id']}"
        assert ops.patch(url, json={"status": "done"}).status_code == 401
        assert ops.patch(url, json={"status": "done"}, headers=analyst_headers).status_code == 403
        assert ops.patch(url, json={"status": "finished"}, headers=admin_headers).status_code == 422
        before = ops.get("/api/roadmap").json()["progress"]["done"]
        r = ops.patch(url, json={"status": "done", "owner": "DPIIT PMU"}, headers=admin_headers)
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "done" and r.json()["owner"] == "DPIIT PMU"
        assert ops.get("/api/roadmap").json()["progress"]["done"] == before + 1
        assert ops.patch("/api/roadmap/nope", json={"status": "done"}, headers=admin_headers).status_code == 404

    def test_risks(self, ops, admin_headers, industry_headers):
        risks = ops.get("/api/risks").json()
        assert risks
        for risk in risks:
            assert risk["score"] == risk["likelihood"] * risk["impact"]
            assert risk["level"] in ("high", "medium", "low")
        rid = risks[0]["id"]
        assert ops.patch(f"/api/risks/{rid}", json={"status": "closed"},
                         headers=industry_headers).status_code == 403
        r = ops.patch(f"/api/risks/{rid}", json={"likelihood": 5, "impact": 5}, headers=admin_headers)
        assert r.status_code == 200, r.text
        assert r.json()["score"] == 25 and r.json()["level"] == "high"
        assert ops.patch(f"/api/risks/{rid}", json={"likelihood": 9}, headers=admin_headers).status_code == 422


class TestWatchlist:
    def test_watchlist_flow(self, ops, industry_headers):
        assert ops.get("/api/watchlist").status_code == 401
        assert ops.post(f"/api/watchlist/{TYRE_LINE}").status_code == 401
        r = ops.post(f"/api/watchlist/{TYRE_LINE}", headers=industry_headers)
        assert r.status_code == 201 and r.json()["watching"] is True
        assert ops.post(f"/api/watchlist/{MOT_LINE}", headers=industry_headers).status_code == 201
        assert ops.post(f"/api/watchlist/{MOT_LINE}", headers=industry_headers).status_code in (200, 201)  # idempotent
        items = ops.get("/api/watchlist", headers=industry_headers).json()
        codes = [i["hsn8"] for i in items]
        assert codes.count(MOT_LINE) == 1 and TYRE_LINE in codes
        assert {"hsn8", "description", "ministry_id", "exports", "imports"} <= set(items[0])
        r = ops.delete(f"/api/watchlist/{TYRE_LINE}", headers=industry_headers)
        assert r.status_code == 200 and r.json()["watching"] is False
        assert TYRE_LINE not in [i["hsn8"] for i in ops.get("/api/watchlist", headers=industry_headers).json()]
        assert ops.post("/api/watchlist/00000000", headers=industry_headers).status_code == 404


# =========================================================================== 6.14 assistant

def _ask(client, text: str, history: list[dict] | None = None):
    messages = [*(history or []), {"role": "user", "content": text}]
    r = client.post("/api/assistant/chat", json={"messages": messages})
    assert r.status_code == 200, r.text
    body = r.json()
    assert {"reply", "citations", "mode", "tools_used"} <= set(body)
    for c in body["citations"]:
        assert {"type", "id", "label", "route"} <= set(c) and c["route"].startswith("/")
    return body


class TestAssistantOffline:
    def test_status_offline(self, client):
        r = client.get("/api/assistant/status")
        assert r.status_code == 200
        assert r.json()["mode"] == "offline" and r.json()["model"] is None

    def test_hs_code_gives_product_card(self, client, db_conn):
        body = _ask(client, "Tell me about 4011.10.10")
        assert body["mode"] == "offline" and "get_product" in body["tools_used"]
        assert any(c["type"] == "product" and c["id"] == TYRE_LINE and c["route"] == f"/product/{TYRE_LINE}"
                   for c in body["citations"])
        owner = _one(db_conn, "SELECT m.name FROM products p JOIN ministries m ON m.id = p.ministry_id "
                              "WHERE p.hsn8 = ?", (TYRE_LINE,))["name"]
        assert "4011.10.10" in body["reply"] and owner in body["reply"]
        assert "BACI" in body["reply"] or "HS6" in body["reply"]  # provenance is stated

    def test_heading_code_gives_node(self, client):
        body = _ask(client, "what is HS 8507")
        assert "lookup_code" in body["tools_used"] and "8507" in body["reply"]

    def test_which_ministry(self, client):
        body = _ask(client, "Which ministry handles natural rubber?")
        assert "search_products" in body["tools_used"]
        assert any(c["type"] == "product" and c["id"].startswith("4001") for c in body["citations"])
        assert "|" in body["reply"]  # a table of matching lines

    def test_everyday_names_use_hs_wording(self, client):
        # HS says "electric accumulators; lithium-ion": no line has every word of the question
        body = _ask(client, "Which ministry handles lithium-ion batteries?")
        products = [c["id"] for c in body["citations"] if c["type"] == "product"]
        assert products and products[0] == "85076000"
        body = _ask(client, "who handles drones")
        assert "unmanned aircraft" in body["reply"]
        assert all(c["id"].startswith("88") for c in body["citations"] if c["type"] == "product")

    def test_top_exports_of_ministry(self, client):
        body = _ask(client, "What are the top exports of the Ministry of Textiles?")
        assert "ministry_summary" in body["tools_used"]
        assert any(c["type"] == "ministry" and c["id"] == "mot" for c in body["citations"])
        assert "Top exports" in body["reply"]

    def test_top_imports_of_ministry(self, client):
        body = _ask(client, "top imports of MeitY")
        assert any(c["type"] == "ministry" and c["id"] == "meity" for c in body["citations"])
        assert "imports" in body["reply"].lower()

    def test_opportunities_in_sector(self, client):
        body = _ask(client, "Show export opportunities in the electronics sector")
        assert "top_opportunities" in body["tools_used"]
        assert any(c["type"] == "sector" for c in body["citations"])
        assert "model estimate" in body["reply"].lower() or "score" in body["reply"].lower()

    def test_dependence_on_china(self, client):
        body = _ask(client, "How dependent are we on China?")
        assert "import_dependencies" in body["tools_used"] and "China" in body["reply"]
        assert any(c["type"] == "product" for c in body["citations"])

    def test_value_chain(self, client):
        body = _ask(client, "Explain the tyre value chain")
        assert "chain_summary" in body["tools_used"]
        assert any(c["type"] == "chain" and c["id"] == "tyre" for c in body["citations"])

    def test_help_and_unknown(self, client):
        body = _ask(client, "help")
        assert body["citations"] == [] and "HS code" in body["reply"]
        body = _ask(client, "qwzx plorbt")
        assert body["reply"]  # never empty: falls back to the help text

    def test_uses_last_user_turn(self, client):
        history = [{"role": "user", "content": "Tell me about 4011.10.10"},
                   {"role": "assistant", "content": "x" * 9000}]  # long earlier answers are shortened, not rejected
        body = _ask(client, "top exports of the Ministry of Steel", history)
        assert any(c["type"] == "ministry" and c["id"] == "mos" for c in body["citations"])

    def test_validation(self, client):
        assert client.post("/api/assistant/chat", json={"messages": []}).status_code == 422
        assert client.post("/api/assistant/chat", json={}).status_code == 422
        assert client.post("/api/assistant/chat", json={"messages": [{"role": "assistant", "content": "hi"}]}
                           ).status_code == 422
        assert client.post("/api/assistant/chat", json={"messages": [{"role": "system", "content": "hi"}]}
                           ).status_code == 422
        assert client.post("/api/assistant/chat", json={"messages": [{"role": "user", "content": "   "}]}
                           ).status_code == 422
        assert client.post("/api/assistant/chat", json={"messages": [{"role": "user", "content": "x" * 5000}]}
                           ).status_code == 422


class _FakeMessages:
    """Scripted ``client.beta.messages`` for the Claude tool-use loop."""

    def __init__(self, responses: list):
        self.responses = list(responses)
        self.requests: list[dict] = []

    def create(self, **kwargs):
        self.requests.append(kwargs)
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def _fake_factory(messages: _FakeMessages):
    return lambda _key: SimpleNamespace(beta=SimpleNamespace(messages=messages))


class TestAssistantClaude:
    def test_status_claude_mode(self, client, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
        body = client.get("/api/assistant/status").json()
        assert body["mode"] == "claude" and body["model"] == "claude-opus-5-5"

    def test_tool_use_loop(self, db_conn, db_path):
        from app.db import connect
        from app.services import assistant_engine as engine

        tool_turn = SimpleNamespace(stop_reason="tool_use", content=[
            SimpleNamespace(type="text", text="Looking that up."),
            SimpleNamespace(type="tool_use", id="toolu_1", name="get_product", input={"hsn8": "4011.10.10"}),
            SimpleNamespace(type="tool_use", id="toolu_2", name="lookup_code", input={"code": "zz"}),
        ])
        final_turn = SimpleNamespace(stop_reason="end_turn", content=[
            SimpleNamespace(type="text", text="4011.10.10 is owned by DPIIT (indicative mapping).")])
        fake = _FakeMessages([tool_turn, final_turn])
        conn = connect(db_path)
        try:
            result = engine.chat_claude(conn, [{"role": "user", "content": "Who owns 4011.10.10?"}], "sk-test",
                                        client_factory=_fake_factory(fake))
        finally:
            conn.close()
        assert result["mode"] == "claude" and result["model"] == engine.MODEL
        assert result["reply"].startswith("4011.10.10 is owned by DPIIT")
        assert "get_product" in result["tools_used"]
        assert any(c["type"] == "product" and c["id"] == TYRE_LINE for c in result["citations"])
        first, second = fake.requests
        assert first["model"] == "claude-opus-5-5" and first["tools"] and first["system"]
        assert first["output_config"] == {"effort": engine.EFFORT}
        assert "tool_choice" not in first  # forced tool choice is not used
        # the second request carries the assistant turn and one user turn with both tool results
        results = second["messages"][-1]["content"]
        assert [r["tool_use_id"] for r in results] == ["toolu_1", "toolu_2"]
        assert TYRE_LINE in results[0]["content"]
        assert results[1].get("is_error") is True

    def test_api_failure_falls_back_offline(self, db_path):
        import anthropic

        from app.db import connect
        from app.services import assistant_engine as engine
        try:
            import httpx2 as httpx_mod
        except ImportError:  # pragma: no cover - older SDKs use httpx
            import httpx as httpx_mod
        error = anthropic.APIConnectionError(request=httpx_mod.Request("POST", "https://api.anthropic.com/v1/messages"))
        conn = connect(db_path)
        try:
            result = engine.chat_claude(conn, [{"role": "user", "content": "Tell me about 4011.10.10"}], "sk-test",
                                        client_factory=_fake_factory(_FakeMessages([error])))
        finally:
            conn.close()
        assert result["mode"] == "offline" and "could not be reached" in result["reply"]
        assert any(c["id"] == TYRE_LINE for c in result["citations"])

    def test_router_claude_mode_and_rate_limit(self, client, monkeypatch):
        from app.routers import assistant as router_module
        from app.services import assistant_engine as engine
        seen: list[list[dict]] = []

        def fake_chat_claude(conn, messages, api_key, client_factory=None):
            seen.append(messages)
            return {"reply": "ok", "citations": [], "mode": "claude", "tools_used": ["search_products"],
                    "model": engine.MODEL}

        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
        monkeypatch.setenv("ATLAS_ASSISTANT_RATE_PER_MINUTE", "2")
        monkeypatch.setattr(engine, "chat_claude", fake_chat_claude)
        monkeypatch.setattr(router_module, "_limiter", router_module._RateLimiter())
        payload = {"messages": [{"role": "assistant", "content": "Welcome"},
                                {"role": "user", "content": "Which ministry owns tyres?"}]}
        for _ in range(2):
            r = client.post("/api/assistant/chat", json=payload)
            assert r.status_code == 200 and r.json()["mode"] == "claude" and r.json()["model"] == engine.MODEL
        assert seen[0] == [{"role": "user", "content": "Which ministry owns tyres?"}]  # leading assistant turn dropped
        r = client.post("/api/assistant/chat", json=payload)
        assert r.status_code == 429 and int(r.headers["retry-after"]) >= 1


# =========================================================================== review fixes: uploads reach the
# analytics caches, orphaned jobs, source status, export budget, assistant routing

class TestUploadsReachAnalytics:
    def test_edge_upload_shows_in_network_and_simulator_at_once(self, ops, admin_headers, analyst_headers):
        """F2: an applied value-chain-edge upload invalidates the cached graph in the same process."""
        before = ops.get("/api/network?chain_id=tyre").json()
        assert not any(e["source"] == "4011" and e["target"] == "8703" for e in before["edges"])
        sim = ops.post("/api/policy/simulate-tariff", json={"codes": ["4011"], "new_tariff_pct": 25},
                       headers=analyst_headers).json()
        assert not any(d["code"] == "8703" for d in sim["downstream"])
        r = _upload(ops, admin_headers, "value_chain_edges", "edges.csv",
                    _csv_bytes([["src", "dst", "relation", "chain_id"], ["4011", "8703", "component_of", "tyre"]]))
        assert r.status_code == 201, r.text
        assert ops.post(f"/api/datahub/uploads/{r.json()['upload']['id']}/apply", headers=admin_headers).status_code == 200
        after = ops.get("/api/network?chain_id=tyre").json()
        assert any(e["source"] == "4011" and e["target"] == "8703" and e["source_kind"] == "official_upload"
                   for e in after["edges"])
        assert after["stats"]["n_edges"] > before["stats"]["n_edges"]
        sim = ops.post("/api/policy/simulate-tariff", json={"codes": ["4011"], "new_tariff_pct": 25},
                       headers=analyst_headers).json()
        assert any(d["code"] == "8703" for d in sim["downstream"])

    def test_production_upload_shows_on_every_page(self, ops, admin_headers, analyst_headers):
        """F1 + F2: an uploaded production figure is used by the chain, demand-supply and network pages."""
        r = _upload(ops, admin_headers, "production", "production.csv",
                    _csv_bytes([["scope", "key", "year", "value", "unit", "source", "label", "status"],
                                ["chain", "tyre", "2024", "5000000000", "usd", "MoCI annual report 2024-25",
                                 "india_production", "verified"]]))
        assert r.status_code == 201, r.text
        assert ops.post(f"/api/datahub/uploads/{r.json()['upload']['id']}/apply", headers=admin_headers).status_code == 200
        kpi = {k["key"]: k for k in ops.get("/api/valuechains/tyre").json()["kpis"]}["india_production"]
        assert (kpi["value"], kpi["unit"], kpi["provenance"]["status"]) == (5e9, "usd", "verified")
        assert "playbook_value" not in kpi
        ds = ops.get("/api/analytics/demand-supply?chain_id=tyre", headers=analyst_headers).json()["items"][0]
        assert ds["production"] == 5e9 and ds["apparent_consumption"] is not None
        node = next(n for n in ops.get("/api/network?chain_id=tyre").json()["nodes"] if n["code"] == "4011")
        assert node["production"]["value"] == 5e9 and "playbook_value" not in node["production"]
        dash = ops.get("/api/ministries/dpiit").json()
        tyre = next(p for p in dash["production"] if p["chain_id"] == "tyre" and p["label"] == "india_production")
        assert (tyre["value"], tyre["status"]) == (5e9, "verified")
        assert "playbook_value" not in tyre
        assert dash["provenance"]["production"]["status"] == "verified"


class TestOrphanedJobs:
    def test_startup_closes_running_jobs(self, mutable_db_path):
        """F4: a job left 'running' by a crash is closed as failed when the API starts."""
        from fastapi.testclient import TestClient

        from app.main import create_app
        from app.services import connectors
        conn = _open(mutable_db_path)
        try:
            conn.execute("INSERT INTO refresh_jobs (source_id, started_at, status, message) VALUES "
                         "('oec_baci', '2020-01-01T00:00:00+00:00', 'running', 'fetching')")
            conn.commit()
        finally:
            conn.close()
        with TestClient(create_app(db_path=mutable_db_path)) as client:
            token = client.post("/api/auth/demo-login", json={"role": "admin"}).json()["access_token"]
            jobs = client.get("/api/datahub/jobs?source_id=oec_baci", headers={"Authorization": f"Bearer {token}"}).json()
            assert jobs and jobs[0]["status"] == "failed" and jobs[0]["message"] == connectors.RESTART_MESSAGE
            assert jobs[0]["finished_at"]
            source = next(s for s in client.get("/api/datahub/sources").json() if s["id"] == "oec_baci")
            assert source["status"] == "error"

    def test_stale_running_job_is_closed_when_a_refresh_starts(self, ops, admin_headers, monkeypatch):
        from app.services import connectors
        monkeypatch.delenv("ATLAS_CBIC_API_KEY", raising=False)
        conn = ops.conn()
        try:
            cur = conn.execute("INSERT INTO refresh_jobs (source_id, started_at, status, message) VALUES "
                               "('cbic', '2020-01-01T00:00:00+00:00', 'running', 'queued')")
            stale_id = cur.lastrowid
            conn.commit()
        finally:
            conn.close()
        r = ops.post("/api/datahub/sources/cbic/refresh", headers=admin_headers)
        assert r.status_code == 200, r.text
        jobs = {j["id"]: j for j in ops.get("/api/datahub/jobs?source_id=cbic", headers=admin_headers).json()}
        assert jobs[stale_id]["status"] == "failed" and jobs[stale_id]["message"] == connectors.STALE_MESSAGE
        assert not any(j["status"] == "running" for j in jobs.values())


class TestSourceStatusHonesty:
    def test_never_run_connector_is_not_connected(self, client, analyst_headers, db_conn):
        """UI-06 / DI-5: UN Comtrade has never run - no 'Connected' badge, and the quality tab says what to do."""
        sources = {s["id"]: s for s in client.get("/api/datahub/sources").json()}
        comtrade = sources["un_comtrade"]
        if db_conn.execute("SELECT COUNT(*) AS n FROM comtrade_checks").fetchone()["n"] == 0:
            assert comtrade["status"] == "not_refreshed" and comtrade["last_refreshed"] is None
            quality = client.get("/api/datahub/quality", headers=analyst_headers).json()
            action = quality["cross_check_summary"]["action"]
            assert action and action["source_id"] == "un_comtrade" and action["refreshable"] is True
            assert "connector" in action["message"].lower()
        else:
            assert comtrade["status"] == "connected" and comtrade["last_refreshed"]
        assert all(s["last_refreshed"] for s in sources.values() if s["status"] == "connected")

    def test_effective_status(self):
        from app.services import connectors
        assert connectors.effective_status({"status": "connected", "last_refreshed": None}) == "not_refreshed"
        assert connectors.effective_status({"status": "connected", "last_refreshed": "2026-10-19"}) == "connected"
        assert connectors.effective_status({"status": "not_configured", "last_refreshed": None}) == "not_configured"
        assert connectors.effective_status(None) is None


class TestExportBudget:
    def test_full_catalogue_export_within_budget(self, client, industry_headers, timed_get):
        """F3: the unfiltered export is rendered once per data fingerprint and served from the cache."""
        from tests.conftest import PERF_BUDGET_S
        first, t_first = timed_get("/api/reports/search?format=xlsx", headers=industry_headers)
        assert first.status_code == 200 and first.content[:2] == b"PK"
        second, t_second = timed_get("/api/reports/search?format=xlsx", headers=industry_headers)
        assert second.content == first.content
        assert t_second < PERF_BUDGET_S / 2, t_second
        assert t_first < PERF_BUDGET_S * 2, t_first   # cold render on the test machine; the server pre-warms it
        csv_r, t_csv = timed_get("/api/reports/search?format=csv", headers=industry_headers)
        assert csv_r.status_code == 200
        total = client.get("/api/hsn/search?page_size=1").json()["total"]
        assert csv_r.content.decode("utf-8-sig").count("\r\n") == total + 1
        _again, t_csv2 = timed_get("/api/reports/search?format=csv", headers=industry_headers)
        assert t_csv2 < PERF_BUDGET_S / 2, t_csv2


class TestAssistantRouting:
    def test_metric_question_answers_with_the_product_card(self, client):
        """UI-05: the drawer's own suggestion 'What is India's RCA in cotton T-shirts?' prints the RCA."""
        body = _ask(client, "What is India's RCA in cotton T-shirts?")
        assert "get_product" in body["tools_used"]
        assert "6109.10.00" in body["reply"] and "RCA" in body["reply"]
        assert any(c["type"] == "product" and c["id"] == "61091000" for c in body["citations"])
        body = _ask(client, "What are India's exports of lithium-ion batteries?")
        assert "get_product" in body["tools_used"] and "8507.60.00" in body["reply"]

    def test_compound_ministry_and_dependence_question_keeps_the_product(self, client):
        body = _ask(client, "Which ministry handles tyre cord fabric and how dependent is India on imports of it?")
        assert "import_dependencies" not in body["tools_used"]
        assert "Ministry of Textiles" in body["reply"] and "5902" in body["reply"]
        assert "Import dependence of the closest lines" in body["reply"]
        assert any(c["type"] == "product" and c["id"].startswith("5902") for c in body["citations"])
        # the simple forms still work
        assert "Ministry of Textiles" in _ask(client, "Which ministry handles tyre cord fabric?")["reply"]
        assert "ministry_summary" in _ask(client, "What are the top exports of the Ministry of Textiles?")["tools_used"]
        assert "India's top exports" in _ask(client, "What are India's top exports?")["reply"]
