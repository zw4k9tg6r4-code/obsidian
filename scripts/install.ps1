[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$VaultPath,
    [ValidateSet('codex', 'antigravity', 'both')]
    [string]$Target = 'both',
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexSecondBrain'),
    [string]$CodexSkillRoot,
    [string]$AntigravitySkillRoot,
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
    $remainder = $full.Substring($root.Length)
    $segments = @($remainder.Split(
        [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar),
        [System.StringSplitOptions]::RemoveEmptyEntries
    ))
    foreach ($segment in $segments) {
        $cursor = Join-Path $cursor $segment
        try {
            $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        }
        catch [System.Management.Automation.ItemNotFoundException] {
            break
        }
        catch {
            throw "Cannot safely inspect ${Label} for reparse traversal: $cursor"
        }
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Reparse points and junctions are not allowed in ${Label}: $cursor"
        }
    }
    return $full
}

function Test-IsInside([string]$Root, [string]$Candidate) {
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $candidateFull = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\', '/')
    return $candidateFull.Equals($rootFull, [System.StringComparison]::OrdinalIgnoreCase) -or
        $candidateFull.StartsWith($rootFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Move-DirectoryExact([string]$Source, [string]$Destination) {
    [void](Assert-NoReparseTraversal -Path $Source -Label 'move source')
    [void](Assert-NoReparseTraversal -Path $Destination -Label 'move destination')
    [System.IO.Directory]::Move(
        [System.IO.Path]::GetFullPath($Source),
        [System.IO.Path]::GetFullPath($Destination)
    )
}

$projectRootInput = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
[void](Assert-NoReparseTraversal -Path $projectRootInput -Label 'installer project root')
$projectRoot = (Resolve-Path -LiteralPath $projectRootInput -ErrorAction Stop).Path
[void](Assert-NoReparseTraversal -Path $projectRoot -Label 'installer project root')

$vaultInput = [System.IO.Path]::GetFullPath($VaultPath)
[void](Assert-NoReparseTraversal -Path $vaultInput -Label 'Vault path')
$vault = (Resolve-Path -LiteralPath $vaultInput -ErrorAction Stop).Path
[void](Assert-NoReparseTraversal -Path $vault -Label 'Vault path')

$installRootFull = [System.IO.Path]::GetFullPath($InstallRoot)
[void](Assert-NoReparseTraversal -Path $installRootFull -Label 'install root')
$userProfilePath = [Environment]::GetFolderPath('UserProfile')
if (-not $CodexSkillRoot) { $CodexSkillRoot = Join-Path $userProfilePath '.codex\skills' }
if (-not $AntigravitySkillRoot) { $AntigravitySkillRoot = Join-Path $userProfilePath '.gemini\config\skills' }
if ($Target -in @('codex', 'both')) {
    $CodexSkillRoot = [System.IO.Path]::GetFullPath($CodexSkillRoot)
    [void](Assert-NoReparseTraversal -Path $CodexSkillRoot -Label 'Codex Skill root')
}
if ($Target -in @('antigravity', 'both')) {
    $AntigravitySkillRoot = [System.IO.Path]::GetFullPath($AntigravitySkillRoot)
    [void](Assert-NoReparseTraversal -Path $AntigravitySkillRoot -Label 'Antigravity Skill root')
}

if (-not (Test-Path -LiteralPath (Join-Path $vault 'AGENTS.md'))) {
    throw "Vault root AGENTS.md is missing: $vault"
}
if ((Test-IsInside $vault $installRootFull) -or (Test-IsInside $installRootFull $vault)) {
    throw 'Install root and vault must not contain one another.'
}
if (-not $AcceptNetwork) {
    throw 'Installation runs a pinned npm clean install. Re-run with -AcceptNetwork after reviewing package-lock.json.'
}

$node = Get-Command node -ErrorAction Stop
$nodeMajor = [int]((& $node.Source --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw 'Node.js 22 or newer is required.' }
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { $npm = Get-Command npm -ErrorAction Stop }

[void](Assert-NoReparseTraversal -Path $installRootFull -Label 'install root before creation')
New-Item -ItemType Directory -Force -Path $installRootFull | Out-Null
[void](Assert-NoReparseTraversal -Path $installRootFull -Label 'created install root')
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$installId = [guid]::NewGuid().ToString('N')
$backupRoot = Join-Path $installRootFull "backups\$timestamp-$installId"
$stageRoot = Join-Path $installRootFull "install-stage-$installId"
$stageApp = Join-Path $stageRoot 'app'
[void](Assert-NoReparseTraversal -Path $backupRoot -Label 'installer backup root')
[void](Assert-NoReparseTraversal -Path $stageRoot -Label 'installer staging root')
New-Item -ItemType Directory -Force -Path $backupRoot, $stageApp | Out-Null
[void](Assert-NoReparseTraversal -Path $backupRoot -Label 'created installer backup root')
[void](Assert-NoReparseTraversal -Path $stageApp -Label 'created installer staging app')

$allowedDirectories = @('src', 'scripts', 'skill', 'docs', 'schemas', 'test')
$allowedFiles = @(
    'package.json', 'package-lock.json', 'requirements-semantic.txt',
    'README.md', 'SECURITY.md', 'PRIVACY.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE'
)
foreach ($name in $allowedDirectories) {
    $source = Join-Path $projectRoot $name
    [void](Assert-NoReparseTraversal -Path $source -Label "allowlisted installer directory '$name'")
    if (Test-Path -LiteralPath $source) {
        foreach ($item in Get-ChildItem -LiteralPath $source -Recurse -Force) {
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Reparse points and junctions are not allowed in allowlisted installer directory '$name': $($item.FullName)"
            }
        }
        Copy-Item -LiteralPath $source -Destination $stageApp -Recurse
    }
}
foreach ($name in $allowedFiles) {
    $source = Join-Path $projectRoot $name
    [void](Assert-NoReparseTraversal -Path $source -Label "allowlisted installer root file '$name'")
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $stageApp }
}

$previousPostinstall = $env:NODE_LLAMA_CPP_POSTINSTALL
try {
    $env:NODE_LLAMA_CPP_POSTINSTALL = 'skip'
    Push-Location $stageApp
    try {
        $nativeErrorPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $npmOutput = & $npm.Source ci 2>&1
        $npmExitCode = $LASTEXITCODE
        $ErrorActionPreference = $nativeErrorPreference
        if ($npmExitCode -ne 0) { throw "npm ci failed with exit code $npmExitCode" }
        Write-Verbose ($npmOutput -join [Environment]::NewLine)
        $ErrorActionPreference = 'Continue'
        $checkOutput = & $node.Source 'scripts/check.mjs' 2>&1
        $checkExitCode = $LASTEXITCODE
        $ErrorActionPreference = $nativeErrorPreference
        if ($checkExitCode -ne 0) { throw "static verification failed with exit code $checkExitCode" }
        Write-Verbose ($checkOutput -join [Environment]::NewLine)
        $ErrorActionPreference = 'Continue'
        $testOutput = & $npm.Source test 2>&1
        $testExitCode = $LASTEXITCODE
        $ErrorActionPreference = $nativeErrorPreference
        if ($testExitCode -ne 0) { throw "installed runtime tests failed with exit code $testExitCode" }
        Write-Verbose ($testOutput -join [Environment]::NewLine)
        $binDir = Join-Path $stageApp 'bin'
        New-Item -ItemType Directory -Force -Path $binDir | Out-Null
        "@echo off`r`nif not defined SECOND_BRAIN_DATA_DIR set `"SECOND_BRAIN_DATA_DIR=%~dp0..\..`"`r`nnode `"%~dp0..\src\cli.js`" %*`r`n" | Set-Content -LiteralPath (Join-Path $binDir 'sbrain.cmd') -Encoding ASCII
        "@echo off`r`nif not defined SECOND_BRAIN_DATA_DIR set `"SECOND_BRAIN_DATA_DIR=%~dp0..\..`"`r`nnode `"%~dp0..\src\mcp-server.js`" %*`r`n" | Set-Content -LiteralPath (Join-Path $binDir 'sbrain-mcp.cmd') -Encoding ASCII
    } finally {
        Pop-Location
    }
} finally {
    $env:NODE_LLAMA_CPP_POSTINSTALL = $previousPostinstall
}

$appTarget = Join-Path $installRootFull 'app'
$appBackup = Join-Path $backupRoot 'app'
$skillBackups = @()
$installedTargets = @()
$configDir = Join-Path $installRootFull 'config'
$configPath = Join-Path $configDir 'config.json'
$configBackup = Join-Path $backupRoot 'config.json'
[void](Assert-NoReparseTraversal -Path $appTarget -Label 'installed app target')
[void](Assert-NoReparseTraversal -Path $configDir -Label 'installer config directory')
[void](Assert-NoReparseTraversal -Path $configPath -Label 'installer config file')
$hadConfig = Test-Path -LiteralPath $configPath
$appWasPresent = Test-Path -LiteralPath $appTarget

try {
    if ($appWasPresent) { Move-DirectoryExact $appTarget $appBackup }
    Move-DirectoryExact $stageApp $appTarget

    $targetRoots = @()
    if ($Target -in @('codex', 'both')) { $targetRoots += @{ Name = 'codex'; Root = [System.IO.Path]::GetFullPath($CodexSkillRoot) } }
    if ($Target -in @('antigravity', 'both')) { $targetRoots += @{ Name = 'antigravity'; Root = [System.IO.Path]::GetFullPath($AntigravitySkillRoot) } }
    foreach ($item in $targetRoots) {
        [void](Assert-NoReparseTraversal -Path $item.Root -Label "$($item.Name) Skill root before creation")
        New-Item -ItemType Directory -Force -Path $item.Root | Out-Null
        [void](Assert-NoReparseTraversal -Path $item.Root -Label "created $($item.Name) Skill root")
        $skillTarget = Join-Path $item.Root 'obsidian-second-brain'
        $skillBackup = Join-Path $backupRoot ("skill-" + $item.Name)
        [void](Assert-NoReparseTraversal -Path $skillTarget -Label "$($item.Name) Skill target")
        $hadPrevious = Test-Path -LiteralPath $skillTarget
        if ($hadPrevious) { Move-DirectoryExact $skillTarget $skillBackup }
        $skillBackups += @{ name = $item.Name; target = $skillTarget; backup = $skillBackup; hadPrevious = $hadPrevious }
        $skillStage = Join-Path $item.Root (".obsidian-second-brain-stage-" + $installId)
        [void](Assert-NoReparseTraversal -Path $skillStage -Label "$($item.Name) Skill staging target")
        Copy-Item -LiteralPath (Join-Path $appTarget 'skill\obsidian-second-brain') -Destination $skillStage -Recurse
        Move-DirectoryExact $skillStage $skillTarget
        $installedTargets += $skillTarget
    }

    [void](Assert-NoReparseTraversal -Path $configDir -Label 'installer config directory before creation')
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    [void](Assert-NoReparseTraversal -Path $configDir -Label 'created installer config directory')
    [void](Assert-NoReparseTraversal -Path $configPath -Label 'installer config file before write')
    if ($hadConfig) { Copy-Item -LiteralPath $configPath -Destination $configBackup }
    $configTemp = Join-Path $configDir ("config.$installId.tmp")
    @{ schemaVersion = 1; vault = $vault } | ConvertTo-Json | Set-Content -LiteralPath $configTemp -Encoding UTF8
    Move-Item -LiteralPath $configTemp -Destination $configPath -Force

    $manifest = @{
        schemaVersion = 1
        installId = $installId
        installedAt = (Get-Date).ToUniversalTime().ToString('o')
        installRoot = $installRootFull
        appTarget = $appTarget
        appBackup = $appBackup
        appWasPresent = $appWasPresent
        configPath = $configPath
        configBackup = $configBackup
        configWasPresent = $hadConfig
        skills = $skillBackups
    }
    $manifestPath = Join-Path $backupRoot 'install-manifest.json'
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
} catch {
    foreach ($entry in $skillBackups) {
        if (Test-Path -LiteralPath $entry.target) {
            Move-DirectoryExact $entry.target (Join-Path $backupRoot ("failed-" + $entry.name))
        }
        if ($entry.hadPrevious -and (Test-Path -LiteralPath $entry.backup)) {
            Move-DirectoryExact $entry.backup $entry.target
        }
    }
    if (Test-Path -LiteralPath $appTarget) { Move-DirectoryExact $appTarget (Join-Path $backupRoot 'failed-app') }
    if ($appWasPresent -and (Test-Path -LiteralPath $appBackup)) { Move-DirectoryExact $appBackup $appTarget }
    if (Test-Path -LiteralPath $configPath) { Move-Item -LiteralPath $configPath -Destination (Join-Path $backupRoot 'failed-config.json') -Force }
    if ($hadConfig -and (Test-Path -LiteralPath $configBackup)) { Copy-Item -LiteralPath $configBackup -Destination $configPath }
    throw
}

[pscustomobject]@{
    ok = $true
    app = $appTarget
    targets = $installedTargets
    config = $configPath
    manifest = $manifestPath
    vaultModified = $false
    indexCreated = $false
    modelDownloaded = $false
} | ConvertTo-Json -Depth 4
