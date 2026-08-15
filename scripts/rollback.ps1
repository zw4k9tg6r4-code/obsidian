[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexSecondBrain'),
    [string]$ManifestPath,
    [string]$CodexSkillRoot,
    [string]$AntigravitySkillRoot
)

$ErrorActionPreference = 'Stop'
$installRootFull = [System.IO.Path]::GetFullPath($InstallRoot)
$backupsRoot = Join-Path $installRootFull 'backups'
$userProfilePath = [Environment]::GetFolderPath('UserProfile')
if (-not $CodexSkillRoot) { $CodexSkillRoot = Join-Path $userProfilePath '.codex\skills' }
if (-not $AntigravitySkillRoot) { $AntigravitySkillRoot = Join-Path $userProfilePath '.gemini\config\skills' }
if (-not $ManifestPath) {
    $latest = Get-ChildItem -LiteralPath $backupsRoot -Filter 'install-manifest.json' -Recurse -File |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latest) { throw 'No install manifest was found.' }
    $ManifestPath = $latest.FullName
}
$manifestFull = (Resolve-Path -LiteralPath $ManifestPath).Path

function Test-IsInside([string]$Root, [string]$Candidate) {
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $candidateFull = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\', '/')
    return $candidateFull.Equals($rootFull, [System.StringComparison]::OrdinalIgnoreCase) -or
        $candidateFull.StartsWith($rootFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Move-DirectoryExact([string]$Source, [string]$Destination) {
    [System.IO.Directory]::Move(
        [System.IO.Path]::GetFullPath($Source),
        [System.IO.Path]::GetFullPath($Destination)
    )
}

if (-not (Test-IsInside $backupsRoot $manifestFull)) { throw 'Manifest is outside the install backup directory.' }
$manifest = Get-Content -LiteralPath $manifestFull -Encoding UTF8 -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.installRoot -ne $installRootFull) { throw 'Install manifest is incompatible.' }

$rollbackId = [guid]::NewGuid().ToString('N')
$quarantine = Join-Path $backupsRoot ("rollback-$rollbackId")
New-Item -ItemType Directory -Force -Path $quarantine | Out-Null

foreach ($entry in $manifest.skills) {
    $target = [System.IO.Path]::GetFullPath([string]$entry.target)
    $backup = [System.IO.Path]::GetFullPath([string]$entry.backup)
    $expectedRoot = if ($entry.name -eq 'codex') {
        [System.IO.Path]::GetFullPath($CodexSkillRoot)
    } elseif ($entry.name -eq 'antigravity') {
        [System.IO.Path]::GetFullPath($AntigravitySkillRoot)
    } else {
        throw 'Unknown skill target type in manifest.'
    }
    $expectedTarget = [System.IO.Path]::GetFullPath((Join-Path $expectedRoot 'obsidian-second-brain'))
    if (-not $target.Equals($expectedTarget, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid skill target.' }
    if (-not (Test-IsInside $backupsRoot $backup)) { throw 'Invalid skill backup.' }
    if (Test-Path -LiteralPath $target) {
        Move-DirectoryExact $target (Join-Path $quarantine ("current-skill-" + $entry.name))
    }
    if ($entry.hadPrevious -and (Test-Path -LiteralPath $backup)) {
        Move-DirectoryExact $backup $target
    }
}

$appTarget = [System.IO.Path]::GetFullPath([string]$manifest.appTarget)
$appBackup = [System.IO.Path]::GetFullPath([string]$manifest.appBackup)
if (-not (Test-IsInside $installRootFull $appTarget) -or -not (Test-IsInside $backupsRoot $appBackup)) { throw 'Invalid app paths.' }
if (Test-Path -LiteralPath $appTarget) { Move-DirectoryExact $appTarget (Join-Path $quarantine 'current-app') }
if ($manifest.appWasPresent -and (Test-Path -LiteralPath $appBackup)) { Move-DirectoryExact $appBackup $appTarget }

$configPath = [System.IO.Path]::GetFullPath([string]$manifest.configPath)
$configBackup = [System.IO.Path]::GetFullPath([string]$manifest.configBackup)
if (-not (Test-IsInside $installRootFull $configPath) -or -not (Test-IsInside $backupsRoot $configBackup)) { throw 'Invalid config paths.' }
if (Test-Path -LiteralPath $configPath) { Move-Item -LiteralPath $configPath -Destination (Join-Path $quarantine 'current-config.json') }
if ($manifest.configWasPresent -and (Test-Path -LiteralPath $configBackup)) {
    Copy-Item -LiteralPath $configBackup -Destination $configPath
}

[pscustomobject]@{
    ok = $true
    restoredManifest = $manifestFull
    quarantine = $quarantine
    vaultModified = $false
    localIndexPreserved = $true
} | ConvertTo-Json -Depth 3
