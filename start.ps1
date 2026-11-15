# Start the India Manufacturing Atlas on http://127.0.0.1:8000 (Windows PowerShell).
# First run: downloads the public sources, builds the SQLite atlas and the dashboard bundle.
param(
    [int]$Port = 8000,
    [switch]$Rebuild   # force a fresh ETL + frontend build
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"

Push-Location $backend
try {
    if ($Rebuild -or -not (Test-Path "data\atlas.db")) {
        Write-Host "==> Fetching public sources (cached files are reused)" -ForegroundColor Cyan
        python -m scripts.fetch_sources
        Write-Host "==> Building data\atlas.db" -ForegroundColor Cyan
        python -m scripts.build_db
    }
} finally { Pop-Location }

if ($Rebuild -or -not (Test-Path (Join-Path $frontend "dist\index.html"))) {
    Push-Location $frontend
    try {
        if (-not (Test-Path "node_modules")) {
            Write-Host "==> Installing frontend dependencies" -ForegroundColor Cyan
            npm install
        }
        Write-Host "==> Building the dashboard" -ForegroundColor Cyan
        npm run build
    } finally { Pop-Location }
}

Write-Host "==> India Manufacturing Atlas on http://127.0.0.1:$Port  (API docs: /api/docs)" -ForegroundColor Green
Push-Location $backend
# --http h11: the pure-Python HTTP parser (avoids depending on a working httptools build)
try { python -m uvicorn app.main:app --host 127.0.0.1 --port $Port --http h11 }
finally { Pop-Location }
