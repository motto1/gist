$ErrorActionPreference = "Stop"

$backendRoot = Join-Path $PSScriptRoot ".." "resources" "gist-video" "backend"
Write-Host "[gist-video] backendRoot=$backendRoot"

Set-Location $backendRoot

if (!(Test-Path ".venv")) {
  Write-Host "[gist-video] Creating venv..."
  python -m venv ".venv"
}

$py = Join-Path $backendRoot ".venv" "Scripts" "python.exe"
if (!(Test-Path $py)) {
  throw "python.exe not found in venv: $py"
}

Write-Host "[gist-video] Installing deps..."
& $py -m pip install -U pip
& $py -m pip install -r "requirements-dev.txt"

Write-Host "[gist-video] Done."

