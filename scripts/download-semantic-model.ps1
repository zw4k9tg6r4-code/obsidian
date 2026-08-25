[CmdletBinding()]
param(
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexSecondBrain'),
    [switch]$AcceptModelDownload
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $AcceptModelDownload) {
    throw 'Downloading the semantic model requires explicit -AcceptModelDownload consent.'
}

function Assert-NoReparseTraversal {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Label = 'path'
    )

    $full = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($full)
    if (-not $root) { throw "Cannot determine filesystem root for ${Label}: $Path" }
    $cursor = $root
    $segments = @($full.Substring($root.Length).Split(
        [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar),
        [System.StringSplitOptions]::RemoveEmptyEntries
    ))
    foreach ($segment in $segments) {
        $cursor = Join-Path $cursor $segment
        try { $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop }
        catch [System.Management.Automation.ItemNotFoundException] { break }
        catch { throw "Cannot safely inspect ${Label} for reparse traversal: $cursor" }
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Reparse points and junctions are not allowed in ${Label}: $cursor"
        }
    }
    return $full
}

function Assert-NotInsideObsidianVault {
    param([Parameter(Mandatory = $true)][string]$Path)
    $cursor = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    while ($cursor) {
        if (Test-Path -LiteralPath (Join-Path $cursor '.obsidian') -PathType Container) {
            throw "Semantic data directory must not be inside an Obsidian vault: $Path"
        }
        $parent = Split-Path -Parent $cursor
        if (-not $parent -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
}

$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
[void](Assert-NoReparseTraversal -Path $projectRoot -Label 'semantic project root')
$DataDir = [System.IO.Path]::GetFullPath($DataDir)
[void](Assert-NoReparseTraversal -Path $DataDir -Label 'semantic data directory')
Assert-NotInsideObsidianVault -Path $DataDir

$venvPython = if ($env:SECOND_BRAIN_PYTHON) {
    [System.IO.Path]::GetFullPath($env:SECOND_BRAIN_PYTHON)
} else {
    Join-Path $DataDir 'runtime\.venv\Scripts\python.exe'
}
[void](Assert-NoReparseTraversal -Path $venvPython -Label 'semantic Python runtime')
if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    throw 'Semantic Python runtime is missing. Run scripts/setup-semantic.ps1 -AcceptNetwork first.'
}

$downloader = Join-Path $projectRoot 'src\download_semantic_model.py'
if (-not (Test-Path -LiteralPath $downloader -PathType Leaf)) {
    throw "Semantic model downloader is missing: $downloader"
}

$modelCache = Join-Path $DataDir 'models\fastembed'
[void](Assert-NoReparseTraversal -Path $modelCache -Label 'semantic model cache')

$hadHfOffline = Test-Path Env:HF_HUB_OFFLINE
$previousHfOffline = $env:HF_HUB_OFFLINE
$hadTransformersOffline = Test-Path Env:TRANSFORMERS_OFFLINE
$previousTransformersOffline = $env:TRANSFORMERS_OFFLINE
$hadTokenizersParallelism = Test-Path Env:TOKENIZERS_PARALLELISM
$previousTokenizersParallelism = $env:TOKENIZERS_PARALLELISM

try {
    Remove-Item Env:HF_HUB_OFFLINE -ErrorAction SilentlyContinue
    Remove-Item Env:TRANSFORMERS_OFFLINE -ErrorAction SilentlyContinue
    $env:TOKENIZERS_PARALLELISM = 'false'

    & $venvPython -X utf8 $downloader --cache-dir $modelCache --accept-model-download
    if ($LASTEXITCODE -ne 0) { throw "Semantic model downloader failed with exit code $LASTEXITCODE" }
} finally {
    if ($hadHfOffline) { $env:HF_HUB_OFFLINE = $previousHfOffline }
    else { Remove-Item Env:HF_HUB_OFFLINE -ErrorAction SilentlyContinue }
    if ($hadTransformersOffline) { $env:TRANSFORMERS_OFFLINE = $previousTransformersOffline }
    else { Remove-Item Env:TRANSFORMERS_OFFLINE -ErrorAction SilentlyContinue }
    if ($hadTokenizersParallelism) { $env:TOKENIZERS_PARALLELISM = $previousTokenizersParallelism }
    else { Remove-Item Env:TOKENIZERS_PARALLELISM -ErrorAction SilentlyContinue }
}
