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

function Get-ExtendedPath([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    if ($full.StartsWith('\\?\')) { return $full }
    if ($full.StartsWith('\\')) { return '\\?\UNC\' + $full.Substring(2) }
    return '\\?\' + $full
}

function Assert-SafeExistingTree {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Label = 'tree',
        [ValidateSet('Any', 'Directory', 'File')][string]$ExpectedType = 'Any'
    )

    $full = Assert-NoReparseTraversal -Path $Path -Label $Label
    if (-not (Test-Path -LiteralPath $full)) { return $false }
    $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if ($ExpectedType -eq 'Directory' -and -not $item.PSIsContainer) { throw "${Label} must be a directory: $full" }
    if ($ExpectedType -eq 'File' -and $item.PSIsContainer) { throw "${Label} must be a file: $full" }
    if ($item.PSIsContainer) {
        $enumerationRoot = Get-ExtendedPath $full
        foreach ($child in Get-ChildItem -LiteralPath $enumerationRoot -Recurse -Force -ErrorAction Stop) {
            if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Reparse points and junctions are not allowed in ${Label}: $($child.FullName)"
            }
        }
    }
    return $true
}

function Test-IsInside([string]$Root, [string]$Candidate) {
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $candidateFull = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\', '/')
    return $candidateFull.Equals($rootFull, [System.StringComparison]::OrdinalIgnoreCase) -or
        $candidateFull.StartsWith($rootFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoContainment([string]$Left, [string]$Right, [string]$Message) {
    if ((Test-IsInside $Left $Right) -or (Test-IsInside $Right $Left)) { throw $Message }
}

function Move-DirectoryExact([string]$Source, [string]$Destination) {
    [void](Assert-SafeExistingTree -Path $Source -Label 'move source' -ExpectedType Directory)
    [void](Assert-NoReparseTraversal -Path $Destination -Label 'move destination')
    if (Test-Path -LiteralPath $Destination) { throw "Move destination already exists: $Destination" }
    [System.IO.Directory]::Move(
        [System.IO.Path]::GetFullPath($Source),
        [System.IO.Path]::GetFullPath($Destination)
    )
}

function Move-FileExact([string]$Source, [string]$Destination) {
    [void](Assert-SafeExistingTree -Path $Source -Label 'move source' -ExpectedType File)
    [void](Assert-NoReparseTraversal -Path $Destination -Label 'move destination')
    if (Test-Path -LiteralPath $Destination) { throw "Move destination already exists: $Destination" }
    [System.IO.File]::Move(
        [System.IO.Path]::GetFullPath($Source),
        [System.IO.Path]::GetFullPath($Destination)
    )
}

function Get-FileSha256([string]$Path) {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::Open(
        [System.IO.Path]::GetFullPath($Path),
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    try {
        return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
        $stream.Dispose()
        $algorithm.Dispose()
    }
}

function Get-PathInventory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Label = 'backup'
    )

    $full = Assert-NoReparseTraversal -Path $Path -Label $Label
    if (-not (Test-Path -LiteralPath $full)) {
        return [ordered]@{ kind = 'absent'; directories = @(); files = @() }
    }

    [void](Assert-SafeExistingTree -Path $full -Label $Label)
    $rootItem = Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if (-not $rootItem.PSIsContainer) {
        return [ordered]@{
            kind = 'file'
            directories = @()
            files = @([ordered]@{
                path = $rootItem.Name
                length = [long]$rootItem.Length
                sha256 = Get-FileSha256 $full
            })
        }
    }

    $enumerationRoot = Get-ExtendedPath $full
    $prefix = $enumerationRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $directories = @()
    $files = @()
    foreach ($item in Get-ChildItem -LiteralPath $enumerationRoot -Recurse -Force -ErrorAction Stop) {
        $relative = $item.FullName.Substring($prefix.Length).Replace('\', '/')
        if ($item.PSIsContainer) {
            $directories += $relative
        } else {
            $files += [ordered]@{
                path = $relative
                length = [long]$item.Length
                sha256 = Get-FileSha256 $item.FullName
            }
        }
    }
    return [ordered]@{
        kind = 'directory'
        directories = @($directories | Sort-Object)
        files = @($files | Sort-Object { $_.path })
    }
}

$projectRootInput = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
[void](Assert-NoReparseTraversal -Path $projectRootInput -Label 'installer project root')
$projectRoot = (Resolve-Path -LiteralPath $projectRootInput -ErrorAction Stop).Path
[void](Assert-SafeExistingTree -Path $projectRoot -Label 'installer project root' -ExpectedType Directory)

$vaultInput = [System.IO.Path]::GetFullPath($VaultPath)
[void](Assert-NoReparseTraversal -Path $vaultInput -Label 'Vault path')
$vault = (Resolve-Path -LiteralPath $vaultInput -ErrorAction Stop).Path
[void](Assert-SafeExistingTree -Path $vault -Label 'Vault path' -ExpectedType Directory)

$installRootFull = [System.IO.Path]::GetFullPath($InstallRoot)
[void](Assert-NoReparseTraversal -Path $installRootFull -Label 'install root')
$userProfilePath = [Environment]::GetFolderPath('UserProfile')
if (-not $CodexSkillRoot) { $CodexSkillRoot = Join-Path $userProfilePath '.codex\skills' }
if (-not $AntigravitySkillRoot) { $AntigravitySkillRoot = Join-Path $userProfilePath '.gemini\config\skills' }

$targetRoots = @()
if ($Target -in @('codex', 'both')) {
    $CodexSkillRoot = [System.IO.Path]::GetFullPath($CodexSkillRoot)
    [void](Assert-NoReparseTraversal -Path $CodexSkillRoot -Label 'Codex Skill root')
    $targetRoots += [pscustomobject]@{ Name = 'codex'; Root = $CodexSkillRoot }
}
if ($Target -in @('antigravity', 'both')) {
    $AntigravitySkillRoot = [System.IO.Path]::GetFullPath($AntigravitySkillRoot)
    [void](Assert-NoReparseTraversal -Path $AntigravitySkillRoot -Label 'Antigravity Skill root')
    $targetRoots += [pscustomobject]@{ Name = 'antigravity'; Root = $AntigravitySkillRoot }
}

if (-not (Test-Path -LiteralPath (Join-Path $vault 'AGENTS.md') -PathType Leaf)) {
    throw "Vault root AGENTS.md is missing: $vault"
}
Assert-NoContainment $vault $projectRoot 'Installer project root and vault must not contain one another.'
Assert-NoContainment $projectRoot $installRootFull 'Installer project root and install root must not contain one another.'
Assert-NoContainment $vault $installRootFull 'Install root and vault must not contain one another.'
foreach ($item in $targetRoots) {
    Assert-NoContainment $vault $item.Root "$($item.Name) Skill root and vault must not contain one another."
    Assert-NoContainment $projectRoot (Join-Path $item.Root 'obsidian-second-brain') "Installer project root and $($item.Name) Skill target must not contain one another."
    Assert-NoContainment $installRootFull (Join-Path $item.Root 'obsidian-second-brain') "Install root and $($item.Name) Skill target must not contain one another."
}
for ($left = 0; $left -lt $targetRoots.Count; $left++) {
    for ($right = $left + 1; $right -lt $targetRoots.Count; $right++) {
        Assert-NoContainment (Join-Path $targetRoots[$left].Root 'obsidian-second-brain') (Join-Path $targetRoots[$right].Root 'obsidian-second-brain') 'Skill targets must be unique and must not contain one another.'
    }
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
[void](Assert-SafeExistingTree -Path $installRootFull -Label 'created install root' -ExpectedType Directory)
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$installId = [guid]::NewGuid().ToString('N')
$backupRoot = Join-Path $installRootFull "backups\$timestamp-$installId"
$stageRoot = Join-Path $installRootFull "install-stage-$installId"
$stageApp = Join-Path $stageRoot 'app'
$stageConfig = Join-Path $stageRoot 'config.json'
[void](Assert-NoReparseTraversal -Path $backupRoot -Label 'installer backup root')
[void](Assert-NoReparseTraversal -Path $stageRoot -Label 'installer staging root')
New-Item -ItemType Directory -Path $backupRoot, $stageApp | Out-Null
[void](Assert-SafeExistingTree -Path $backupRoot -Label 'created installer backup root' -ExpectedType Directory)
[void](Assert-SafeExistingTree -Path $stageApp -Label 'created installer staging app' -ExpectedType Directory)

$allowedDirectories = @('src', 'scripts', 'skill', 'docs', 'schemas', 'test')
$allowedFiles = @(
    'package.json', 'package-lock.json', 'requirements-semantic.txt',
    'README.md', 'SECURITY.md', 'PRIVACY.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE'
)
foreach ($name in $allowedDirectories) {
    $source = Join-Path $projectRoot $name
    [void](Assert-NoReparseTraversal -Path $source -Label "allowlisted installer directory '$name'")
    if (Test-Path -LiteralPath $source) {
        [void](Assert-SafeExistingTree -Path $source -Label "allowlisted installer directory '$name'" -ExpectedType Directory)
        Copy-Item -LiteralPath $source -Destination $stageApp -Recurse
    }
}
foreach ($name in $allowedFiles) {
    $source = Join-Path $projectRoot $name
    [void](Assert-NoReparseTraversal -Path $source -Label "allowlisted installer root file '$name'")
    if (Test-Path -LiteralPath $source) {
        [void](Assert-SafeExistingTree -Path $source -Label "allowlisted installer root file '$name'" -ExpectedType File)
        Copy-Item -LiteralPath $source -Destination $stageApp
    }
}

# Package-consumer entry tests require the release-root AGENTS/START/INSTALL files.
# They are validated before release, but are intentionally not copied into the installed app.
$installerEntryTest = Join-Path $stageApp 'test\installer-entry.test.js'
if (Test-Path -LiteralPath $installerEntryTest -PathType Leaf) {
    [void](Assert-NoReparseTraversal -Path $installerEntryTest -Label 'installer-only test exclusion')
    Remove-Item -LiteralPath $installerEntryTest -Force
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
        New-Item -ItemType Directory -Path $binDir | Out-Null
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
$configDir = Join-Path $installRootFull 'config'
$configPath = Join-Path $configDir 'config.json'
$configBackup = Join-Path $backupRoot 'config.json'
$skillPlans = @()

# Complete every target and backup check before the first move.
[void](Assert-SafeExistingTree -Path $stageApp -Label 'staged app' -ExpectedType Directory)
$appWasPresent = Assert-SafeExistingTree -Path $appTarget -Label 'installed app target' -ExpectedType Directory
[void](Assert-NoReparseTraversal -Path $appBackup -Label 'app backup')
if (Test-Path -LiteralPath $appBackup) { throw "App backup destination already exists: $appBackup" }
[void](Assert-NoReparseTraversal -Path $configDir -Label 'installer config directory')
$hadConfig = Assert-SafeExistingTree -Path $configPath -Label 'installer config file' -ExpectedType File
[void](Assert-NoReparseTraversal -Path $configBackup -Label 'config backup')
if (Test-Path -LiteralPath $configBackup) { throw "Config backup destination already exists: $configBackup" }

@{ schemaVersion = 1; vault = $vault } | ConvertTo-Json | Set-Content -LiteralPath $stageConfig -Encoding UTF8
[void](Assert-SafeExistingTree -Path $stageConfig -Label 'staged config' -ExpectedType File)

foreach ($item in $targetRoots) {
    [void](Assert-NoReparseTraversal -Path $item.Root -Label "$($item.Name) Skill root before creation")
    if (-not (Test-Path -LiteralPath $item.Root)) { New-Item -ItemType Directory -Path $item.Root | Out-Null }
    [void](Assert-SafeExistingTree -Path $item.Root -Label "created $($item.Name) Skill root" -ExpectedType Directory)
    $skillTarget = Join-Path $item.Root 'obsidian-second-brain'
    $skillBackup = Join-Path $backupRoot ("skill-" + $item.Name)
    $skillStage = Join-Path $item.Root (".obsidian-second-brain-stage-" + $installId)
    $hadPrevious = Assert-SafeExistingTree -Path $skillTarget -Label "$($item.Name) Skill target" -ExpectedType Directory
    [void](Assert-NoReparseTraversal -Path $skillBackup -Label "$($item.Name) Skill backup")
    if (Test-Path -LiteralPath $skillBackup) { throw "$($item.Name) Skill backup destination already exists: $skillBackup" }
    [void](Assert-NoReparseTraversal -Path $skillStage -Label "$($item.Name) Skill staging target")
    if (Test-Path -LiteralPath $skillStage) { throw "$($item.Name) Skill staging destination already exists: $skillStage" }
    Copy-Item -LiteralPath (Join-Path $stageApp 'skill\obsidian-second-brain') -Destination $skillStage -Recurse
    [void](Assert-SafeExistingTree -Path $skillStage -Label "$($item.Name) staged Skill" -ExpectedType Directory)
    $skillPlans += [pscustomobject]@{
        name = $item.Name
        target = $skillTarget
        backup = $skillBackup
        stage = $skillStage
        hadPrevious = [bool]$hadPrevious
        backupMoved = $false
        installed = $false
    }
}

# Recheck all path ancestors immediately before entering the mutation transaction.
[void](Assert-SafeExistingTree -Path $backupRoot -Label 'installer backup root' -ExpectedType Directory)
[void](Assert-SafeExistingTree -Path $stageApp -Label 'staged app' -ExpectedType Directory)
[void](Assert-SafeExistingTree -Path $stageConfig -Label 'staged config' -ExpectedType File)
[void](Assert-NoReparseTraversal -Path $appTarget -Label 'installed app target')
[void](Assert-NoReparseTraversal -Path $appBackup -Label 'app backup')
[void](Assert-NoReparseTraversal -Path $configPath -Label 'installer config file')
[void](Assert-NoReparseTraversal -Path $configBackup -Label 'config backup')
foreach ($plan in $skillPlans) {
    [void](Assert-NoReparseTraversal -Path $plan.target -Label "$($plan.name) Skill target")
    [void](Assert-NoReparseTraversal -Path $plan.backup -Label "$($plan.name) Skill backup")
    [void](Assert-SafeExistingTree -Path $plan.stage -Label "$($plan.name) staged Skill" -ExpectedType Directory)
}

$appBackupMoved = $false
$appInstalled = $false
$configBackupMoved = $false
$configInstalled = $false
$manifestPath = Join-Path $backupRoot 'install-manifest.json'
try {
    if ($appWasPresent) {
        Move-DirectoryExact $appTarget $appBackup
        $appBackupMoved = $true
    }
    Move-DirectoryExact $stageApp $appTarget
    $appInstalled = $true

    foreach ($plan in $skillPlans) {
        if ($plan.hadPrevious) {
            Move-DirectoryExact $plan.target $plan.backup
            $plan.backupMoved = $true
        }
        Move-DirectoryExact $plan.stage $plan.target
        $plan.installed = $true
    }

    if (-not (Test-Path -LiteralPath $configDir)) { New-Item -ItemType Directory -Path $configDir | Out-Null }
    [void](Assert-SafeExistingTree -Path $configDir -Label 'created installer config directory' -ExpectedType Directory)
    if ($hadConfig) {
        Move-FileExact $configPath $configBackup
        $configBackupMoved = $true
    }
    Move-FileExact $stageConfig $configPath
    $configInstalled = $true

    $manifestSkills = @()
    foreach ($plan in $skillPlans) {
        $manifestSkills += [ordered]@{
            name = $plan.name
            target = [System.IO.Path]::GetFullPath($plan.target)
            backup = [System.IO.Path]::GetFullPath($plan.backup)
            hadPrevious = [bool]$plan.hadPrevious
            backupInventory = Get-PathInventory -Path $plan.backup -Label "$($plan.name) Skill backup"
        }
    }
    $manifest = [ordered]@{
        schemaVersion = 2
        installId = $installId
        installedAt = (Get-Date).ToUniversalTime().ToString('o')
        installRoot = $installRootFull
        backupRoot = $backupRoot
        appTarget = $appTarget
        appBackup = $appBackup
        appWasPresent = [bool]$appWasPresent
        appBackupInventory = Get-PathInventory -Path $appBackup -Label 'app backup'
        configPath = $configPath
        configBackup = $configBackup
        configWasPresent = [bool]$hadConfig
        configBackupInventory = Get-PathInventory -Path $configBackup -Label 'config backup'
        skills = $manifestSkills
    }
    [void](Assert-NoReparseTraversal -Path $manifestPath -Label 'install manifest')
    $manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    [void](Assert-SafeExistingTree -Path $manifestPath -Label 'install manifest' -ExpectedType File)
} catch {
    $installFailure = $_
    try {
        if ($configInstalled -and (Test-Path -LiteralPath $configPath)) {
            Move-FileExact $configPath (Join-Path $backupRoot 'failed-config.json')
            $configInstalled = $false
        }
        if ($configBackupMoved -and (Test-Path -LiteralPath $configBackup)) {
            Move-FileExact $configBackup $configPath
            $configBackupMoved = $false
        }
        for ($index = $skillPlans.Count - 1; $index -ge 0; $index--) {
            $plan = $skillPlans[$index]
            if ($plan.installed -and (Test-Path -LiteralPath $plan.target)) {
                Move-DirectoryExact $plan.target (Join-Path $backupRoot ("failed-" + $plan.name))
                $plan.installed = $false
            }
            if ($plan.backupMoved -and (Test-Path -LiteralPath $plan.backup)) {
                Move-DirectoryExact $plan.backup $plan.target
                $plan.backupMoved = $false
            }
        }
        if ($appInstalled -and (Test-Path -LiteralPath $appTarget)) {
            Move-DirectoryExact $appTarget (Join-Path $backupRoot 'failed-app')
            $appInstalled = $false
        }
        if ($appBackupMoved -and (Test-Path -LiteralPath $appBackup)) {
            Move-DirectoryExact $appBackup $appTarget
            $appBackupMoved = $false
        }
    } catch {
        throw "Installation failed and automatic recovery also failed. Original error: $($installFailure.Exception.Message). Recovery error: $($_.Exception.Message). Preserved recovery data: $backupRoot"
    }
    throw $installFailure
}

[pscustomobject]@{
    ok = $true
    app = $appTarget
    targets = @($skillPlans | ForEach-Object { $_.target })
    config = $configPath
    manifest = $manifestPath
    vaultModified = $false
    indexCreated = $false
    modelDownloaded = $false
} | ConvertTo-Json -Depth 4
