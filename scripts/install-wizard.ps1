[CmdletBinding()]
param(
    [string]$VaultPath,
    [ValidateSet('codex', 'antigravity', 'both')]
    [string]$Target = 'codex',
    [ValidateSet('none', 'lexical', 'semantic')]
    [string]$IndexMode = 'lexical',
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexSecondBrain'),
    [string]$CodexSkillRoot,
    [string]$AntigravitySkillRoot,
    [switch]$AcceptNetwork,
    [switch]$AcceptModelDownload,
    [switch]$NonInteractive,
    [switch]$PlanOnly
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

function Get-ExtendedPath([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    if ($full.StartsWith('\\?\')) { return $full }
    if ($full.StartsWith('\\')) { return '\\?\UNC\' + $full.Substring(2) }
    return '\\?\' + $full
}

function Get-FileSha256([string]$Path) {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    try {
        return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $stream.Dispose()
        $algorithm.Dispose()
    }
}

function Test-IsInside {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Candidate
    )

    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $candidateFull = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\', '/')
    return $candidateFull.Equals($rootFull, [System.StringComparison]::OrdinalIgnoreCase) -or
        $candidateFull.StartsWith(
            $rootFull + [System.IO.Path]::DirectorySeparatorChar,
            [System.StringComparison]::OrdinalIgnoreCase
        )
}

function Get-VaultMarkdownFingerprint {
    param([Parameter(Mandatory = $true)][string]$Root)

    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $enumerationRoot = Get-ExtendedPath $rootFull
    $prefix = $enumerationRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $entries = New-Object System.Collections.Generic.List[string]
    $totalBytes = [int64]0
    $files = New-Object System.Collections.Generic.List[object]
    foreach ($item in Get-ChildItem -LiteralPath $enumerationRoot -Recurse -Force -ErrorAction Stop) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Reparse points and junctions are not supported inside the Vault: $($item.Name)"
        }
        if (-not $item.PSIsContainer -and $item.Extension -ieq '.md') { $files.Add($item) }
    }
    $files = @($files | Sort-Object FullName)
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($prefix.Length).Replace('\', '/')
        $hash = Get-FileSha256 $file.FullName
        $totalBytes += [int64]$file.Length
        $entries.Add("$relative|$($file.Length)|$hash")
    }
    $payload = [System.Text.Encoding]::UTF8.GetBytes(($entries -join "`n"))
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = ([System.BitConverter]::ToString($sha.ComputeHash($payload))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
    return [pscustomobject]@{
        markdownFiles = $files.Count
        markdownBytes = $totalBytes
        sha256 = $digest
    }
}

function Select-VaultFolder {
    $dialog = $null
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = 'Select the Obsidian Vault whose root contains AGENTS.md'
        $dialog.ShowNewFolderButton = $false
        $result = $dialog.ShowDialog()
        if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
            return $dialog.SelectedPath
        }
        throw 'Installation was cancelled before selecting a Vault.'
    }
    catch {
        if (-not [Environment]::UserInteractive) {
            throw 'VaultPath is required because no interactive folder picker is available.'
        }
        $typed = Read-Host 'Enter the full path of the Obsidian Vault whose root contains AGENTS.md'
        if (-not $typed) { throw 'VaultPath is required.' }
        return $typed
    }
    finally {
        if ($null -ne $dialog) {
            $dialog.Dispose()
        }
    }
}

if ($env:OS -ne 'Windows_NT') {
    throw 'The one-click installer currently supports Windows only.'
}

$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
[void](Assert-NoReparseTraversal -Path $projectRoot -Label 'installer package root')
$installScript = Join-Path $PSScriptRoot 'install.ps1'
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'AGENTS.md') -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $projectRoot 'START-HERE.md') -PathType Leaf) -or
    -not (Test-Path -LiteralPath $installScript -PathType Leaf)) {
    throw 'The installer package is incomplete. Re-download the official release ZIP.'
}

$releaseManifest = Join-Path $projectRoot 'release-manifest.json'
if (Test-Path -LiteralPath $releaseManifest -PathType Leaf) {
    $scanScript = Join-Path $PSScriptRoot 'scan-release.ps1'
    $scanResult = & $scanScript -Path $projectRoot -AllowSyntheticFixtures
    if (-not $scanResult -or [string]$scanResult.status -ne 'ok') {
        throw 'Release integrity and privacy scan did not report success.'
    }
}

if (-not $VaultPath) {
    if ($NonInteractive) {
        throw 'VaultPath is required in non-interactive mode.'
    }
    $VaultPath = Select-VaultFolder
}

$vaultInput = [System.IO.Path]::GetFullPath($VaultPath)
[void](Assert-NoReparseTraversal -Path $vaultInput -Label 'Vault path')
$vault = (Resolve-Path -LiteralPath $vaultInput -ErrorAction Stop).Path
[void](Assert-NoReparseTraversal -Path $vault -Label 'Vault path')
if (-not (Test-Path -LiteralPath $vault -PathType Container)) {
    throw "VaultPath is not a directory: $vault"
}
if (-not (Test-Path -LiteralPath (Join-Path $vault 'AGENTS.md') -PathType Leaf)) {
    throw "Vault root AGENTS.md is missing: $vault"
}

$installRootFull = [System.IO.Path]::GetFullPath($InstallRoot)
[void](Assert-NoReparseTraversal -Path $installRootFull -Label 'install root')
if ((Test-IsInside -Root $vault -Candidate $projectRoot) -or
    (Test-IsInside -Root $projectRoot -Candidate $vault)) {
    throw 'The extracted installer package and Vault must not contain one another.'
}
if ((Test-IsInside -Root $projectRoot -Candidate $installRootFull) -or
    (Test-IsInside -Root $installRootFull -Candidate $projectRoot)) {
    throw 'The extracted installer package and InstallRoot must not contain one another.'
}
if ((Test-IsInside -Root $vault -Candidate $installRootFull) -or
    (Test-IsInside -Root $installRootFull -Candidate $vault)) {
    throw 'InstallRoot and Vault must not contain one another.'
}
if ($IndexMode -eq 'semantic' -and -not $AcceptModelDownload -and -not $PlanOnly) {
    throw 'Semantic mode may download Python packages and an embedding model. Re-run with -AcceptModelDownload after explicit user approval.'
}

$node = Get-Command node -ErrorAction Stop
$nodeMajor = [int]((& $node.Source --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw 'Node.js 22 or newer is required.' }

$plan = [ordered]@{
    ok = $true
    planOnly = [bool]$PlanOnly
    vault = $vault
    target = $Target
    indexMode = $IndexMode
    installRoot = $installRootFull
    networkRequired = $true
    modelDownloadRequired = ($IndexMode -eq 'semantic')
    vaultWrites = $false
    backgroundTasks = $false
}

if ($PlanOnly) {
    $plan | ConvertTo-Json -Depth 5
    exit 0
}

$networkApproved = [bool]$AcceptNetwork
if (-not $networkApproved -and $NonInteractive) {
    throw 'Installation downloads pinned dependencies. Re-run with -AcceptNetwork after reviewing package-lock.json.'
}
if (-not $networkApproved) {
    Write-Host ''
    Write-Host 'Ready to install with these settings:'
    Write-Host "  Vault: $vault"
    Write-Host "  Target: $Target"
    Write-Host "  Index: $IndexMode"
    Write-Host "  Local data: $installRootFull"
    Write-Host 'The installer will download pinned dependencies, will not modify Vault Markdown, and will not create background tasks.'
    $answer = Read-Host 'Continue? [y/N]'
    if ($answer -notmatch '^(?i)y(?:es)?$') { throw 'Installation was cancelled.' }
    $networkApproved = $true
}

$vaultBefore = Get-VaultMarkdownFingerprint -Root $vault

$installParameters = @{
    VaultPath = $vault
    Target = $Target
    InstallRoot = $installRootFull
    AcceptNetwork = $networkApproved
}
if ($CodexSkillRoot) { $installParameters.CodexSkillRoot = $CodexSkillRoot }
if ($AntigravitySkillRoot) { $installParameters.AntigravitySkillRoot = $AntigravitySkillRoot }

$installRaw = & $installScript @installParameters
$installResult = $installRaw | ConvertFrom-Json
if (-not [bool]$installResult.ok) { throw 'The base installer did not report success.' }

$appPath = [string]$installResult.app
$health = $null
try {
    if ($IndexMode -ne 'none') {
        if ($IndexMode -eq 'semantic') {
            $semanticSetupOutput = & (Join-Path $appPath 'scripts\setup-semantic.ps1') -DataDir $installRootFull -AcceptNetwork
            if ($LASTEXITCODE -ne 0) { throw "Semantic runtime setup failed with exit code $LASTEXITCODE" }
        }

        $indexParameters = @{
            VaultPath = $vault
            DataDir = $installRootFull
        }
        if ($IndexMode -eq 'semantic') {
            $indexParameters.Semantic = $true
            $indexParameters.AcceptModelDownload = $true
        }
        $indexOutput = & (Join-Path $appPath 'scripts\initialize-index.ps1') @indexParameters
        if ($LASTEXITCODE -ne 0) { throw "Index initialization failed with exit code $LASTEXITCODE" }

        $healthRaw = & (Join-Path $appPath 'scripts\doctor.ps1') -VaultPath $vault -DataDir $installRootFull -AppPath $appPath
        $health = $healthRaw | ConvertFrom-Json
        if (-not [bool]$health.indexed) { throw 'Health verification reports that no index is available.' }
    }
    $vaultAfter = Get-VaultMarkdownFingerprint -Root $vault
    if ($vaultBefore.markdownFiles -ne $vaultAfter.markdownFiles -or
        $vaultBefore.markdownBytes -ne $vaultAfter.markdownBytes -or
        $vaultBefore.sha256 -ne $vaultAfter.sha256) {
        throw 'Vault Markdown changed during installation, so zero-write integrity cannot be attested.'
    }
}
catch {
    throw "Installation was written but readiness verification failed. Roll back with manifest '$($installResult.manifest)'. $($_.Exception.Message)"
}

[ordered]@{
    ok = $true
    ready = ($IndexMode -ne 'none' -and $null -ne $health -and [bool]$health.indexed)
    planOnly = $false
    vault = $vault
    target = $Target
    indexMode = $IndexMode
    app = $appPath
    config = [string]$installResult.config
    manifest = [string]$installResult.manifest
    health = $health
    vaultFingerprint = $vaultAfter
    vaultModified = $false
    modelDownloadAuthorized = ($IndexMode -eq 'semantic' -and [bool]$AcceptModelDownload)
    backgroundTasks = $false
} | ConvertTo-Json -Depth 6
