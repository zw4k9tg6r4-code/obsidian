[CmdletBinding()]
param(
    [string]$VaultPath,
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexSecondBrain'),
    [string]$AppPath = (Join-Path $env:LOCALAPPDATA 'CodexSecondBrain\app')
)

$ErrorActionPreference = 'Stop'
$app = (Resolve-Path -LiteralPath $AppPath).Path
$cli = Join-Path $app 'src\cli.js'
if (-not (Test-Path -LiteralPath $cli)) { throw "CLI is missing: $cli" }

$arguments = @($cli, 'health', '--data-dir', $DataDir, '--json')
if ($VaultPath) { $arguments += @('--vault', (Resolve-Path -LiteralPath $VaultPath).Path) }
$raw = & node @arguments
if ($LASTEXITCODE -ne 0) { throw "Health check failed with exit code $LASTEXITCODE" }
$health = $raw | ConvertFrom-Json

[pscustomobject]@{
    ok = [bool]$health.indexed
    indexed = [bool]$health.indexed
    indexFresh = [bool]$health.indexFresh
    semanticHealthy = [bool]$health.semanticHealthy
    degraded = [bool]$health.degraded
    reason = $health.reason
} | ConvertTo-Json

