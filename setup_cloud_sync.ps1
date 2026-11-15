# One-time setup of the daily cloud sync on Vercel (run from the repository root, with the Vercel CLI signed in
# to the account that owns the project):
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File setup_cloud_sync.ps1
#
# 1. Creates a private Vercel Blob store "atlas-sync" and connects it to this project for Production, which
#    makes Vercel inject BLOB_READ_WRITE_TOKEN into the functions (skipped when the project already has one).
# 2. Generates a random CRON_SECRET and stores it in the project's Production environment. The value is written
#    to a temporary file only for the CLI to read and is never printed (skipped when CRON_SECRET exists).
#
# Redeploy afterwards (vercel deploy --prod) so the functions see both variables.
# 'Continue', not 'Stop': the Vercel CLI prints its banner on stderr, which Windows PowerShell 5.1 would turn into
# a terminating NativeCommandError. Every CLI call checks $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

$envList = (& vercel env ls production 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw "vercel env ls failed - is the CLI signed in to the project owner?`n$envList" }

if ($envList -match 'BLOB_READ_WRITE_TOKEN') {
    Write-Host 'Blob store already connected (BLOB_READ_WRITE_TOKEN exists) - skipped.'
} else {
    Write-Host 'Creating the private Blob store atlas-sync and connecting it to the project...'
    & vercel blob create-store atlas-sync --access private --yes --environment production
    if ($LASTEXITCODE -ne 0) { throw 'vercel blob create-store failed' }
}

if ($envList -match 'CRON_SECRET') {
    Write-Host 'CRON_SECRET already set - skipped.'
} else {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllText($tmp, $secret)      # no trailing newline
        cmd /c "vercel env add CRON_SECRET production < `"$tmp`""
        if ($LASTEXITCODE -ne 0) { throw 'vercel env add CRON_SECRET failed' }
        Write-Host 'CRON_SECRET stored in the Production environment (value not shown).'
    } finally {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        $secret = $null
    }
}

Write-Host 'Done. Now redeploy: vercel deploy --prod --yes'
