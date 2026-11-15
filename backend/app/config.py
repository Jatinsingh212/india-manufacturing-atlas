"""Application settings, read from the environment (docs/SPEC.md sections 1 and 5).

Environment variables
---------------------
``ATLAS_DB``             SQLite database path (default ``backend/data/atlas.db``).
``ATLAS_JWT_SECRET``     HS256 signing secret. When unset, a random secret is generated once and persisted in
                         ``backend/data/.jwt_secret`` (``ATLAS_JWT_SECRET_FILE`` overrides the path; owner-only
                         permissions), so the documented start scripts never run with a guessable secret. Only
                         when that file can neither be read nor written does the fixed development secret
                         remain, with a warning logged once.
``ATLAS_DEMO_MODE``      ``1`` (default) enables ``POST /api/auth/demo-login``; ``0`` / ``false`` / ``no`` / ``off``
                         disables it (the endpoint then answers 404).
``ANTHROPIC_API_KEY``    enables the Claude mode of the AI assistant (C3); absent = offline mode.
``ATLAS_FRONTEND_DIST``  built SPA folder served at ``/`` (default ``frontend/dist`` of the project).
``ATLAS_WARM_MODELS``    ``1`` (default) fits the residual-suggestion TF-IDF index in a background thread at
                         start-up so the first "Suggest owner" click is fast; ``0`` leaves it lazy (tests).

``get_settings()`` re-reads the environment on every call (it only builds a small frozen dataclass), so tests
and background jobs that point ``ATLAS_DB`` at a temporary copy of the database see the change immediately.
"""
from __future__ import annotations

import logging
import os
import secrets
import threading
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("atlas")

BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = BACKEND_DIR.parent
DATA_DIR = BACKEND_DIR / "data"
DEFAULT_DB_PATH = DATA_DIR / "atlas.db"
DEFAULT_FRONTEND_DIST = PROJECT_DIR / "frontend" / "dist"
DEFAULT_JWT_SECRET_FILE = DATA_DIR / ".jwt_secret"

#: Development-only signing secret: the last resort when no secret is set and none can be persisted.
DEV_JWT_SECRET = "atlas-dev-secret-change-me"  # noqa: S105 - documented development default
JWT_SECRET_BYTES = 48
MIN_SECRET_LENGTH = 32
JWT_EXPIRY_HOURS = 12
LATEST_YEAR = 2024
CORS_ORIGINS = ("http://localhost:5173", "http://127.0.0.1:5173")

_FALSE_VALUES = {"0", "false", "no", "off", ""}
_warned_dev_secret = False
_secret_lock = threading.Lock()
_file_secret: dict[str, str] = {}   # secret file path -> secret loaded / generated in this process


@dataclass(frozen=True)
class Settings:
    """Resolved runtime settings (immutable snapshot of the environment)."""

    db_path: Path
    jwt_secret: str
    jwt_secret_is_default: bool
    jwt_expiry_hours: int
    demo_mode: bool
    anthropic_api_key: str | None
    frontend_dist: Path
    warm_models: bool = True
    cors_origins: tuple[str, ...] = CORS_ORIGINS
    jwt_secret_source: str = "env"   # 'env' | 'file' | 'development'


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in _FALSE_VALUES


def _write_secret_file(path: Path, secret: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(secret + "\n")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass  # Windows without POSIX modes: the file still lives next to the database, outside the web root


def persisted_jwt_secret(path: str | Path | None = None) -> str | None:
    """The signing secret stored in ``path`` (default ``backend/data/.jwt_secret``), generated on first use.

    Returns None when the file can neither be read nor written (the caller then falls back to the
    development secret). The result is cached per path for the life of the process.
    """
    target = Path(path or os.environ.get("ATLAS_JWT_SECRET_FILE") or DEFAULT_JWT_SECRET_FILE).expanduser()
    key = str(target)
    with _secret_lock:
        if key in _file_secret:
            return _file_secret[key]
        try:
            if target.is_file():
                text = target.read_text(encoding="utf-8").strip()
                if len(text) >= MIN_SECRET_LENGTH:
                    _file_secret[key] = text
                    return text
                log.warning("JWT secret file %s is too short - generating a new secret", target)
            secret = secrets.token_urlsafe(JWT_SECRET_BYTES)
            _write_secret_file(target, secret)
            log.info("generated a new JWT signing secret in %s (set ATLAS_JWT_SECRET to use your own)", target)
        except OSError as exc:
            log.warning("could not read or write the JWT secret file %s: %s", target, exc)
            return None
        _file_secret[key] = secret
        return secret


def get_settings() -> Settings:
    """Build the current :class:`Settings` from the environment (cheap; safe to call per request)."""
    global _warned_dev_secret
    secret = (os.environ.get("ATLAS_JWT_SECRET") or "").strip()
    source = "env"
    if not secret:
        persisted = persisted_jwt_secret()
        if persisted:
            secret, source = persisted, "file"
        else:
            secret, source = DEV_JWT_SECRET, "development"
            if not _warned_dev_secret:
                log.warning("ATLAS_JWT_SECRET is not set and no secret file could be written - using the "
                            "development signing secret. Set ATLAS_JWT_SECRET for any shared deployment.")
                _warned_dev_secret = True
    db_env = os.environ.get("ATLAS_DB")
    dist_env = os.environ.get("ATLAS_FRONTEND_DIST")
    return Settings(
        db_path=Path(db_env).expanduser() if db_env else DEFAULT_DB_PATH,
        jwt_secret=secret,
        jwt_secret_is_default=source == "development",
        jwt_secret_source=source,
        jwt_expiry_hours=JWT_EXPIRY_HOURS,
        demo_mode=_env_bool("ATLAS_DEMO_MODE", True),
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY") or None,
        frontend_dist=Path(dist_env).expanduser() if dist_env else DEFAULT_FRONTEND_DIST,
        warm_models=_env_bool("ATLAS_WARM_MODELS", True),
    )
