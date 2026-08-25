[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexSecondBrain'),
    [string]$ManifestPath,
    [string]$CodexSkillRoot,
    [string]$AntigravitySkillRoot
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

function Test-ExactPath([string]$Left, [string]$Right) {
    return [System.IO.Path]::GetFullPath($Left).Equals(
        [System.IO.Path]::GetFullPath($Right),
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Get-RequiredString([object]$Object, [string]$Name, [string]$Label) {
    $property = $Object.PSObject.Properties[$Name]
    if (-not $property -or $property.Value -isnot [string] -or [string]::IsNullOrWhiteSpace($property.Value)) {
        throw "${Label} must contain a non-empty string '$Name'."
    }
    return [string]$property.Value
}

function Get-RequiredBoolean([object]$Object, [string]$Name, [string]$Label) {
    $property = $Object.PSObject.Properties[$Name]
    if (-not $property -or $property.Value -isnot [bool]) { throw "${Label} must contain a Boolean '$Name'." }
    return [bool]$property.Value
}

function Move-DirectoryExact([string]$Source, [string]$Destination) {
    [void](Assert-SafeExistingTree -Path $Source -Label 'move source' -ExpectedType Directory)
    [void](Assert-NoReparseTraversal -Path $Destination -Label 'move destination')
    if (Test-Path -LiteralPath $Destination) { throw "Move destination already exists: $Destination" }
    $srcFull = [System.IO.Path]::GetFullPath($Source)
    $destFull = [System.IO.Path]::GetFullPath($Destination)
    $attempts = 0
    while ($true) {
        try {
            [System.IO.Directory]::Move($srcFull, $destFull)
            break
        }
        catch {
            $attempts++
            if ($attempts -ge 4) { throw $_ }
            Start-Sleep -Milliseconds ($attempts * 100)
        }
    }
}

function Move-FileExact([string]$Source, [string]$Destination) {
    [void](Assert-SafeExistingTree -Path $Source -Label 'move source' -ExpectedType File)
    [void](Assert-NoReparseTraversal -Path $Destination -Label 'move destination')
    if (Test-Path -LiteralPath $Destination) { throw "Move destination already exists: $Destination" }
    $srcFull = [System.IO.Path]::GetFullPath($Source)
    $destFull = [System.IO.Path]::GetFullPath($Destination)
    $attempts = 0
    while ($true) {
        try {
            [System.IO.File]::Move($srcFull, $destFull)
            break
        }
        catch {
            $attempts++
            if ($attempts -ge 4) { throw $_ }
            Start-Sleep -Milliseconds ($attempts * 100)
        }
    }
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

function Assert-SafeInventoryPath([string]$Path, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Path) -or [System.IO.Path]::IsPathRooted($Path) -or $Path.Contains('\')) {
        throw "${Label} contains an invalid relative path."
    }
    $segments = @($Path.Split('/', [System.StringSplitOptions]::None))
    if ($segments.Count -eq 0 -or $segments -contains '' -or $segments -contains '.' -or $segments -contains '..') {
        throw "${Label} contains an invalid relative path."
    }
}

function Assert-InventoryMatches([object]$Expected, [object]$Actual, [string]$Label) {
    if (-not $Expected) { throw "${Label} inventory is missing." }
    $expectedKind = Get-RequiredString $Expected 'kind' "$Label inventory"
    if ($expectedKind -notin @('absent', 'file', 'directory')) { throw "${Label} inventory kind is invalid." }
    if ($expectedKind -ne [string]$Actual.kind) { throw "${Label} backup kind does not match the install manifest." }

    $expectedDirectoriesProperty = $Expected.PSObject.Properties['directories']
    $expectedFilesProperty = $Expected.PSObject.Properties['files']
    if (-not $expectedDirectoriesProperty -or -not $expectedFilesProperty) { throw "${Label} inventory is incomplete." }
    $expectedDirectories = @($expectedDirectoriesProperty.Value)
    $actualDirectories = @($Actual.directories)
    if ($expectedDirectories.Count -ne $actualDirectories.Count) { throw "${Label} backup directory list does not match the install manifest." }
    $seenDirectories = @{}
    foreach ($directory in $expectedDirectories) {
        if ($directory -isnot [string]) { throw "${Label} inventory contains a non-string directory." }
        Assert-SafeInventoryPath $directory "$Label inventory"
        if ($seenDirectories.ContainsKey($directory)) { throw "${Label} inventory contains a duplicate directory." }
        $seenDirectories[$directory] = $true
    }
    for ($index = 0; $index -lt $expectedDirectories.Count; $index++) {
        if (-not ([string]$expectedDirectories[$index]).Equals([string]$actualDirectories[$index], [System.StringComparison]::Ordinal)) {
            throw "${Label} backup directory list does not match the install manifest."
        }
    }

    $expectedFiles = @($expectedFilesProperty.Value)
    $actualFiles = @($Actual.files)
    if ($expectedFiles.Count -ne $actualFiles.Count) { throw "${Label} backup file list does not match the install manifest." }
    $seenFiles = @{}
    for ($index = 0; $index -lt $expectedFiles.Count; $index++) {
        $expectedFile = $expectedFiles[$index]
        if (-not $expectedFile) { throw "${Label} inventory contains an invalid file entry." }
        $expectedPath = Get-RequiredString $expectedFile 'path' "$Label file inventory"
        Assert-SafeInventoryPath $expectedPath "$Label file inventory"
        if ($seenFiles.ContainsKey($expectedPath)) { throw "${Label} inventory contains a duplicate file." }
        $seenFiles[$expectedPath] = $true
        $lengthProperty = $expectedFile.PSObject.Properties['length']
        $expectedLength = 0L
        if (-not $lengthProperty -or -not [long]::TryParse([string]$lengthProperty.Value, [ref]$expectedLength) -or $expectedLength -lt 0) {
            throw "${Label} file inventory contains an invalid length."
        }
        $expectedHash = Get-RequiredString $expectedFile 'sha256' "$Label file inventory"
        if ($expectedHash -notmatch '^[a-fA-F0-9]{64}$') { throw "${Label} file inventory contains an invalid SHA256." }
        $actualFile = $actualFiles[$index]
        if (-not $expectedPath.Equals([string]$actualFile.path, [System.StringComparison]::Ordinal) -or
            $expectedLength -ne [long]$actualFile.length -or
            -not $expectedHash.Equals([string]$actualFile.sha256, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "${Label} backup file list or SHA256 does not match the install manifest."
        }
    }
}

$installRootFull = [System.IO.Path]::GetFullPath($InstallRoot)
$backupsRoot = Join-Path $installRootFull 'backups'
[void](Assert-NoReparseTraversal -Path $installRootFull -Label 'install root')
[void](Assert-SafeExistingTree -Path $backupsRoot -Label 'install backup directory' -ExpectedType Directory)

$userProfilePath = [Environment]::GetFolderPath('UserProfile')
if (-not $CodexSkillRoot) { $CodexSkillRoot = Join-Path $userProfilePath '.codex\skills' }
if (-not $AntigravitySkillRoot) { $AntigravitySkillRoot = Join-Path $userProfilePath '.gemini\config\skills' }
$CodexSkillRoot = [System.IO.Path]::GetFullPath($CodexSkillRoot)
$AntigravitySkillRoot = [System.IO.Path]::GetFullPath($AntigravitySkillRoot)
[void](Assert-NoReparseTraversal -Path $CodexSkillRoot -Label 'Codex Skill root')
[void](Assert-NoReparseTraversal -Path $AntigravitySkillRoot -Label 'Antigravity Skill root')

if (-not $ManifestPath) {
    # The entire backup tree is checked before recursive manifest discovery.
    [void](Assert-SafeExistingTree -Path $backupsRoot -Label 'install backup directory' -ExpectedType Directory)
    $latest = Get-ChildItem -LiteralPath $backupsRoot -Filter 'install-manifest.json' -Recurse -File |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latest) { throw 'No install manifest was found.' }
    $ManifestPath = $latest.FullName
}
[void](Assert-NoReparseTraversal -Path $ManifestPath -Label 'install manifest')
$manifestFull = (Resolve-Path -LiteralPath $ManifestPath -ErrorAction Stop).Path
[void](Assert-SafeExistingTree -Path $manifestFull -Label 'install manifest' -ExpectedType File)
if (-not (Test-IsInside $backupsRoot $manifestFull)) { throw 'Manifest is outside the install backup directory.' }
if ((Split-Path -Leaf $manifestFull) -ne 'install-manifest.json') { throw 'Install manifest filename is invalid.' }
$batchRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $manifestFull))
if (-not (Test-ExactPath (Split-Path -Parent $batchRoot) $backupsRoot)) { throw 'Install manifest must be directly inside one install batch directory.' }
[void](Assert-SafeExistingTree -Path $batchRoot -Label 'install batch directory' -ExpectedType Directory)

$manifest = Get-Content -LiteralPath $manifestFull -Encoding UTF8 -Raw | ConvertFrom-Json
$schemaProperty = $manifest.PSObject.Properties['schemaVersion']
$schemaVersion = 0
if (-not $schemaProperty -or -not [int]::TryParse([string]$schemaProperty.Value, [ref]$schemaVersion) -or $schemaVersion -notin @(1, 2)) {
    throw 'Install manifest schema is incompatible.'
}
$manifestInstallRoot = Get-RequiredString $manifest 'installRoot' 'Install manifest'
if (-not (Test-ExactPath $manifestInstallRoot $installRootFull)) { throw 'Install manifest is bound to a different install root.' }
$installId = Get-RequiredString $manifest 'installId' 'Install manifest'
if ($installId -notmatch '^[a-fA-F0-9]{32}$' -or (Split-Path -Leaf $batchRoot) -notmatch "^\d{8}-\d{6}-$([regex]::Escape($installId))$") {
    throw 'Install manifest is not bound to its install batch directory.'
}
if ($schemaVersion -eq 2) {
    $manifestBackupRoot = Get-RequiredString $manifest 'backupRoot' 'Install manifest'
    if (-not (Test-ExactPath $manifestBackupRoot $batchRoot)) { throw 'Install manifest backup root does not match its install batch.' }
}

$expectedAppTarget = Join-Path $installRootFull 'app'
$expectedAppBackup = Join-Path $batchRoot 'app'
$appTarget = [System.IO.Path]::GetFullPath((Get-RequiredString $manifest 'appTarget' 'Install manifest'))
$appBackup = [System.IO.Path]::GetFullPath((Get-RequiredString $manifest 'appBackup' 'Install manifest'))
if (-not (Test-ExactPath $appTarget $expectedAppTarget) -or -not (Test-ExactPath $appBackup $expectedAppBackup)) {
    throw 'Install manifest app paths are not exactly bound to this install batch.'
}
$appWasPresent = Get-RequiredBoolean $manifest 'appWasPresent' 'Install manifest'
$appTargetExists = Assert-SafeExistingTree -Path $appTarget -Label 'installed app target' -ExpectedType Directory
$appBackupExists = Assert-SafeExistingTree -Path $appBackup -Label 'app backup' -ExpectedType Directory
if ($appWasPresent -ne [bool]$appBackupExists) { throw 'App backup presence does not match the install manifest.' }
if ($schemaVersion -eq 2) {
    Assert-InventoryMatches $manifest.appBackupInventory (Get-PathInventory $appBackup 'app backup') 'App'
}

$expectedConfigPath = Join-Path $installRootFull 'config\config.json'
$expectedConfigBackup = Join-Path $batchRoot 'config.json'
$configPath = [System.IO.Path]::GetFullPath((Get-RequiredString $manifest 'configPath' 'Install manifest'))
$configBackup = [System.IO.Path]::GetFullPath((Get-RequiredString $manifest 'configBackup' 'Install manifest'))
if (-not (Test-ExactPath $configPath $expectedConfigPath) -or -not (Test-ExactPath $configBackup $expectedConfigBackup)) {
    throw 'Install manifest config paths are not exactly bound to this install batch.'
}
$configWasPresent = Get-RequiredBoolean $manifest 'configWasPresent' 'Install manifest'
$configTargetExists = Assert-SafeExistingTree -Path $configPath -Label 'installed config target' -ExpectedType File
$configBackupExists = Assert-SafeExistingTree -Path $configBackup -Label 'config backup' -ExpectedType File
if ($configWasPresent -ne [bool]$configBackupExists) { throw 'Config backup presence does not match the install manifest.' }
if ($schemaVersion -eq 2) {
    Assert-InventoryMatches $manifest.configBackupInventory (Get-PathInventory $configBackup 'config backup') 'Config'
}

$skillsProperty = $manifest.PSObject.Properties['skills']
if (-not $skillsProperty) { throw 'Install manifest is missing its Skill list.' }
$skillEntries = @($skillsProperty.Value)
if ($skillEntries.Count -lt 1 -or $skillEntries.Count -gt 2) { throw 'Install manifest Skill list is invalid.' }
$seenSkillNames = @{}
$seenSkillTargets = @{}
$skillPlans = @()
foreach ($entry in $skillEntries) {
    $name = Get-RequiredString $entry 'name' 'Skill manifest entry'
    if ($name -notin @('codex', 'antigravity')) { throw 'Unknown Skill target type in manifest.' }
    if ($seenSkillNames.ContainsKey($name)) { throw 'Install manifest contains a duplicate Skill entry.' }
    $seenSkillNames[$name] = $true
    $expectedRoot = if ($name -eq 'codex') { $CodexSkillRoot } else { $AntigravitySkillRoot }
    $expectedTarget = Join-Path $expectedRoot 'obsidian-second-brain'
    $expectedBackup = Join-Path $batchRoot ("skill-" + $name)
    $target = [System.IO.Path]::GetFullPath((Get-RequiredString $entry 'target' 'Skill manifest entry'))
    $backup = [System.IO.Path]::GetFullPath((Get-RequiredString $entry 'backup' 'Skill manifest entry'))
    if (-not (Test-ExactPath $target $expectedTarget) -or -not (Test-ExactPath $backup $expectedBackup)) {
        throw "Install manifest $name Skill paths are not exactly bound to this install batch."
    }
    $targetKey = $target.ToLowerInvariant()
    if ($seenSkillTargets.ContainsKey($targetKey)) { throw 'Install manifest contains a duplicate Skill target.' }
    $seenSkillTargets[$targetKey] = $true
    $hadPrevious = Get-RequiredBoolean $entry 'hadPrevious' 'Skill manifest entry'
    $targetExists = Assert-SafeExistingTree -Path $target -Label "$name Skill target" -ExpectedType Directory
    $backupExists = Assert-SafeExistingTree -Path $backup -Label "$name Skill backup" -ExpectedType Directory
    if ($hadPrevious -ne [bool]$backupExists) { throw "$name Skill backup presence does not match the install manifest." }
    if ($schemaVersion -eq 2) {
        Assert-InventoryMatches $entry.backupInventory (Get-PathInventory $backup "$name Skill backup") "$name Skill"
    }
    $skillPlans += [pscustomobject]@{
        name = $name
        target = $target
        backup = $backup
        hadPrevious = $hadPrevious
        targetExists = [bool]$targetExists
        currentQuarantined = $false
        previousRestored = $false
    }
}

# No filesystem mutation is allowed above this point. Recheck all ancestors immediately before it.
[void](Assert-SafeExistingTree -Path $backupsRoot -Label 'install backup directory' -ExpectedType Directory)
[void](Assert-SafeExistingTree -Path $batchRoot -Label 'install batch directory' -ExpectedType Directory)
[void](Assert-SafeExistingTree -Path $manifestFull -Label 'install manifest' -ExpectedType File)
[void](Assert-NoReparseTraversal -Path $appTarget -Label 'installed app target')
[void](Assert-NoReparseTraversal -Path $appBackup -Label 'app backup')
[void](Assert-NoReparseTraversal -Path $configPath -Label 'installed config target')
[void](Assert-NoReparseTraversal -Path $configBackup -Label 'config backup')
foreach ($plan in $skillPlans) {
    [void](Assert-NoReparseTraversal -Path $plan.target -Label "$($plan.name) Skill target")
    [void](Assert-NoReparseTraversal -Path $plan.backup -Label "$($plan.name) Skill backup")
}

$rollbackId = [guid]::NewGuid().ToString('N')
$quarantine = Join-Path $backupsRoot ("rollback-$rollbackId")
[void](Assert-NoReparseTraversal -Path $quarantine -Label 'rollback quarantine')
if (Test-Path -LiteralPath $quarantine) { throw 'Rollback quarantine already exists.' }
New-Item -ItemType Directory -Path $quarantine | Out-Null
[void](Assert-SafeExistingTree -Path $quarantine -Label 'rollback quarantine' -ExpectedType Directory)

$appCurrentQuarantined = $false
$appPreviousRestored = $false
$configCurrentQuarantined = $false
$configPreviousRestored = $false
try {
    foreach ($plan in $skillPlans) {
        if ($plan.targetExists) {
            Move-DirectoryExact $plan.target (Join-Path $quarantine ("current-skill-" + $plan.name))
            $plan.currentQuarantined = $true
        }
        if ($plan.hadPrevious) {
            Move-DirectoryExact $plan.backup $plan.target
            $plan.previousRestored = $true
        }
    }

    if ($appTargetExists) {
        Move-DirectoryExact $appTarget (Join-Path $quarantine 'current-app')
        $appCurrentQuarantined = $true
    }
    if ($appWasPresent) {
        Move-DirectoryExact $appBackup $appTarget
        $appPreviousRestored = $true
    }

    if ($configTargetExists) {
        Move-FileExact $configPath (Join-Path $quarantine 'current-config.json')
        $configCurrentQuarantined = $true
    }
    if ($configWasPresent) {
        Move-FileExact $configBackup $configPath
        $configPreviousRestored = $true
    }
} catch {
    $rollbackFailure = $_
    try {
        if ($configPreviousRestored -and (Test-Path -LiteralPath $configPath)) {
            Move-FileExact $configPath $configBackup
            $configPreviousRestored = $false
        }
        $quarantinedConfig = Join-Path $quarantine 'current-config.json'
        if ($configCurrentQuarantined -and (Test-Path -LiteralPath $quarantinedConfig)) {
            Move-FileExact $quarantinedConfig $configPath
            $configCurrentQuarantined = $false
        }
        if ($appPreviousRestored -and (Test-Path -LiteralPath $appTarget)) {
            Move-DirectoryExact $appTarget $appBackup
            $appPreviousRestored = $false
        }
        $quarantinedApp = Join-Path $quarantine 'current-app'
        if ($appCurrentQuarantined -and (Test-Path -LiteralPath $quarantinedApp)) {
            Move-DirectoryExact $quarantinedApp $appTarget
            $appCurrentQuarantined = $false
        }
        for ($index = $skillPlans.Count - 1; $index -ge 0; $index--) {
            $plan = $skillPlans[$index]
            if ($plan.previousRestored -and (Test-Path -LiteralPath $plan.target)) {
                Move-DirectoryExact $plan.target $plan.backup
                $plan.previousRestored = $false
            }
            $quarantinedSkill = Join-Path $quarantine ("current-skill-" + $plan.name)
            if ($plan.currentQuarantined -and (Test-Path -LiteralPath $quarantinedSkill)) {
                Move-DirectoryExact $quarantinedSkill $plan.target
                $plan.currentQuarantined = $false
            }
        }
    } catch {
        throw "Rollback failed and automatic recovery also failed. Original error: $($rollbackFailure.Exception.Message). Recovery error: $($_.Exception.Message). Preserved recovery data: $quarantine"
    }
    throw $rollbackFailure
}

[pscustomobject]@{
    ok = $true
    restoredManifest = $manifestFull
    manifestSchemaVersion = $schemaVersion
    backupIntegrityVerified = ($schemaVersion -eq 2)
    quarantine = $quarantine
    vaultModified = $false
    localIndexPreserved = $true
} | ConvertTo-Json -Depth 3
