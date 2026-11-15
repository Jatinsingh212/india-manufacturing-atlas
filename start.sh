#!/usr/bin/env bash
# Start the India Manufacturing Atlas on http://127.0.0.1:8000 (macOS / Linux / Git Bash).
# First run: downloads the public sources, builds the SQLite atlas and the dashboard bundle.
#   ./start.sh            start (building whatever is missing)
#   ./start.sh --rebuild  force a fresh ETL + frontend build
set -euo pipefail
PORT="${PORT:-8000}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
REBUILD=0
[[ "${1:-}" == "--rebuild" ]] && REBUILD=1
PY="${PYTHON:-python}"
command -v "$PY" >/dev/null 2>&1 || PY=python3

cd "$ROOT/backend"
if [[ $REBUILD == 1 || ! -f data/atlas.db ]]; then
  echo "==> Fetching public sources (cached files are reused)"
  "$PY" -m scripts.fetch_sources
  echo "==> Building data/atlas.db"
  "$PY" -m scripts.build_db
fi

if [[ $REBUILD == 1 || ! -f "$ROOT/frontend/dist/index.html" ]]; then
  cd "$ROOT/frontend"
  [[ -d node_modules ]] || { echo "==> Installing frontend dependencies"; npm install; }
  echo "==> Building the dashboard"
  npm run build
fi

echo "==> India Manufacturing Atlas on http://127.0.0.1:$PORT  (API docs: /api/docs)"
cd "$ROOT/backend"
# --http h11: the pure-Python HTTP parser (avoids depending on a working httptools build)
exec "$PY" -m uvicorn app.main:app --host 127.0.0.1 --port "$PORT" --http h11
