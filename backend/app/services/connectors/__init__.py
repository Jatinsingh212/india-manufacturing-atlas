"""Data Hub refresh connectors and the refresh-job runner (docs/SPEC.md section 6.11).

Registry (connector name -> ``data_sources.id``):

=============  ===============  ======================================================================
``oec``        ``oec_baci``     India HS6 exports / imports 2022-2024 from the OEC API -> ``trade_hs6``
                                and the India columns of ``hs6_metrics`` (:mod:`.oec`)
``comtrade``   ``un_comtrade``  UN Comtrade public preview, India 2023 X / M for the value-chain HS6
                                codes, compared with BACI -> ``comtrade_checks`` (:mod:`.comtrade`)
``wits``       ``wits_trains``  WITS / TRAINS India MFN applied tariffs -> ``tariffs`` (:mod:`.wits`)
``cbic``       ``cbic``         not configured until ``ATLAS_CBIC_API_KEY`` / ``ATLAS_CBIC_API_URL``
``gstn``       ``gstn``         not configured until ``ATLAS_GSTN_API_KEY`` / ``ATLAS_GSTN_API_URL``
``dgft``       ``dgft``         not configured until ``ATLAS_DGFT_API_KEY`` / ``ATLAS_DGFT_API_URL``
``cluster_     ``cluster_       Cluster Observatory MSME cluster register (scraped) -> ``co_clusters``
observatory``  observatory``    (:mod:`.deep_dive`)
``market_      ``wits_markets`` destination-market MFN tariffs (WITS) -> ``market_tariffs``
tariffs``
``iilb``       ``iilb``         India Industrial Land Bank IIS API; not configured until
                                ``ATLAS_IILB_ACCESS_TOKEN`` / ``ATLAS_IILB_STATE_LGCS``
=============  ===============  ======================================================================

File / manual sources (``gst_hsn``, ``hs_nomenclature``, ``unido_indstat``, ``rubber_board``, ``atma``) have no
live connector: they are refreshed by re-running the ETL (``python -m scripts.build_db``) after replacing the file
in ``data/raw`` / ``data/curated``.

Job lifecycle (``refresh_jobs``): :func:`start_refresh` inserts a ``running`` row and starts a daemon thread that
opens its **own** connection on the same database file (never the request's), runs the connector and finishes
the row as ``success`` or ``failed`` (message = the connector's summary or the error). A connector that is not
configured ends synchronously with status ``not_configured`` (no thread). The source's ``data_sources`` row is
updated too: ``last_refreshed`` + ``status = 'connected'`` (and ``records`` when the connector reports a new
total) on success, ``status = 'error'`` on failure, ``status = 'not_configured'`` when credentials are missing.
A second refresh of a source while one is running (started less than :data:`STALE_AFTER_MINUTES` ago) raises
:class:`RefreshInProgress`.

Orphaned jobs: a ``running`` row survives a crash or restart because only the thread that owns it finishes it.
:func:`reconcile_orphans` (called by the API's start-up lifespan) closes every ``running`` row as ``failed`` with
the message ``interrupted by server restart`` and marks the source ``error``; :func:`start_refresh` closes a
``running`` row older than :data:`STALE_AFTER_MINUTES` the same way (``stale running job closed``) before it
starts the new one, so the job list never shows a job that nothing is executing.

Source status: :func:`effective_status` turns a stored ``connected`` with no ``last_refreshed`` into
``not_refreshed`` (a live connector that has never run, e.g. UN Comtrade before its first refresh), so the
Data Hub badge never claims a connection that has not delivered data.
"""
from __future__ import annotations

import logging
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.db import get_conn, row
from app.services.audit import log_action, utc_now
from app.services.connectors import comtrade, deep_dive, gov_apis, oec, wits
from app.services.connectors.base import Connector, ConnectorError, ConnectorResult

log = logging.getLogger("atlas.connectors")

STALE_AFTER_MINUTES = 60
FILE_SOURCES = ("gst_hsn", "hs_nomenclature", "unido_indstat", "rubber_board", "atma")
RESTART_MESSAGE = "interrupted by server restart"
STALE_MESSAGE = f"stale running job closed (no progress for {STALE_AFTER_MINUTES} minutes)"
NOT_REFRESHED = "not_refreshed"

REGISTRY: dict[str, Connector] = {
    oec.connector.name: oec.connector,
    comtrade.connector.name: comtrade.connector,
    wits.connector.name: wits.connector,
    **{c.name: c for c in gov_apis.CONNECTORS},
    **{c.name: c for c in deep_dive.CONNECTORS},
}
BY_SOURCE: dict[str, Connector] = {c.source_id: c for c in REGISTRY.values()}

_threads: dict[int, threading.Thread] = {}


class RefreshInProgress(RuntimeError):
    """A refresh job for the same source is still running."""

    def __init__(self, job: dict):
        super().__init__(f"refresh job {job['id']} for '{job['source_id']}' is still running")
        self.job = job


def connector_for(source_id: str | None) -> Connector | None:
    """The connector of a ``data_sources.id`` (``oec_baci``) or connector name (``oec``), else None."""
    if not source_id:
        return None
    return BY_SOURCE.get(source_id) or REGISTRY.get(source_id)


def connector_info(source_id: str) -> dict:
    """``{name, refreshable, configured, message, required_env}`` for the Data Hub source cards."""
    connector = connector_for(source_id)
    if connector is None:
        how = ("re-run the ETL (python -m scripts.build_db) after replacing the source file"
               if source_id in FILE_SOURCES else "no live connector")
        return {"name": None, "refreshable": False, "configured": False, "message": how, "required_env": []}
    configured, message = connector.is_configured()
    required = connector.required_env() if hasattr(connector, "required_env") else []
    return {"name": connector.name, "refreshable": True, "configured": configured, "message": message,
            "required_env": required}


def effective_status(source: dict | None) -> str | None:
    """The status to show for a ``data_sources`` row (see module docstring)."""
    if not source:
        return None
    status = source.get("status")
    if status == "connected" and not source.get("last_refreshed"):
        return NOT_REFRESHED
    return status


def _close_jobs(conn: sqlite3.Connection, jobs: list[dict], message: str) -> int:
    now = utc_now()
    for job in jobs:
        conn.execute("UPDATE refresh_jobs SET status = 'failed', finished_at = ?, message = ? WHERE id = ? "
                     "AND status = 'running'", (now, message, job["id"]))
        _set_source(conn, job["source_id"], status="error")
    if jobs:
        conn.commit()
    return len(jobs)


def reconcile_orphans(conn: sqlite3.Connection) -> int:
    """Close every ``running`` refresh job that no thread of this process owns (start-up); returns the count."""
    from app.db import rows

    orphans = [j for j in rows(conn, "SELECT id, source_id FROM refresh_jobs WHERE status = 'running'")
               if j["id"] not in _threads]
    n = _close_jobs(conn, orphans, RESTART_MESSAGE)
    if n:
        log.warning("closed %d orphaned refresh job(s) as failed (%s)", n, RESTART_MESSAGE)
    return n


def job_dict(job: dict | None) -> dict | None:
    """A ``refresh_jobs`` row for the API (+ ``connector`` and ``duration_s``)."""
    if not job:
        return None
    out = dict(job)
    connector = connector_for(job.get("source_id"))
    out["connector"] = connector.name if connector else None
    duration = None
    try:
        if job.get("finished_at"):
            duration = (datetime.fromisoformat(job["finished_at"]) -
                        datetime.fromisoformat(job["started_at"])).total_seconds()
    except (TypeError, ValueError):
        duration = None
    out["duration_s"] = duration
    return out


def get_job(conn: sqlite3.Connection, job_id: int) -> dict | None:
    """One job (API shape) or None."""
    return job_dict(row(conn, "SELECT * FROM refresh_jobs WHERE id = ?", (job_id,)))


def _set_source(conn: sqlite3.Connection, source_id: str, *, status: str, refreshed: bool = False,
                records: int | None = None) -> None:
    sets, params = ["status = ?"], [status]
    if refreshed:
        sets.append("last_refreshed = ?")
        params.append(utc_now())
    if records is not None:
        sets.append("records = ?")
        params.append(int(records))
    conn.execute(f"UPDATE data_sources SET {', '.join(sets)} WHERE id = ?", (*params, source_id))


def start_refresh(conn: sqlite3.Connection, db_path: str | Path, source_id: str, user: dict | None) -> dict:
    """Create a refresh job for ``source_id`` and run it (thread, or synchronously when not configured).

    Raises ``LookupError`` for a source without a connector and :class:`RefreshInProgress`.
    Returns the job (API shape) as it is right after starting.
    """
    connector = connector_for(source_id)
    if connector is None:
        raise LookupError(source_id)
    source_key = connector.source_id
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=STALE_AFTER_MINUTES)).isoformat(timespec="seconds")
    running = row(conn, "SELECT * FROM refresh_jobs WHERE source_id = ? AND status = 'running' AND started_at >= ? "
                        "ORDER BY id DESC LIMIT 1", (source_key, cutoff))
    if running:
        raise RefreshInProgress(running)
    from app.db import rows

    stale = [j for j in rows(conn, "SELECT id, source_id FROM refresh_jobs WHERE source_id = ? AND status = 'running'",
                             (source_key,)) if j["id"] not in _threads]
    if _close_jobs(conn, stale, STALE_MESSAGE):
        log.warning("closed %d stale running job(s) of %s before starting a new refresh", len(stale), source_key)
    user_id = (user or {}).get("id")
    configured, message = connector.is_configured()
    now = utc_now()
    if not configured:
        cur = conn.execute("INSERT INTO refresh_jobs (source_id, started_at, finished_at, status, records, message, "
                           "triggered_by) VALUES (?, ?, ?, 'not_configured', 0, ?, ?)",
                           (source_key, now, now, message, user_id))
        _set_source(conn, source_key, status="not_configured")
        conn.commit()
        return get_job(conn, cur.lastrowid)
    cur = conn.execute("INSERT INTO refresh_jobs (source_id, started_at, status, records, message, triggered_by) "
                       "VALUES (?, ?, 'running', NULL, 'queued', ?)", (source_key, now, user_id))
    conn.commit()
    job_id = cur.lastrowid
    thread = threading.Thread(target=run_job, args=(str(db_path), job_id, connector.name, user),
                              name=f"atlas-refresh-{connector.name}-{job_id}", daemon=True)
    _threads[job_id] = thread
    thread.start()
    return get_job(conn, job_id)


def run_job(db_path: str | Path, job_id: int, connector_name: str, user: dict | None = None) -> ConnectorResult | None:
    """Run one refresh job to completion on its own connection (the body of the refresh thread)."""
    connector = REGISTRY[connector_name]
    conn = get_conn(db_path)
    try:
        def progress(text: str) -> None:
            try:
                conn.execute("UPDATE refresh_jobs SET message = ? WHERE id = ?", (str(text)[:500], job_id))
                conn.commit()
            except sqlite3.Error as exc:  # progress lines are cosmetic
                log.debug("progress update failed: %s", exc)

        try:
            result = connector.run(conn, progress)
        except Exception as exc:  # noqa: BLE001 - every failure must end the job as 'failed'
            conn.rollback()
            reason = str(exc) if isinstance(exc, ConnectorError) else f"{exc.__class__.__name__}: {exc}"
            log.warning("refresh job %s (%s) failed: %s", job_id, connector_name, reason)
            conn.execute("UPDATE refresh_jobs SET status = 'failed', finished_at = ?, message = ? WHERE id = ?",
                         (utc_now(), reason[:2000], job_id))
            _set_source(conn, connector.source_id, status="error")
            conn.commit()
            log_action(conn, user, "source.refresh.failed", "data_source", connector.source_id,
                       {"job_id": job_id, "error": reason[:500]})
            return None
        conn.execute("UPDATE refresh_jobs SET status = ?, finished_at = ?, records = ?, message = ? WHERE id = ?",
                     (result.status, utc_now(), result.records, result.message[:2000], job_id))
        if result.status == "success":
            _set_source(conn, connector.source_id, status=result.source_status or "connected", refreshed=True,
                        records=result.source_records)
        else:
            _set_source(conn, connector.source_id, status=result.source_status or result.status)
        conn.commit()
        log_action(conn, user, "source.refresh.done", "data_source", connector.source_id,
                   {"job_id": job_id, "status": result.status, "records": result.records})
        return result
    finally:
        conn.close()
        _threads.pop(job_id, None)


def wait_for(job_id: int, timeout: float = 60.0) -> bool:
    """Block until the thread of ``job_id`` has finished (tests / CLI); True when it is done."""
    thread = _threads.get(job_id)
    if thread is None:
        return True
    thread.join(timeout)
    return not thread.is_alive()


__all__ = ["REGISTRY", "BY_SOURCE", "FILE_SOURCES", "NOT_REFRESHED", "RESTART_MESSAGE", "STALE_MESSAGE",
           "RefreshInProgress", "connector_for", "connector_info", "effective_status", "job_dict", "get_job",
           "reconcile_orphans", "start_refresh", "run_job", "wait_for"]
