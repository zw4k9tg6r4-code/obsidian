[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$VaultPath,
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexSecondBrain'),
    [switch]$Semantic,
    [switch]$AcceptModelDownload
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$DataDir = [System.IO.Path]::GetFullPath($DataDir)
$vault = (Resolve-Path -LiteralPath $VaultPath).Path
if (-not (Test-Path -LiteralPath (Join-Path $vault 'AGENTS.md'))) {
    throw "Vault root AGENTS.md is missing: $vault"
}
if ($Semantic -and -not $AcceptModelDownload) {
    throw 'Semantic indexing may download the 90 MB MIT-licensed BAAI/bge-small-zh-v1.5 model. Re-run with -AcceptModelDownload.'
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 22 or newer is required before index initialization.' }
$nodeVersionOutput = @(& $node.Source --version 2>&1)
$nodeVersionMatch = [regex]::Match((@($nodeVersionOutput | ForEach-Object { [string]$_ }) -join ' ').Trim(), '^v?(\d+)\.')
if ($LASTEXITCODE -ne 0 -or -not $nodeVersionMatch.Success -or [int]$nodeVersionMatch.Groups[1].Value -lt 22) {
    throw 'Node.js 22 or newer is required before index initialization.'
}

function Test-CliDependencies {
    param([Parameter(Mandatory = $true)][string]$Root)
    return ((Test-Path -LiteralPath (Join-Path $Root 'node_modules\yaml\package.json') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $Root 'node_modules\@tobilu\qmd\package.json') -PathType Leaf))
}

$sourceCli = Join-Path $projectRoot 'src\cli.js'
$installedRoot = Join-Path $DataDir 'app'
$installedCli = Join-Path $installedRoot 'src\cli.js'
if ((Test-Path -LiteralPath $sourceCli -PathType Leaf) -and (Test-CliDependencies -Root $projectRoot)) {
    $cli = $sourceCli
} elseif ((Test-Path -LiteralPath $installedCli -PathType Leaf) -and (Test-CliDependencies -Root $installedRoot)) {
    $cli = $installedCli
} else {
    throw 'No runnable Second Brain CLI was found. Run the base installer first or run npm ci in the source checkout.'
}

if ($Semantic -and $AcceptModelDownload) {
    $downloadScript = Join-Path $projectRoot 'scripts\download-semantic-model.ps1'
    if (-not (Test-Path -LiteralPath $downloadScript -PathType Leaf)) {
        throw "Semantic model downloader is missing: $downloadScript"
    }
    & $downloadScript -DataDir $DataDir -AcceptModelDownload
}

$arguments = @($cli, 'index', '--vault', $vault, '--data-dir', $DataDir, '--json')
if ($Semantic) { $arguments += '--semantic' }
& $node.Source @arguments
if ($LASTEXITCODE -ne 0) { throw "Index initialization failed with exit code $LASTEXITCODE" }
