"""FastAPI application factory (docs/SPEC.md sections 1, 2 and 6.1).

Run from ``backend/``::

    python -m app.main --port 8000                                  # uvicorn with the h11 parser
    python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --http h11

(``--http h11`` matters on machines with a broken ``httptools`` install - see :func:`run`.)

``create_app(db_path=None, frontend_dist=None)`` builds an independent app instance; tests use it to point an
app at a temporary copy of the database (``app.state.db_path`` is read by ``app.db.get_db``).

What the factory wires up
-------------------------
* Routers from the fixed list in :data:`app.routers.ROUTER_MODULES` (SPEC section 2). A module that is missing
  or fails to import is skipped with a logged warning, so parallel builders can land routers independently;
  ``/api/health`` reports what was loaded (``routers.loaded`` / ``routers.unavailable``).
* CORS for the Vite dev server (``http://localhost:5173``, ``http://127.0.0.1:5173``), GZip for responses
  over 1 KB, and an ``X-Process-Time-Ms`` response header (handy for the 1.5 s performance budget).
* OpenAPI docs at ``/api/docs`` (Swagger UI), ``/api/redoc`` and ``/api/openapi.json``.
* API lookup indexes (``app.db.ensure_indexes``, ``CREATE INDEX IF NOT EXISTS``) on the configured database.
* A start-up warm-up (lifespan) of the residual-suggestion TF-IDF index and of the full-catalogue search
  exports (CSV / XLSX) in daemon threads, so the first ``/api/residual/suggest/{hsn8}`` and the first
  ``/api/reports/search`` download stay inside the 1.5 s budget (``ATLAS_WARM_MODELS=0`` disables both; the
  test fixtures do, so temporary database copies are never fitted).
* A start-up reconciliation (lifespan) that closes refresh jobs left ``running`` by a crash or restart
  (``app.services.connectors.reconcile_orphans``).
* ``GET /api/health`` -> ``{status, built_at, latest_year, products, db_path, ...}``; ``status`` is ``"ok"``,
  or ``"no_database"`` (still HTTP 200) when the database has not been built yet.
* The built SPA (``frontend/dist`` or ``ATLAS_FRONTEND_DIST``) at ``/`` when ``index.html`` exists: a real
  file under the dist folder is served as is (hashed ``/assets/*`` with a one-year immutable cache), every
  other GET path returns ``index.html`` (client-side routing). Paths under ``/api`` are never answered by the
  SPA fallback - an unknown API path stays a JSON 404.
"""
from __future__ import annotations

import importlib
import logging
import sqlite3
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse

from app import __version__
from app.config import get_settings
from app.db import DatabaseMissing, connect, ensure_indexes
from app.routers import ROUTER_MODULES

log = logging.getLogger("atlas")

API_PREFIX = "/api"
_ASSET_CACHE = "public, max-age=31536000, immutable"


def _include_routers(app: FastAPI) -> tuple[list[str], dict[str, str]]:
    """Import ``app.routers.<name>`` for every name in the fixed list; return (loaded, unavailable)."""
    loaded: list[str] = []
    unavailable: dict[str, str] = {}
    for name in ROUTER_MODULES:
        module_name = f"app.routers.{name}"
        try:
            module = importlib.import_module(module_name)
        except ModuleNotFoundError as exc:
            if exc.name == module_name:
                unavailable[name] = "not implemented yet"
                log.warning("router %s skipped: module not found", name)
            else:
                unavailable[name] = f"import failed: {exc}"
                log.warning("router %s skipped: %s", name, exc)
            continue
        except Exception as exc:  # noqa: BLE001 - a broken router must not take the whole API down
            unavailable[name] = f"import failed: {exc.__class__.__name__}: {exc}"
            log.warning("router %s skipped: import raised %s: %s", name, exc.__class__.__name__, exc)
            continue
        router = getattr(module, "router", None)
        if router is None:
            unavailable[name] = "module has no 'router'"
            log.warning("router %s skipped: module has no 'router' attribute", name)
            continue
        try:
            app.include_router(router)
        except Exception as exc:  # noqa: BLE001
            unavailable[name] = f"include failed: {exc}"
            log.warning("router %s skipped: include_router raised %s", name, exc)
            continue
        loaded.append(name)
    return loaded, unavailable


def _health(app: FastAPI) -> dict:
    """Body of ``GET /api/health`` (never raises; a missing database is reported, not an error)."""
    db_path = Path(app.state.db_path)
    body = {"status": "ok", "built_at": None, "latest_year": None, "products": None, "db_path": str(db_path),
            "build_mode": None, "version": __version__,
            "routers": {"loaded": app.state.routers_loaded, "unavailable": app.state.routers_unavailable}}
    try:
        conn = connect(db_path)
    except DatabaseMissing:
        body["status"] = "no_database"
        return body
    try:
        meta = {r["key"]: r["value"] for r in conn.execute(
            "SELECT key, value FROM meta WHERE key IN ('built_at', 'latest_year', 'build_mode')")}
        body["built_at"] = meta.get("built_at")
        body["build_mode"] = meta.get("build_mode")
        try:
            body["latest_year"] = int(meta["latest_year"]) if meta.get("latest_year") else None
        except ValueError:
            body["latest_year"] = None
        body["products"] = conn.execute("SELECT COUNT(*) AS n FROM products").fetchone()["n"]
    except sqlite3.Error as exc:
        body["status"] = "database_error"
        body["error"] = str(exc)
    finally:
        conn.close()
    return body


def _mount_spa(app: FastAPI, dist: Path) -> bool:
    """Serve the built SPA from ``dist`` with an ``index.html`` fallback; False when there is no build."""
    index = dist / "index.html"
    if not index.is_file():
        log.info("frontend build not found at %s - API only (run 'npm run build' in frontend/)", dist)
        return False
    root = dist.resolve()

    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def spa(full_path: str) -> FileResponse:
        path = full_path.strip("/")
        if path == API_PREFIX.strip("/") or path.startswith(API_PREFIX.strip("/") + "/"):
            raise HTTPException(status_code=404, detail="Not Found")
        if path:
            candidate = (root / path).resolve()
            if candidate.is_file() and (candidate == root or root in candidate.parents):
                headers = {"Cache-Control": _ASSET_CACHE} if path.startswith("assets/") else None
                return FileResponse(candidate, headers=headers)
        return FileResponse(index, headers={"Cache-Control": "no-cache"})

    return True


def _warm_models(app: FastAPI) -> None:
    """Start the background fit of the residual-suggestion index (best effort, never raises)."""
    if not get_settings().warm_models or not Path(app.state.db_path).is_file():
        return
    try:
        from app.services import suggest
        suggest.warm_async(app.state.db_path)
    except Exception as exc:  # noqa: BLE001 - a missing optional dependency must not block start-up
        log.warning("suggestion index warm-up not started: %s", exc)
    try:
        from app.routers import reports
        reports.warm_export_async(app.state.db_path)
    except Exception as exc:  # noqa: BLE001
        log.warning("search export warm-up not started: %s", exc)


def _reconcile_jobs(app: FastAPI) -> None:
    """Close refresh jobs left 'running' by a crash / restart (best effort, never raises)."""
    db_path = Path(app.state.db_path)
    if not db_path.is_file():
        return
    try:
        from app.services import connectors

        conn = connect(db_path)
        try:
            connectors.reconcile_orphans(conn)
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001 - a reconciliation problem must not block start-up
        log.warning("could not reconcile orphaned refresh jobs: %s", exc)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    _reconcile_jobs(app)
    _warm_models(app)
    yield


def create_app(db_path: str | Path | None = None, frontend_dist: str | Path | None = None) -> FastAPI:
    """Build the Atlas API (see module docstring). ``db_path`` / ``frontend_dist`` override the settings."""
    settings = get_settings()
    app = FastAPI(
        lifespan=_lifespan,
        title="India Manufacturing Atlas API",
        version=__version__,
        description=("HSN-code intelligence platform: ministry mapping, trade (DGCIS TRADESTAT for India, CEPII BACI for the world), tariffs (WITS), "
                     "value chains and analytics for India's 8-digit tariff lines. Every number carries a "
                     "provenance object (Verified / Not verified / Not available)."),
        docs_url=f"{API_PREFIX}/docs",
        redoc_url=f"{API_PREFIX}/redoc",
        openapi_url=f"{API_PREFIX}/openapi.json",
    )
    app.state.db_path = Path(db_path) if db_path else settings.db_path

    app.add_middleware(GZipMiddleware, minimum_size=1000)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Disposition", "X-Process-Time-Ms"],
    )

    @app.middleware("http")
    async def process_time(request: Request, call_next):
        start = time.perf_counter()
        response = await call_next(request)
        response.headers["X-Process-Time-Ms"] = f"{(time.perf_counter() - start) * 1000:.1f}"
        return response

    from app.services import cloud_sync

    if cloud_sync.enabled():   # deployed: overlay the newest daily-sync snapshots (checked every 5 min per instance)
        from starlette.concurrency import run_in_threadpool

        def _overlay() -> None:
            conn = connect(app.state.db_path)
            try:
                cloud_sync.apply_latest(conn)
            finally:
                conn.close()

        @app.middleware("http")
        async def live_sync_overlay(request: Request, call_next):
            if request.url.path.startswith(f"{API_PREFIX}/") and not request.url.path.startswith(f"{API_PREFIX}/cron/"):
                try:
                    await run_in_threadpool(_overlay)
                except Exception as exc:  # noqa: BLE001 - the bundled data keeps serving
                    log.warning("cloud sync overlay skipped: %s", exc)
            return await call_next(request)

    loaded, unavailable = _include_routers(app)
    app.state.routers_loaded = loaded
    app.state.routers_unavailable = unavailable

    @app.get(f"{API_PREFIX}/health", tags=["system"], summary="Service and database status")
    def health() -> dict:
        return _health(app)

    try:
        ensure_indexes(app.state.db_path)
    except sqlite3.Error as exc:  # never block start-up; queries still work without the extra indexes
        log.warning("could not ensure API indexes: %s", exc)

    dist = Path(frontend_dist) if frontend_dist else settings.frontend_dist
    app.state.spa_mounted = _mount_spa(app, dist)
    return app


app = create_app()


def run(argv: list[str] | None = None) -> None:
    """``python -m app.main [--host 127.0.0.1] [--port 8000] [--reload]`` - uvicorn with the pure-Python h11
    HTTP parser. (On the reference machine a broken ``httptools`` folder in site-packages makes uvicorn's
    default ``--http auto`` pick a parser that fails on every request; h11 always works.)"""
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser(prog="python -m app.main", description="Run the Atlas API")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--reload", action="store_true", help="auto-reload on code changes (development)")
    args = parser.parse_args(argv)
    target = "app.main:app" if args.reload else app  # reload needs an import string
    uvicorn.run(target, host=args.host, port=args.port, reload=args.reload, http="h11")


if __name__ == "__main__":
    run()
