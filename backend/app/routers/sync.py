"""Daily cloud sync of the deep-dive sources (see ``app.services.cloud_sync``).

Endpoints
---------
* ``GET  /api/cron/sync``    Vercel Cron (``vercel.json`` ``crons``) with ``Authorization: Bearer <CRON_SECRET>``:
                             scrape every source, store the snapshots, apply them on this instance.
                             ``?sources=cluster_observatory,market_tariffs`` limits the run.
* ``POST /api/sync/run``     the same for a signed-in admin ("sync now").
* ``GET  /api/sync/status``  public: whether the sync is configured, the manifest (per source: status, time,
                             records, message) and what this instance has applied.
"""
from __future__ import annotations

import hmac
import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.db import get_db
from app.security import require_admin
from app.services import cloud_sync
from app.services.audit import log_action
from app.services.connectors.base import ConnectorError

router = APIRouter(prefix="/api", tags=["cloud sync"])


def _sources(raw: str | None) -> tuple[str, ...]:
    if not raw:
        return cloud_sync.SOURCES
    picked = tuple(s.strip() for s in raw.split(",") if s.strip())
    unknown = [s for s in picked if s not in cloud_sync.SOURCES]
    if unknown:
        raise HTTPException(422, f"unknown source(s) {unknown}; use {', '.join(cloud_sync.SOURCES)}")
    return picked


def _run(conn: sqlite3.Connection, sources: tuple[str, ...]) -> dict:
    if not cloud_sync.enabled():
        raise HTTPException(503, "cloud sync is not configured on this server (CRON_SECRET / base URL missing)")
    try:
        manifest = cloud_sync.run_sync(conn, sources)
    except ConnectorError as exc:
        raise HTTPException(502, str(exc)) from exc
    overlay = cloud_sync.apply_latest(conn, force=True, manifest=manifest)
    return {"manifest": manifest, "overlay": overlay}


@router.get("/cron/sync")
def cron_sync(request: Request, sources: str | None = Query(None),
              conn: sqlite3.Connection = Depends(get_db)) -> dict:
    expected = f"Bearer {cloud_sync.secret()}"
    given = request.headers.get("authorization") or ""
    if not cloud_sync.secret() or not hmac.compare_digest(given.encode(), expected.encode()):
        raise HTTPException(401, "unauthorized")
    return _run(conn, _sources(sources))


@router.post("/sync/run")
def run_now(sources: str | None = Query(None), conn: sqlite3.Connection = Depends(get_db),
            user: dict = Depends(require_admin)) -> dict:
    result = _run(conn, _sources(sources))
    log_action(conn, user, "sync.run", "cloud_sync", ",".join(_sources(sources)),
               {s: e.get("status") for s, e in result["manifest"].get("sources", {}).items()})
    return result


@router.get("/sync/status")
def sync_status(conn: sqlite3.Connection = Depends(get_db)) -> dict:
    return cloud_sync.status(conn)
