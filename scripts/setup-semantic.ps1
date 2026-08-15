[CmdletBinding()]
param(
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexSecondBrain'),
    [switch]$AcceptNetwork
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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
if (-not $AcceptNetwork) {
    throw 'Semantic setup downloads pinned Python packages. Re-run with -AcceptNetwork after reviewing requirements-semantic.txt.'
}

$requirements = Join-Path $projectRoot 'requirements-semantic.txt'
$runtimeDir = Join-Path $DataDir 'runtime'
$venvDir = Join-Path $runtimeDir '.venv'
$venvPython = Join-Path $venvDir 'Scripts\python.exe'
[void](Assert-NoReparseTraversal -Path $runtimeDir -Label 'semantic runtime directory')
[void](Assert-NoReparseTraversal -Path $venvDir -Label 'semantic virtual environment')
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
[void](Assert-NoReparseTraversal -Path $runtimeDir -Label 'created semantic runtime directory')

$uv = Get-Command uv -ErrorAction SilentlyContinue
if ($uv) {
    if (-not (Test-Path -LiteralPath $venvPython)) {
        & $uv.Source venv --python 3.12 $venvDir
        if ($LASTEXITCODE -ne 0) { throw "uv venv failed with exit code $LASTEXITCODE" }
    }
    & $uv.Source pip install --python $venvPython --requirement $requirements
    if ($LASTEXITCODE -ne 0) { throw "uv pip install failed with exit code $LASTEXITCODE" }
} else {
    $python = Get-Command python -ErrorAction Stop
    if (-not (Test-Path -LiteralPath $venvPython)) {
        & $python.Source -m venv $venvDir
        if ($LASTEXITCODE -ne 0) { throw "python -m venv failed with exit code $LASTEXITCODE" }
    }
    & $venvPython -m pip install --requirement $requirements
    if ($LASTEXITCODE -ne 0) { throw "pip install failed with exit code $LASTEXITCODE" }
}

& $venvPython -c "import fastembed; print('FastEmbed runtime ready')"
if ($LASTEXITCODE -ne 0) { throw 'FastEmbed import check failed.' }
Write-Output "Semantic runtime installed outside the vault: $venvDir"
Write-Output 'The 90 MB BAAI/bge-small-zh-v1.5 model is downloaded only when semantic indexing is explicitly requested.'
