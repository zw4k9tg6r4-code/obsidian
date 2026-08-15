[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$VaultPath,
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexSecondBrain'),
    [switch]$Semantic,
    [switch]$AcceptModelDownload
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$vault = (Resolve-Path -LiteralPath $VaultPath).Path
if (-not (Test-Path -LiteralPath (Join-Path $vault 'AGENTS.md'))) {
    throw "Vault root AGENTS.md is missing: $vault"
}
if ($Semantic -and -not $AcceptModelDownload) {
    throw 'Semantic indexing may download the 90 MB MIT-licensed BAAI/bge-small-zh-v1.5 model. Re-run with -AcceptModelDownload.'
}

$arguments = @('src/cli.js', 'index', '--vault', $vault, '--data-dir', $DataDir, '--json')
if ($Semantic) { $arguments += '--semantic' }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw "Index initialization failed with exit code $LASTEXITCODE" }

