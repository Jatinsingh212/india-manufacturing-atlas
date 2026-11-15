"""Daily cloud sync (app.services.cloud_sync): job orchestration, overlay of snapshots, cron authorisation.

Offline: storage (``blob_get`` / ``blob_put``) and the scrapers are replaced by in-memory fakes.
"""
from __future__ import annotations

import json

import pytest

from app.services import cloud_sync as cs


@pytest.fixture()
def configured(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "test-secret")
    monkeypatch.setenv("ATLAS_SYNC_BASE_URL", "https://example.invalid")
    store: dict[str, bytes] = {}
    monkeypatch.setattr(cs, "blob_put", lambda name, data: store.__setitem__(name, data))
    monkeypatch.setattr(cs, "blob_get", lambda name: store.get(name))
    monkeypatch.setattr(cs, "_last_check", 0.0)
    return store


CLUSTER_SNAP = {"fetched_at": "2026-11-05T22:31:00+00:00", "clusters": [
    {"name": "Jalandhar Sports Goods", "cluster_type": "industrial", "state": "Punjab", "district": "Jalandhar",
     "district_source": "observatory", "products": "Sports Goods", "profile_url": None},
    {"name": "Jalandhar Rubber", "cluster_type": "industrial", "state": "Punjab", "district": "Jalandhar",
     "district_source": "observatory", "products": "Rubber Products", "profile_url": None},
]}


def test_disabled_without_configuration(monkeypatch, db_conn):
    monkeypatch.delenv("CRON_SECRET", raising=False)
    monkeypatch.delenv("ATLAS_SYNC_BASE_URL", raising=False)
    monkeypatch.delenv("VERCEL_PROJECT_PRODUCTION_URL", raising=False)
    assert not cs.enabled()
    assert cs.apply_latest(db_conn, force=True)["skipped"] == "cloud sync not configured"


def test_run_sync_keeps_previous_entry_when_a_source_fails(configured, monkeypatch, mutable_conn):
    configured["manifest.json"] = json.dumps({"sources": {"iilb_parks": {
        "status": "success", "fetched_at": "2026-11-04T22:30:00+00:00", "records": 4228}}}).encode()
    monkeypatch.setattr(cs, "sync_clusters", lambda: {"records": 2, "fetched_at": "2026-11-05T22:31:00+00:00",
                                                       "message": "2 clusters"})
    def boom():
        raise RuntimeError("park report did not load")
    monkeypatch.setattr(cs, "sync_iilb", boom)
    manifest = cs.run_sync(mutable_conn, ("cluster_observatory", "iilb_parks"))
    src = manifest["sources"]
    assert src["cluster_observatory"]["status"] == "success" and src["cluster_observatory"]["records"] == 2
    assert src["iilb_parks"]["status"] == "failed" and "did not load" in src["iilb_parks"]["error"]
    assert src["iilb_parks"]["fetched_at"] == "2026-11-04T22:30:00+00:00"       # last good snapshot still listed
    assert json.loads(configured["manifest.json"])["updated_at"]


def test_overlay_applies_newer_snapshots_once(configured, mutable_conn):
    cs.put_snapshot("cluster_observatory", CLUSTER_SNAP)
    manifest = {"sources": {"cluster_observatory": {"status": "success", "records": 2, "message": "2 clusters",
                                                    "fetched_at": CLUSTER_SNAP["fetched_at"]}}}
    first = cs.apply_latest(mutable_conn, force=True, manifest=manifest)
    assert first["applied"] == {"cluster_observatory": 2}
    rows = mutable_conn.execute("SELECT name, district, hs_prefixes_json FROM co_clusters ORDER BY name").fetchall()
    assert [r["name"] for r in rows] == ["Jalandhar Rubber", "Jalandhar Sports Goods"]
    assert json.loads(rows[1]["hs_prefixes_json"]) == ["9506"]
    src = mutable_conn.execute("SELECT status, last_refreshed, records FROM data_sources "
                               "WHERE id = 'cluster_observatory'").fetchone()
    assert src["last_refreshed"] == CLUSTER_SNAP["fetched_at"] and src["records"] == 2
    job = mutable_conn.execute("SELECT status, message FROM refresh_jobs ORDER BY id DESC LIMIT 1").fetchone()
    assert job["status"] == "success" and job["message"].startswith("cloud sync")
    again = cs.apply_latest(mutable_conn, force=True, manifest=manifest)
    assert again["applied"] == {}                                                 # same snapshot: nothing to do


def test_overlay_is_throttled(configured, mutable_conn):
    manifest = {"sources": {}}
    cs.apply_latest(mutable_conn, force=True, manifest=manifest)
    assert cs.apply_latest(mutable_conn, manifest=manifest)["skipped"] == "checked recently"


def test_cron_endpoint_requires_the_secret(configured, monkeypatch, client):
    monkeypatch.setattr(cs, "run_sync", lambda conn, sources: {"sources": {}, "updated_at": "now"})
    assert client.get("/api/cron/sync").status_code == 401
    assert client.get("/api/cron/sync", headers={"Authorization": "Bearer wrong"}).status_code == 401
    ok = client.get("/api/cron/sync", headers={"Authorization": "Bearer test-secret"})
    assert ok.status_code == 200 and ok.json()["manifest"]["updated_at"] == "now"
    assert client.get("/api/cron/sync?sources=nope", headers={"Authorization": "Bearer test-secret"}).status_code == 422


def test_sync_status_is_public(client):
    body = client.get("/api/sync/status").json()
    assert set(body["applied"]) == set(cs.SOURCES)


def test_previous_clusters_never_drop_confirmed_districts(configured, tmp_path, monkeypatch):
    seed = tmp_path / "cluster_observatory.json"
    seed.write_text(json.dumps({"clusters": [CLUSTER_SNAP["clusters"][0]], "district_state": {"cursor": 5}}))
    monkeypatch.setattr(cs.dd, "CO_CACHE", seed)
    newer = {"clusters": [{**CLUSTER_SNAP["clusters"][0], "district": "Jalandhar", "district_source": "name"},
                          CLUSTER_SNAP["clusters"][1]], "district_state": {"cursor": 165}}
    cs.put_snapshot("cluster_observatory", newer)
    prev = cs.previous_clusters()
    known = {c["name"]: c["district_source"] for c in prev["clusters"] if c.get("district_source") == "observatory"}
    assert known == {"Jalandhar Sports Goods": "observatory", "Jalandhar Rubber": "observatory"}
    assert prev["district_state"]["cursor"] == 165                                  # resumes after the last run
