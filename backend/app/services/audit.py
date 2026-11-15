"""Audit trail (docs/SPEC.md section 5: every mutating endpoint writes ``audit_log``).

``log_action(conn, user, action, entity, entity_id, details)`` inserts one row::

    log_action(conn, user, "claim.create", "residual_claim", claim_id, {"hsn8": "70196900"})

* ``user`` is the ``User`` dict from ``app.security`` (or ``None`` / the public user for guest actions such as a
  public helpdesk ticket) - its ``id`` and ``email`` are stored.
* ``action`` is a dotted verb: ``login``, ``login.demo``, ``user.register``, ``claim.create``, ``claim.review``,
  ``mapping.change``, ``upload.create``, ``upload.apply``, ``ticket.create``, ``source.refresh`` ...
* ``details`` is any JSON-serialisable value (stored as ``details_json``).
* The row is committed immediately unless ``commit=False`` (then it joins the caller's transaction, which is
  what a multi-statement mutation should do so the audit row and the change commit together).

Audit writes must never break the request that triggered them: database errors are logged and swallowed, and
the function returns ``None`` in that case (the new ``audit_log.id`` otherwise).
"""
from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger("atlas.audit")


def utc_now() -> str:
    """Current UTC time as ISO-8601 with seconds (``2026-10-19T09:12:34+00:00``)."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def log_action(conn: sqlite3.Connection, user: dict | None, action: str, entity: str | None = None,
               entity_id: Any = None, details: Any = None, *, commit: bool = True) -> int | None:
    """Insert an ``audit_log`` row; returns its id (``None`` if the write failed - logged, never raised)."""
    user_id = user.get("id") if user else None
    user_email = user.get("email") if user else None
    try:
        details_json = None if details is None else json.dumps(details, default=str, ensure_ascii=False)
        cur = conn.execute(
            "INSERT INTO audit_log (ts, user_id, user_email, action, entity, entity_id, details_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (utc_now(), user_id, user_email, action, entity, None if entity_id is None else str(entity_id),
             details_json))
        if commit:
            conn.commit()
        return cur.lastrowid
    except (sqlite3.Error, TypeError, ValueError) as exc:
        log.error("audit_log write failed for %s on %s/%s: %s", action, entity, entity_id, exc)
        return None
