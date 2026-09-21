$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

Write-Host "AI Content Platform local startup" -ForegroundColor Cyan
Write-Host "Project: $ProjectRoot"

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example" -ForegroundColor Green
}

$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
  Write-Host ""
  Write-Host "Docker was not found on this machine." -ForegroundColor Yellow
  Write-Host "Install Docker Desktop, open it once, then run this script again:"
  Write-Host "https://www.docker.com/products/docker-desktop/"
  exit 1
}

Write-Host ""
Write-Host "Starting services with Docker Compose..." -ForegroundColor Green
docker compose up --build
