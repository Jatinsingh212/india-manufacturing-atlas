"""SQLite access for the API (docs/SPEC.md section 1: one connection per request, WAL, dict rows).

Usage in a router::

    from app.db import get_db, rows, row, scalar, execute

    @router.get("/thing/{id}")
    def thing(id: str, conn: sqlite3.Connection = Depends(get_db)):
        item = row(conn, "SELECT * FROM things WHERE id = ?", (id,))

Background jobs (threads started by a request, CLI tasks) must not reuse the request connection; they open
their own with :func:`get_conn` (and close it), passing ``db_path_for(request)`` when a request is at hand so a
test app running on a temporary copy of the database keeps using that copy.

Every connection: ``row_factory`` returns plain ``dict`` rows, ``busy_timeout = 5000`` ms, ``journal_mode = WAL``,
``check_same_thread = False`` (FastAPI may run a dependency and its endpoint on different worker threads; a
connection is still only used by one request at a time). Write helpers commit by default.

``ensure_indexes`` adds the API's lookup indexes (``CREATE INDEX IF NOT EXISTS``) at startup; it never changes
tables, so ``scripts/etl/schema.sql`` stays the single schema contract.
"""
from __future__ import annotations

import json
import logging
import sqlite3
from collections.abc import Iterable, Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from fastapi import HTTPException, Request

from app.config import get_settings

log = logging.getLogger("atlas.db")

BUSY_TIMEOUT_MS = 5000

#: Indexes the API relies on for sub-second responses (created at startup when missing).
API_INDEXES: tuple[tuple[str, str], ...] = (
    ("ix_products_status", "products(mapping_status, ministry_id)"),
    ("ix_products_source", "products(mapping_source)"),
    ("ix_products_section", "products(section_id)"),
    ("ix_hs_nodes_level", "hs_nodes(level, section_id)"),
    ("ix_pm_role", "product_ministries(ministry_id, role)"),
    ("ix_vc_items_hsn8", "vc_items(hsn8)"),
    ("ix_vc_edges_chain", "vc_edges(chain_id)"),
    ("ix_scheme_products_prefix", "scheme_products(hs_prefix)"),
    ("ix_schemes_ministry", "schemes(ministry_id)"),
    ("ix_tickets_routed", "tickets(routed_ministry_id, status)"),
    ("ix_tickets_hsn8", "tickets(hsn8)"),
    ("ix_tickets_submitter", "tickets(submitted_by)"),
    ("ix_ticket_messages_ticket", "ticket_messages(ticket_id)"),
    ("ix_claims_ministry", "residual_claims(ministry_id, status)"),
    ("ix_claims_hsn8", "residual_claims(hsn8)"),
    ("ix_trade_hs6_year", "trade_hs6(year)"),
    ("ix_alerts_hs6", "alerts(hs6)"),
    ("ix_users_role", "users(role, is_demo)"),
)


class DatabaseMissing(RuntimeError):
    """The configured database file does not exist (run ``python -m scripts.build_db``)."""


# --------------------------------------------------------------------------- connections

def _dict_factory(cursor: sqlite3.Cursor, values: tuple) -> dict:
    return {col[0]: v for col, v in zip(cursor.description, values)}


def resolve_db_path(db_path: str | Path | None = None) -> Path:
    """``db_path`` if given, else the configured ``ATLAS_DB`` / ``backend/data/atlas.db``."""
    return Path(db_path) if db_path else get_settings().db_path


def connect(db_path: str | Path | None = None) -> sqlite3.Connection:
    """Open a configured connection (dict rows, WAL, busy timeout). Caller closes it.

    Raises :class:`DatabaseMissing` instead of letting ``sqlite3.connect`` create an empty file.
    """
    path = resolve_db_path(db_path)
    if not path.exists():
        raise DatabaseMissing(f"database {path} not found - run 'python -m scripts.build_db' from backend/")
    conn = sqlite3.connect(str(path), timeout=BUSY_TIMEOUT_MS / 1000, check_same_thread=False)
    conn.row_factory = _dict_factory
    conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
    try:
        conn.execute("PRAGMA journal_mode = WAL")
    except sqlite3.OperationalError as exc:  # e.g. a read-only copy; reads still work
        log.debug("could not switch %s to WAL: %s", path, exc)
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("PRAGMA temp_store = MEMORY")
    return conn


def get_conn(db_path: str | Path | None = None) -> sqlite3.Connection:
    """A new connection for background jobs / scripts (not tied to a request). Close it when done."""
    return connect(db_path)


@contextmanager
def connection(db_path: str | Path | None = None) -> Iterator[sqlite3.Connection]:
    """Context manager around :func:`get_conn` that always closes the connection."""
    conn = get_conn(db_path)
    try:
        yield conn
    finally:
        conn.close()


def db_path_for(request: Request) -> Path:
    """Database path of the app serving ``request`` (``create_app(db_path=...)``), else the configured one."""
    path = getattr(request.app.state, "db_path", None)
    return Path(path) if path else get_settings().db_path


def get_db(request: Request) -> Iterator[sqlite3.Connection]:
    """FastAPI dependency: one connection per request, closed afterwards. 503 when the DB is not built."""
    try:
        conn = connect(db_path_for(request))
    except DatabaseMissing as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    try:
        yield conn
    finally:
        conn.close()


# --------------------------------------------------------------------------- query helpers

def rows(conn: sqlite3.Connection, sql: str, params: Sequence | dict = ()) -> list[dict]:
    """All result rows as dicts."""
    return conn.execute(sql, params).fetchall()


def row(conn: sqlite3.Connection, sql: str, params: Sequence | dict = ()) -> dict | None:
    """First result row as a dict, or ``None``."""
    return conn.execute(sql, params).fetchone()


def scalar(conn: sqlite3.Connection, sql: str, params: Sequence | dict = (), default: Any = None) -> Any:
    """First column of the first row (``default`` when there is no row or the value is NULL)."""
    cur = conn.execute(sql, params)
    raw = cur.fetchone()
    if raw is None:
        return default
    value = next(iter(raw.values())) if isinstance(raw, dict) else raw[0]
    return default if value is None else value


def execute(conn: sqlite3.Connection, sql: str, params: Sequence | dict = (), *,
            commit: bool = True) -> sqlite3.Cursor:
    """Run one write statement; commits unless ``commit=False``. Returns the cursor (``lastrowid``, ``rowcount``)."""
    cur = conn.execute(sql, params)
    if commit:
        conn.commit()
    return cur


def execute_many(conn: sqlite3.Connection, sql: str, seq: Iterable[Sequence], *,
                 commit: bool = True) -> int:
    """``executemany`` + optional commit; returns the affected row count."""
    cur = conn.executemany(sql, seq)
    if commit:
        conn.commit()
    return cur.rowcount


def in_json(column: str) -> str:
    """SQL fragment ``<column> IN (SELECT value FROM json_each(?))`` - bind :func:`json_param` (any list size)."""
    return f"{column} IN (SELECT value FROM json_each(?))"


def json_param(values: Iterable) -> str:
    """JSON array parameter for :func:`in_json`."""
    return json.dumps(list(values))


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    """True when a table or view called ``name`` exists."""
    return scalar(conn, "SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
                  (name,), 0) > 0


def has_rows(conn: sqlite3.Connection, table: str) -> bool:
    """True when ``table`` exists and is non-empty (used for optional ETL outputs such as ``hs6_scores``)."""
    if not table_exists(conn, table):
        return False
    return row(conn, f'SELECT 1 AS x FROM "{table}" LIMIT 1') is not None


def ensure_indexes(db_path: str | Path | None = None) -> list[str]:
    """Create the API lookup indexes that are missing; returns the names created (errors are logged)."""
    created: list[str] = []
    try:
        conn = connect(db_path)
    except DatabaseMissing as exc:
        log.warning("%s", exc)
        return created
    try:
        existing = {r["name"] for r in rows(conn, "SELECT name FROM sqlite_master WHERE type = 'index'")}
        tables = {r["name"] for r in rows(conn, "SELECT name FROM sqlite_master WHERE type = 'table'")}
        for name, target in API_INDEXES:
            if name in existing or target.split("(", 1)[0] not in tables:
                continue
            try:
                conn.execute(f"CREATE INDEX IF NOT EXISTS {name} ON {target}")
                conn.commit()
                created.append(name)
            except sqlite3.Error as exc:  # read-only or locked database: the API still works, only slower
                log.warning("could not create index %s: %s", name, exc)
    finally:
        conn.close()
    if created:
        log.info("created API indexes: %s", ", ".join(created))
    return created
