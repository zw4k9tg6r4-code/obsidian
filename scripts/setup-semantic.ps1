[CmdletBinding()]
param(
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexSecondBrain'),
    [switch]$AcceptNetwork,
    [switch]$ProbeOnly
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
if (-not $AcceptNetwork -and -not $ProbeOnly) {
    throw 'Semantic setup downloads pinned Python packages. Re-run with -AcceptNetwork after reviewing requirements-semantic.txt.'
}

$requirements = Join-Path $projectRoot 'requirements-semantic.txt'
$runtimeDir = Join-Path $DataDir 'runtime'
$venvDir = Join-Path $runtimeDir '.venv'
$venvPython = Join-Path $venvDir 'Scripts\python.exe'
[void](Assert-NoReparseTraversal -Path $runtimeDir -Label 'semantic runtime directory')
[void](Assert-NoReparseTraversal -Path $venvDir -Label 'semantic virtual environment')

function Find-GenuinePythonRuntime {
    $uv = Get-Command uv -ErrorAction SilentlyContinue
    if ($uv) {
        try {
            $uvVer = & $uv.Source --version 2>&1
            if ($LASTEXITCODE -eq 0) {
                return @{ Engine = 'uv'; Executable = $uv.Source }
            }
        } catch {}
    }

    $candidates = @()
    $pyLauncher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($pyLauncher) {
        $candidates += @{ Cmd = $pyLauncher.Source; Args = @('-3.12') }
        $candidates += @{ Cmd = $pyLauncher.Source; Args = @('-3.11') }
        $candidates += @{ Cmd = $pyLauncher.Source; Args = @('-3.10') }
        $candidates += @{ Cmd = $pyLauncher.Source; Args = @('-3') }
    }
    $sysPython = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($sysPython) { $candidates += @{ Cmd = $sysPython.Source; Args = @() } }

    foreach ($cand in $candidates) {
        try {
            # Use --version instead of inline Python. Windows PowerShell 5.1 can
            # strip nested quotes from native -c arguments and corrupt probes.
            $callArgs = @() + $cand.Args + @('--version')
            $out = @(& $cand.Cmd @callArgs 2>&1)
            if ($LASTEXITCODE -eq 0 -and $out.Count -gt 0) {
                $versionText = (@($out | ForEach-Object { [string]$_ }) -join ' ').Trim()
                $match = [regex]::Match($versionText, 'Python\s+(\d+)\.(\d+)')
                if ($match.Success) {
                    $major = [int]$match.Groups[1].Value
                    $minor = [int]$match.Groups[2].Value
                }
                if ($match.Success -and $major -eq 3 -and $minor -ge 10 -and $minor -le 12) {
                    return @{
                        Engine = 'python'
                        Executable = $cand.Cmd
                        BaseArgs = $cand.Args
                    }
                }
            }
        } catch {}
    }

    throw 'No compatible Python (3.10+) or uv runtime found. Windows Store alias was rejected. Please install standard Python 3.10-3.12.'
}

$runtime = Find-GenuinePythonRuntime
if ($ProbeOnly) {
    [ordered]@{
        ok = $true
        engine = $runtime.Engine
    } | ConvertTo-Json
    return
}

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
[void](Assert-NoReparseTraversal -Path $runtimeDir -Label 'created semantic runtime directory')

if ($runtime.Engine -eq 'uv') {
    if (-not (Test-Path -LiteralPath $venvPython)) {
        & $runtime.Executable venv --python 3.12 $venvDir
        if ($LASTEXITCODE -ne 0) { throw "uv venv failed with exit code $LASTEXITCODE" }
    }
    & $runtime.Executable pip install --python $venvPython --requirement $requirements
    if ($LASTEXITCODE -ne 0) { throw "uv pip install failed with exit code $LASTEXITCODE" }
} else {
    if (-not (Test-Path -LiteralPath $venvPython)) {
        $venvArgs = @() + $runtime.BaseArgs + @('-m', 'venv', $venvDir)
        & $runtime.Executable @venvArgs
        if ($LASTEXITCODE -ne 0) { throw "python -m venv failed with exit code $LASTEXITCODE" }
    }
    & $venvPython -m pip install --requirement $requirements
    if ($LASTEXITCODE -ne 0) { throw "pip install failed with exit code $LASTEXITCODE" }
}

& $venvPython -c "import fastembed; print('FastEmbed runtime ready')"
if ($LASTEXITCODE -ne 0) { throw 'FastEmbed import check failed.' }
Write-Output "Semantic runtime installed outside the vault: $venvDir"
Write-Output 'The 90 MB BAAI/bge-small-zh-v1.5 model is downloaded only when semantic indexing is explicitly requested.'
