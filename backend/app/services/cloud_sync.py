"""Daily cloud sync of the deep-dive sources on Vercel, and the live overlay that serves the synced data.

Why: the deployed API runs on short-lived serverless instances, each with its own copy of the bundled database
(``api/index.py`` unpacks ``atlas.db.gz`` to ``/tmp``), so nothing a function writes survives. The sync therefore
keeps the freshly scraped data as small gzipped snapshots in Vercel Blob storage, and every instance overlays
the newest snapshots onto its own database.

Pieces
------
* **Daily job** - :func:`run_sync` (``GET /api/cron/sync``, called by Vercel Cron with ``CRON_SECRET``; admins can
  start it with ``POST /api/sync/run``). In parallel:

  - ``cluster_observatory``: the Cluster Observatory register; the slow district pass runs sequentially for
    :data:`DISTRICT_BUDGET_S` seconds a day from where the previous run stopped (connector code reused),
  - ``market_tariffs``: WITS MFN schedules of every market, one thread per market,
  - ``iilb_parks``: the Land Bank park report, read by the Node function ``/api/iilb-report`` (serverless
    Chromium) which stores its own snapshot.

  Each source writes ``sync/<source>.json.gz`` (same shape as the raw caches in ``data/raw``); a source that fails
  keeps its previous snapshot. ``sync/manifest.json`` records every source's status, time and record count.
* **Overlay** - :func:`apply_latest` reads the manifest (at most every :data:`CHECK_EVERY_S` seconds per
  instance) and applies any snapshot newer than the one this database has (``meta.sync_<source>``) with the same
  loaders the local build uses, updates ``data_sources`` and records a ``refresh_jobs`` row - which changes the
  analytics cache fingerprint, so cached pages are rebuilt.
* **Storage** goes through the Node function ``/api/blob-store`` (official ``@vercel/blob`` SDK); Python holds
  no storage credentials, only ``CRON_SECRET``.

Configuration: ``CRON_SECRET`` (shared secret), ``BLOB_READ_WRITE_TOKEN`` (set by Vercel when the Blob store is
connected; used by the Node functions only) and the base URL - ``ATLAS_SYNC_BASE_URL`` or Vercel's
``VERCEL_PROJECT_PRODUCTION_URL``. Without them (local development) the sync is disabled and the local
connectors / ``scripts/refresh_sources.py`` are used instead.
"""
from __future__ import annotations

import gzip
import json
import logging
import os
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import requests

from app.services.connectors import deep_dive as dd
from app.services.connectors.base import ConnectorError, USER_AGENT

log = logging.getLogger("atlas.cloud_sync")

SOURCES = ("cluster_observatory", "market_tariffs", "iilb_parks")
SOURCE_IDS = {"cluster_observatory": "cluster_observatory", "market_tariffs": "wits_markets", "iilb_parks": "iilb"}
MANIFEST = "manifest.json"
CHECK_EVERY_S = 300
HTTP_TIMEOUT_S = 30
IILB_TIMEOUT_S = 280
DISTRICT_BUDGET_S = 150          # sequential district queries per daily run (the site is slow under load)

_lock = threading.Lock()
_last_check = 0.0


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def secret() -> str:
    return (os.environ.get("CRON_SECRET") or "").strip()


def base_url() -> str | None:
    url = (os.environ.get("ATLAS_SYNC_BASE_URL") or "").strip()
    if not url and os.environ.get("VERCEL_PROJECT_PRODUCTION_URL"):
        url = "https://" + os.environ["VERCEL_PROJECT_PRODUCTION_URL"].strip()
    return url.rstrip("/") or None


def enabled() -> bool:
    return bool(secret() and base_url())


def _headers() -> dict:
    return {"Authorization": f"Bearer {secret()}", "User-Agent": USER_AGENT}


# --------------------------------------------------------------------------- storage (via /api/blob-store)

def blob_put(name: str, data: bytes) -> None:
    resp = requests.put(f"{base_url()}/api/blob-store", params={"name": name}, data=data, headers=_headers(),
                        timeout=HTTP_TIMEOUT_S)
    if resp.status_code != 200:
        raise ConnectorError(f"storing {name} failed: HTTP {resp.status_code} {resp.text[:200]}")


def blob_get(name: str) -> bytes | None:
    resp = requests.get(f"{base_url()}/api/blob-store", params={"name": name}, headers=_headers(),
                        timeout=HTTP_TIMEOUT_S)
    if resp.status_code == 404:
        return None
    if resp.status_code != 200:
        raise ConnectorError(f"reading {name} failed: HTTP {resp.status_code} {resp.text[:200]}")
    return resp.content


def put_snapshot(source: str, snap: dict) -> None:
    blob_put(f"{source}.json.gz", gzip.compress(json.dumps(snap, ensure_ascii=False).encode("utf-8")))


def get_snapshot(source: str) -> dict | None:
    data = blob_get(f"{source}.json.gz")
    return json.loads(gzip.decompress(data)) if data else None


def get_manifest() -> dict:
    data = blob_get(MANIFEST)
    return json.loads(data) if data else {"sources": {}}


# --------------------------------------------------------------------------- the daily job

def _markets(conn: sqlite3.Connection) -> list[dict]:
    cur = conn.cursor()
    cur.row_factory = None
    return [{"id": i, "name": n, "wits_code": w}
            for i, n, w in cur.execute("SELECT id, name, wits_code FROM markets ORDER BY sort_order")]


def previous_clusters() -> dict:
    """What the district pass starts from: the bundled full scrape (``data/raw/cluster_observatory.json``, every
    district confirmed by the register) overlaid with the latest cloud snapshot, so districts confirmed earlier are
    never lost while the daily runs re-check the register a slice at a time."""
    seed = json.loads(dd.CO_CACHE.read_text(encoding="utf-8")) if dd.CO_CACHE.exists() else {}
    snap = get_snapshot("cluster_observatory") or {}
    return {"clusters": (seed.get("clusters") or []) + (snap.get("clusters") or []),
            "district_state": snap.get("district_state") or seed.get("district_state") or {}}


def sync_clusters() -> dict:
    previous = previous_clusters()
    clusters, district_state = dd.cluster_observatory.fetch(previous=previous, budget_s=DISTRICT_BUDGET_S)
    if len(clusters) < dd.CO_MIN_ROWS:
        raise ConnectorError(f"only {len(clusters)} clusters returned - previous snapshot kept")
    fetched_at = now_iso()
    put_snapshot("cluster_observatory", {"fetched_at": fetched_at, "clusters": clusters,
                                         "district_state": district_state})
    confirmed = sum(1 for c in clusters if c.get("district_source") == "observatory")
    return {"records": len(clusters), "fetched_at": fetched_at,
            "message": (f"{len(clusters)} clusters; {confirmed} with a district confirmed by the register "
                        f"({district_state['queried']} of {district_state['total']} district queries this run)")}


def sync_tariffs(markets: list[dict]) -> dict:
    connector = dd.market_tariffs
    with ThreadPoolExecutor(max_workers=max(1, len(markets))) as pool:
        futures = {m["id"]: pool.submit(connector.fetch_market, m, dd.base.no_progress) for m in markets}
    snap = get_snapshot("market_tariffs") or {}
    fresh, failed = {}, []
    for market_id, fut in futures.items():
        try:
            year, rows = fut.result()
            fresh[market_id] = {"year": year, "rows": rows}
        except Exception as exc:  # noqa: BLE001 - one market failing keeps its previous rows
            failed.append(f"{market_id}: {exc}")
    if not fresh:
        raise ConnectorError("no market schedule could be fetched - previous snapshot kept; " + "; ".join(failed))
    fetched_at = now_iso()
    snap.update(fresh)
    snap["fetched_at"] = fetched_at
    put_snapshot("market_tariffs", snap)
    records = sum(len(e["rows"]) for e in snap.values() if isinstance(e, dict) and "rows" in e)
    message = ", ".join(f"{k} {v['year']}" for k, v in fresh.items())
    if failed:
        message += "; kept previous rows for " + "; ".join(failed)
    return {"records": records, "fetched_at": fetched_at, "message": message}


def sync_iilb() -> dict:
    resp = requests.get(f"{base_url()}/api/iilb-report", headers=_headers(), timeout=IILB_TIMEOUT_S)
    body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
    if resp.status_code != 200:
        raise ConnectorError(body.get("detail") or f"HTTP {resp.status_code}")
    return {"records": body["records"], "fetched_at": body["fetched_at"],
            "message": f"{body['records']} parks, {body.get('available_ha', 0):,} ha available "
                       f"(read in {body.get('seconds')} s)"}


def run_sync(conn: sqlite3.Connection, sources: tuple[str, ...] = SOURCES) -> dict:
    """Scrape the sources in parallel, store their snapshots and the manifest; returns the manifest."""
    if not enabled():
        raise ConnectorError("cloud sync is not configured: set CRON_SECRET and ATLAS_SYNC_BASE_URL "
                             "(Vercel sets VERCEL_PROJECT_PRODUCTION_URL)")
    started = time.monotonic()
    jobs = {"cluster_observatory": sync_clusters, "iilb_parks": sync_iilb}
    markets = _markets(conn)
    jobs["market_tariffs"] = lambda: sync_tariffs(markets)
    with ThreadPoolExecutor(max_workers=len(sources)) as pool:
        futures = {s: pool.submit(jobs[s]) for s in sources}
    manifest = get_manifest()
    entries = manifest.setdefault("sources", {})
    for source, fut in futures.items():
        prev = entries.get(source, {})
        try:
            result = fut.result()
            entries[source] = {**result, "status": "success", "checked_at": now_iso()}
        except Exception as exc:  # noqa: BLE001 - report every source, keep the others
            log.warning("cloud sync of %s failed: %s", source, exc)
            entries[source] = {**prev, "status": "failed", "error": str(exc)[:500], "checked_at": now_iso()}
    manifest["updated_at"] = now_iso()
    manifest["seconds"] = round(time.monotonic() - started)
    blob_put(MANIFEST, json.dumps(manifest).encode("utf-8"))
    return manifest


# --------------------------------------------------------------------------- the overlay

APPLY = {
    "cluster_observatory": dd.apply_cluster_snapshot,
    "market_tariffs": dd.apply_tariff_snapshot,
    "iilb_parks": dd.apply_iilb_snapshot,
}


def _meta(conn: sqlite3.Connection, key: str) -> str | None:
    cur = conn.cursor()
    cur.row_factory = None
    hit = cur.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return hit[0] if hit else None


def apply_snapshot(conn: sqlite3.Connection, source: str, snap: dict, entry: dict) -> int:
    """Write one snapshot into the tables and record it like a refresh job (one transaction)."""
    fetched_at = entry.get("fetched_at") or snap.get("fetched_at") or now_iso()
    try:
        n = APPLY[source](conn, snap)
        conn.execute("UPDATE data_sources SET status = 'connected', last_refreshed = ?, records = ? WHERE id = ?",
                     (fetched_at, n, SOURCE_IDS[source]))
        conn.execute("INSERT INTO refresh_jobs (source_id, started_at, finished_at, status, records, message, "
                     "triggered_by) VALUES (?, ?, ?, 'success', ?, ?, NULL)",
                     (SOURCE_IDS[source], fetched_at, now_iso(), n, f"cloud sync: {entry.get('message') or ''}"[:500]))
        conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (f"sync_{source}", fetched_at))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return n


def apply_latest(conn: sqlite3.Connection, *, force: bool = False, manifest: dict | None = None) -> dict:
    """Overlay snapshots newer than this database's; throttled per process unless ``force``. Never raises."""
    global _last_check
    if not enabled():
        return {"applied": {}, "skipped": "cloud sync not configured"}
    with _lock:
        if not force and time.monotonic() - _last_check < CHECK_EVERY_S:
            return {"applied": {}, "skipped": "checked recently"}
        _last_check = time.monotonic()
        applied, errors = {}, {}
        try:
            manifest = manifest or get_manifest()
        except Exception as exc:  # noqa: BLE001 - the bundled data keeps serving
            log.warning("cloud sync manifest unavailable: %s", exc)
            return {"applied": {}, "error": str(exc)}
        for source, entry in (manifest.get("sources") or {}).items():
            fetched = entry.get("fetched_at")
            if source not in APPLY or not fetched or (_meta(conn, f"sync_{source}") or "") >= fetched:
                continue
            try:
                snap = get_snapshot(source)
                if snap:
                    applied[source] = apply_snapshot(conn, source, snap, entry)
            except Exception as exc:  # noqa: BLE001
                log.warning("cloud sync overlay of %s failed: %s", source, exc)
                errors[source] = str(exc)[:300]
        return {"applied": applied, "errors": errors}


def status(conn: sqlite3.Connection) -> dict:
    """What the API shows: configuration, the manifest and what this instance has applied."""
    out = {"enabled": enabled(), "applied": {s: _meta(conn, f"sync_{s}") for s in SOURCES}}
    if enabled():
        try:
            out["manifest"] = get_manifest()
        except Exception as exc:  # noqa: BLE001
            out["error"] = str(exc)[:300]
    return out


__all__ = ["SOURCES", "enabled", "run_sync", "apply_latest", "apply_snapshot", "status", "get_manifest"]
