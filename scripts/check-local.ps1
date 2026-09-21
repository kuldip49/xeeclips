$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

Write-Host "Checking local dependencies..." -ForegroundColor Cyan

$commands = @("node", "npm", "docker")

foreach ($command in $commands) {
  $found = Get-Command $command -ErrorAction SilentlyContinue
  if ($found) {
    Write-Host "[OK] $command -> $($found.Source)" -ForegroundColor Green
  } else {
    Write-Host "[MISSING] $command" -ForegroundColor Yellow
  }
}

Write-Host ""
Write-Host "Project files:"
Get-ChildItem -File -Recurse | Select-Object -First 40 FullName
