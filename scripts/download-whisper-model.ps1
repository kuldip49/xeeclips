param([string]$Revision = 'main')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$modelDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) 'models/whisper-base'
New-Item -ItemType Directory -Force -Path $modelDirectory | Out-Null
# Explicit provisioning only. TLS verification remains enabled.
# Resolve main once so every file comes from the same model revision.
$metadata = Invoke-RestMethod "https://huggingface.co/api/models/Systran/faster-whisper-base/revision/$Revision"
$modelRevision = $metadata.sha
foreach ($name in @('config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt')) {
    Write-Host "Downloading $name at $modelRevision"
    $target = Join-Path $modelDirectory $name
    Invoke-WebRequest -UseBasicParsing -Uri "https://huggingface.co/Systran/faster-whisper-base/resolve/$modelRevision/$name" -OutFile "$target.partial"
    Move-Item -LiteralPath "$target.partial" -Destination $target -Force
}
Write-Host "Model ready at $modelDirectory. Restart ai-service to load it."
