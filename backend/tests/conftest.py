"""Shared pytest fixtures for every API test module (docs/SPEC.md section 9). Owner: C1.

Run from ``backend/``: ``python -m pytest -q`` (``backend/`` is also put on ``sys.path`` here, so a bare
``pytest`` works too).

Read-only fixtures (real ``data/atlas.db`` or ``ATLAS_DB``; every test using them is *skipped* with a clear
reason when the database has not been built):

``db_path``          Path of the database under test (session).
``app``              ``app.main.create_app(db_path=...)`` instance (session).
``client``           ``fastapi.testclient.TestClient`` on ``app`` (session; lifespan events run).
``db_conn``          a plain ``sqlite3`` connection (dict rows) for cross-checking API answers against SQL.
``token_for``        ``token_for(role, ministry_id=None) -> str`` - bearer token of the seeded demo user via
                     ``POST /api/auth/demo-login`` (cached per role; the test is skipped if no demo user exists).
``auth_headers``     ``auth_headers(role, ministry_id=None) -> {"Authorization": "Bearer ..."}``.
``admin_headers`` / ``analyst_headers`` / ``industry_headers`` / ``ministry_headers`` (Ministry of Textiles,
``mot``) / ``dpiit_headers`` (DPIIT ministry user)  - ready-made header dicts.
``timed_get``        ``timed_get(path, **kw) -> (response, seconds)`` on ``client``; ``PERF_BUDGET_S`` = 2.5.

Mutating fixtures (a private COPY of the database made with the SQLite backup API, so tests never change the
real file):

``mutable_db_path``  function-scoped copy in ``tmp_path``.
``mutable_app`` / ``mutable_client``  app + TestClient on that copy (function scope).
``module_mutable_client``  one copy shared by a whole test module (faster when many tests mutate).
``mutable_conn``     sqlite3 connection (dict rows) to the function-scoped copy, for asserting what was written.

Tokens from ``token_for`` / ``*_headers`` also work against the mutable apps: the copy has the same users and
the same signing secret. Note: ``demo-login`` writes an ``audit_log`` row (``login.demo``) to the database it is
called on; the read-only fixtures call it at most once per role per session.

Demo mode is forced on (``ATLAS_DEMO_MODE=1``) and the start-up model warm-up off (``ATLAS_WARM_MODELS=0``)
for the session; a test can switch it off with
``monkeypatch.setenv("ATLAS_DEMO_MODE", "0")`` (settings are re-read per request).
"""
from __future__ import annotations

import os
import sqlite3
import sys
import time
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

DB_PATH = Path(os.environ.get("ATLAS_DB") or BACKEND_DIR / "data" / "atlas.db")
DEMO_ROLES = ("admin", "ministry", "analyst", "industry")
PERF_BUDGET_S = 2.5


def _require_db() -> Path:
    if not DB_PATH.exists():
        pytest.skip(f"database {DB_PATH} not built - run 'python -m scripts.build_db' from backend/")
    return DB_PATH


def _dict_factory(cursor: sqlite3.Cursor, values: tuple) -> dict:
    return {col[0]: v for col, v in zip(cursor.description, values)}


def copy_database(src: Path, dst: Path) -> Path:
    """Consistent copy of ``src`` (including un-checkpointed WAL content) to ``dst`` via the backup API."""
    source = sqlite3.connect(str(src))
    target = sqlite3.connect(str(dst))
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()
    return dst


def open_conn(path: Path) -> sqlite3.Connection:
    """sqlite3 connection with dict rows (caller closes it)."""
    conn = sqlite3.connect(str(path), timeout=5)
    conn.row_factory = _dict_factory
    return conn


# --------------------------------------------------------------------------- session environment

@pytest.fixture(scope="session", autouse=True)
def _atlas_test_env() -> Iterator[None]:
    """Demo mode on for the whole session (restored afterwards)."""
    mp = pytest.MonkeyPatch()
    mp.setenv("ATLAS_DEMO_MODE", "1")
    mp.setenv("ATLAS_WARM_MODELS", "0")  # no background TF-IDF fits on temporary database copies
    yield
    mp.undo()


# --------------------------------------------------------------------------- read-only fixtures

@pytest.fixture(scope="session")
def db_path() -> Path:
    return _require_db()


@pytest.fixture(scope="session")
def app(db_path: Path):
    from app.main import create_app
    return create_app(db_path=db_path)


@pytest.fixture(scope="session")
def client(app) -> Iterator:
    from fastapi.testclient import TestClient
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(scope="session")
def db_conn(db_path: Path) -> Iterator[sqlite3.Connection]:
    conn = open_conn(db_path)
    yield conn
    conn.close()


@pytest.fixture(scope="session")
def token_for(client) -> Callable[..., str]:
    cache: dict[tuple[str, str | None], str] = {}

    def _token(role: str, ministry_id: str | None = None) -> str:
        key = (role, ministry_id)
        if key not in cache:
            body = {"role": role}
            if ministry_id:
                body["ministry_id"] = ministry_id
            response = client.post("/api/auth/demo-login", json=body)
            if response.status_code == 404:
                pytest.skip(f"no demo user for role={role} ministry={ministry_id} (was seed_ops run?)")
            assert response.status_code == 200, response.text
            cache[key] = response.json()["access_token"]
        return cache[key]

    return _token


@pytest.fixture(scope="session")
def auth_headers(token_for) -> Callable[..., dict]:
    def _headers(role: str, ministry_id: str | None = None) -> dict:
        return {"Authorization": f"Bearer {token_for(role, ministry_id)}"}

    return _headers


@pytest.fixture(scope="session")
def admin_headers(auth_headers) -> dict:
    return auth_headers("admin")


@pytest.fixture(scope="session")
def analyst_headers(auth_headers) -> dict:
    return auth_headers("analyst")


@pytest.fixture(scope="session")
def industry_headers(auth_headers) -> dict:
    return auth_headers("industry")


@pytest.fixture(scope="session")
def ministry_headers(auth_headers) -> dict:
    """Demo ministry user of the Ministry of Textiles (``mot``)."""
    return auth_headers("ministry", "mot")


@pytest.fixture(scope="session")
def dpiit_headers(auth_headers) -> dict:
    """Demo ministry user of DPIIT."""
    return auth_headers("ministry", "dpiit")


@pytest.fixture(scope="session")
def timed_get(client) -> Callable[..., tuple]:
    def _get(path: str, **kwargs) -> tuple:
        start = time.perf_counter()
        response = client.get(path, **kwargs)
        return response, time.perf_counter() - start

    return _get


# --------------------------------------------------------------------------- mutating fixtures (private copy)

@pytest.fixture()
def mutable_db_path(tmp_path: Path, db_path: Path) -> Path:
    return copy_database(db_path, tmp_path / "atlas.db")


@pytest.fixture()
def mutable_app(mutable_db_path: Path):
    from app.main import create_app
    return create_app(db_path=mutable_db_path)


@pytest.fixture()
def mutable_client(mutable_app) -> Iterator:
    from fastapi.testclient import TestClient
    with TestClient(mutable_app) as test_client:
        yield test_client


@pytest.fixture()
def mutable_conn(mutable_db_path: Path) -> Iterator[sqlite3.Connection]:
    conn = open_conn(mutable_db_path)
    yield conn
    conn.close()


@pytest.fixture(scope="module")
def module_mutable_client(tmp_path_factory: pytest.TempPathFactory, db_path: Path) -> Iterator:
    from fastapi.testclient import TestClient

    from app.main import create_app
    copy = copy_database(db_path, tmp_path_factory.mktemp("atlas_db") / "atlas.db")
    with TestClient(create_app(db_path=copy)) as test_client:
        test_client.db_path = copy  # convenience for assertions
        yield test_client
