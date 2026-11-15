"""Vercel serverless entry point: the Atlas FastAPI app as one Python function.

Vercel serves the built dashboard (frontend/dist) as static files and rewrites every ``/api/*`` request here
(see vercel.json). The function bundle carries ``backend/data/deploy/atlas.db.gz`` - the slim database written by
``python -m scripts.build_deploy_db`` - and unpacks it to ``/tmp`` (the only writable path) on cold start, so
sign-ins, helpdesk tickets and claims work. Each instance has its own copy: writes are not shared between
instances and are lost when an instance is recycled. For a persistent multi-user deployment, point ATLAS_DB at
a managed database volume instead.

Set ``ATLAS_JWT_SECRET`` in the Vercel project (otherwise every instance would sign sessions with its own secret),
and ``GROQ_API_KEY`` (or ``XAI_API_KEY`` / ``GEMINI_API_KEY`` / ``OPENROUTER_API_KEY``) for the AI assistant.
"""
from __future__ import annotations

import gzip
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
BUNDLED_DB = BACKEND / "data" / "deploy" / "atlas.db.gz"
RUNTIME_DIR = Path(os.environ.get("ATLAS_RUNTIME_DIR", "/tmp/atlas"))
RUNTIME_DB = RUNTIME_DIR / "atlas.db"

sys.path.insert(0, str(BACKEND))


def _unpack_database() -> None:
    """Decompress the bundled database once per instance (about half a second)."""
    if RUNTIME_DB.is_file():
        return
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    part = RUNTIME_DB.with_suffix(".part")
    with gzip.open(BUNDLED_DB, "rb") as src, open(part, "wb") as dst:
        shutil.copyfileobj(src, dst, 1 << 20)
    os.replace(part, RUNTIME_DB)


_unpack_database()
os.environ.setdefault("ATLAS_DB", str(RUNTIME_DB))
os.environ.setdefault("ATLAS_UPLOAD_DIR", str(RUNTIME_DIR / "uploads"))
os.environ.setdefault("ATLAS_JWT_SECRET_FILE", str(RUNTIME_DIR / ".jwt_secret"))
os.environ.setdefault("ATLAS_WARM_MODELS", "0")              # short-lived instances: no background pre-rendering
os.environ.setdefault("ATLAS_FRONTEND_DIST", str(RUNTIME_DIR / "no-dist"))  # Vercel serves the SPA itself

from app.main import app  # noqa: E402  (needs the environment above)

__all__ = ["app"]
