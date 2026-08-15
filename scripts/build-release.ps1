[CmdletBinding()]
param(
    [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$OutputRoot,
    [string]$ArchiveName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-FullPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$MustExist
    )

    if ($MustExist) {
        return (Resolve-Path -LiteralPath $Path -ErrorAction Stop).ProviderPath
    }
    return [System.IO.Path]::GetFullPath($Path)
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

function Test-IsSameOrChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Candidate
    )

    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $candidateFull = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\', '/')
    if ($candidateFull.Equals($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    return $candidateFull.StartsWith(
        $rootFull + [System.IO.Path]::DirectorySeparatorChar,
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Get-RelativeReleasePath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$FullPath
    )

    if (-not (Test-IsSameOrChildPath -Root $Root -Candidate $FullPath)) {
        throw "Path escapes source root: $FullPath"
    }
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $fileFull = [System.IO.Path]::GetFullPath($FullPath)
    return $fileFull.Substring($rootFull.Length).TrimStart('\', '/').Replace('\', '/')
}

function Assert-NotInsideObsidianVault {
    param([Parameter(Mandatory = $true)][string]$Path)

    $cursor = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    while ($cursor) {
        if (Test-Path -LiteralPath (Join-Path $cursor '.obsidian') -PathType Container) {
            throw "Release source/output must not be inside an Obsidian vault: $Path"
        }
        $parent = Split-Path -Parent $cursor
        if (-not $parent -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Assert-ReleasePath {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    $normalized = $RelativePath.Replace('\', '/')
    $segments = @($normalized.Split('/') | Where-Object { $_ })
    $deniedSegments = @(
        '.git', '.obsidian', '.cache', '.qmd', '.pytest_cache', '.venv', '__pycache__',
        'node_modules', 'private-eval', 'package-stage', 'coverage', 'dist',
        'models', 'model', 'audit', 'audits', 'candidates', 'candidate-data',
        'logs', 'backups', 'cache', 'indexes', 'runtime', 'venv'
    )
    foreach ($segment in $segments) {
        if ($deniedSegments -contains $segment.ToLowerInvariant()) {
            throw "Denied release path segment '$segment': $RelativePath"
        }
    }

    $leaf = [System.IO.Path]::GetFileName($normalized)
    if ($leaf -match '^(?i)\.env(?:\..*)?$' -or
        $leaf -match '^(?i)config\.local(?:\..*)?$' -or
        $leaf -match '^(?i)(?:credentials?|secrets?|vault-path)(?:\..*)?$') {
        throw "Denied sensitive filename: $RelativePath"
    }

    $extension = [System.IO.Path]::GetExtension($leaf).ToLowerInvariant()
    $allowedExtensions = @(
        '.js', '.mjs', '.cjs', '.json', '.jsonl', '.md', '.ps1', '.py',
        '.txt', '.yaml', '.yml', '.toml'
    )
    $allowedExtensionless = @('LICENSE', '.gitignore', '.gitattributes')
    if ($allowedExtensionless -notcontains $leaf -and $allowedExtensions -notcontains $extension) {
        throw "File type is not on the release allowlist: $RelativePath"
    }
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content
    )

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

$sourceInput = Resolve-FullPath -Path $SourceRoot
[void](Assert-NoReparseTraversal -Path $sourceInput -Label 'release source root')
$source = Resolve-FullPath -Path $sourceInput -MustExist
[void](Assert-NoReparseTraversal -Path $source -Label 'release source root')
if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "Source root is not a directory: $source"
}
if (-not (Split-Path -Parent $source)) {
    throw 'A drive root cannot be used as a release source.'
}
Assert-NotInsideObsidianVault -Path $source

$requiredSourceFiles = @(
    'README.md',
    'LICENSE',
    'SECURITY.md',
    'PRIVACY.md',
    'THIRD_PARTY_NOTICES.md',
    'package.json',
    'package-lock.json',
    'scripts/scan-release.ps1',
    'schemas/config.schema.json',
    'schemas/evidence.schema.json',
    'schemas/candidate-store.schema.json',
    'schemas/audit-event.schema.json'
)
foreach ($relative in $requiredSourceFiles) {
    $requiredSource = Join-Path $source $relative
    [void](Assert-NoReparseTraversal -Path $requiredSource -Label "required release file '$relative'")
    if (-not (Test-Path -LiteralPath $requiredSource -PathType Leaf)) {
        throw "Required release source is missing: $relative"
    }
}

$requiredDirectories = @('src', 'scripts', 'schemas', 'docs', 'test')
foreach ($relative in $requiredDirectories) {
    $requiredDirectory = Join-Path $source $relative
    [void](Assert-NoReparseTraversal -Path $requiredDirectory -Label "required release directory '$relative'")
    if (-not (Test-Path -LiteralPath $requiredDirectory -PathType Container)) {
        throw "Required release directory is missing: $relative"
    }
}

if (-not $OutputRoot) {
    $OutputRoot = Join-Path $source 'package-stage'
}
$output = Resolve-FullPath -Path $OutputRoot
[void](Assert-NoReparseTraversal -Path $output -Label 'release output root')
Assert-NotInsideObsidianVault -Path $output

if (Test-IsSameOrChildPath -Root $source -Candidate $output) {
    $relativeOutput = Get-RelativeReleasePath -Root $source -FullPath $output
    $firstSegment = @($relativeOutput.Split('/', [System.StringSplitOptions]::RemoveEmptyEntries))[0]
    if ($firstSegment -ne 'package-stage') {
        throw 'An output directory inside the source must be under package-stage/.'
    }
}

$rootFileAllowlist = @(
    '.gitignore',
    '.gitattributes',
    'README.md',
    'LICENSE',
    'SECURITY.md',
    'PRIVACY.md',
    'THIRD_PARTY_NOTICES.md',
    'CHANGELOG.md',
    'package.json',
    'package-lock.json',
    'requirements-semantic.txt'
)
$directoryAllowlist = @('src', 'scripts', 'schemas', 'docs', 'skill', 'test', '.github')

$releaseFiles = New-Object System.Collections.Generic.List[System.IO.FileInfo]
foreach ($relative in $rootFileAllowlist) {
    $candidate = Join-Path $source $relative
    [void](Assert-NoReparseTraversal -Path $candidate -Label "allowlisted root file '$relative'")
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $releaseFiles.Add((Get-Item -LiteralPath $candidate -Force))
    }
}

foreach ($relative in $directoryAllowlist) {
    $directory = Join-Path $source $relative
    [void](Assert-NoReparseTraversal -Path $directory -Label "allowlisted directory '$relative'")
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { continue }

    foreach ($item in Get-ChildItem -LiteralPath $directory -Recurse -Force) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            $itemRelative = Get-RelativeReleasePath -Root $source -FullPath $item.FullName
            throw "Reparse points and symbolic links are not allowed in a release: $itemRelative"
        }
        $itemRelative = Get-RelativeReleasePath -Root $source -FullPath $item.FullName
        $itemSegments = @($itemRelative.Split('/') | Where-Object { $_ })
        $generatedSegments = @(
            '.cache', '.qmd', '.pytest_cache', '.venv', '__pycache__', 'node_modules',
            'private-eval', 'package-stage', 'coverage', 'dist', 'models', 'model',
            'audit', 'audits', 'candidates', 'candidate-data', 'logs', 'backups',
            'cache', 'indexes', 'runtime', 'venv'
        )
        $generated = $false
        foreach ($segment in $itemSegments) {
            if ($generatedSegments -contains $segment.ToLowerInvariant()) {
                $generated = $true
                break
            }
        }
        if ($generated) { continue }
        if ($item.PSIsContainer) {
            Assert-ReleasePath -RelativePath ($itemRelative + '/placeholder.txt')
            continue
        }
        $releaseFiles.Add($item)
    }
}

$planned = @()
$seen = @{}
foreach ($file in $releaseFiles) {
    $relative = Get-RelativeReleasePath -Root $source -FullPath $file.FullName
    Assert-ReleasePath -RelativePath $relative
    $key = $relative.ToLowerInvariant()
    if ($seen.ContainsKey($key)) {
        throw "Duplicate case-insensitive release path: $relative"
    }
    $seen[$key] = $true
    $planned += [pscustomobject]@{
        RelativePath = $relative
        SourcePath = $file.FullName
        Length = [int64]$file.Length
    }
}
$planned = @($planned | Sort-Object RelativePath)
if ($planned.Count -eq 0) { throw 'The explicit allowlist selected no files.' }

New-Item -ItemType Directory -Path $output -Force | Out-Null
[void](Assert-NoReparseTraversal -Path $output -Label 'created release output root')
$package = Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$safeName = ([string]$package.name -replace '^@', '' -replace '[^A-Za-z0-9._-]+', '-')
$safeVersion = ([string]$package.version -replace '[^A-Za-z0-9._-]+', '-')
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$nonce = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$stage = Join-Path $output "$safeName-$safeVersion-$stamp-$nonce"
if (Test-Path -LiteralPath $stage) { throw "Refusing to overwrite existing stage: $stage" }
New-Item -ItemType Directory -Path $stage | Out-Null
[void](Assert-NoReparseTraversal -Path $stage -Label 'release staging directory')

foreach ($entry in $planned) {
    $destination = Join-Path $stage ($entry.RelativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
    $parent = Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Copy-Item -LiteralPath $entry.SourcePath -Destination $destination
}

$commit = $null
if ((Test-Path -LiteralPath (Join-Path $source '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)) {
    $candidateCommit = (& git -C $source rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -eq 0 -and $candidateCommit) { $commit = [string]$candidateCommit }
}

$manifestEntries = @()
foreach ($entry in $planned) {
    $stagedFile = Join-Path $stage ($entry.RelativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
    $sourceHash = (Get-FileHash -LiteralPath $entry.SourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $stagedHash = (Get-FileHash -LiteralPath $stagedFile -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($sourceHash -ne $stagedHash) {
        throw "Source-to-stage hash mismatch: $($entry.RelativePath)"
    }
    $manifestEntries += [ordered]@{
        path = $entry.RelativePath
        bytes = [int64](Get-Item -LiteralPath $stagedFile).Length
        sha256 = $stagedHash
    }
}

$manifest = [ordered]@{
    schemaVersion = 1
    package = [string]$package.name
    version = [string]$package.version
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    sourceCommit = $commit
    policy = [ordered]@{
        selection = 'explicit-allowlist'
        containsVault = $false
        containsDerivedData = $false
        containsModels = $false
        containsCredentials = $false
    }
    files = $manifestEntries
}
$manifestPath = Join-Path $stage 'release-manifest.json'
Write-Utf8NoBom -Path $manifestPath -Content ($manifest | ConvertTo-Json -Depth 8)

$sumLines = New-Object System.Collections.Generic.List[string]
foreach ($entry in $manifestEntries) {
    $sumLines.Add("$($entry.sha256)  $($entry.path)")
}
$manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
$sumLines.Add("$manifestHash  release-manifest.json")
$sumPath = Join-Path $stage 'SHA256SUMS'
Write-Utf8NoBom -Path $sumPath -Content (($sumLines | Sort-Object) -join "`n")

$scanner = Join-Path $stage 'scripts/scan-release.ps1'
$directoryScan = & $scanner -Path $stage -AllowSyntheticFixtures

if (-not $ArchiveName) {
    $ArchiveName = "$safeName-$safeVersion-$stamp.zip"
}
if ([System.IO.Path]::GetFileName($ArchiveName) -ne $ArchiveName -or $ArchiveName -notmatch '\.zip$') {
    throw 'ArchiveName must be a simple .zip filename.'
}
$archive = Join-Path $output $ArchiveName
[void](Assert-NoReparseTraversal -Path $output -Label 'release output root before archive creation')
[void](Assert-NoReparseTraversal -Path $stage -Label 'release staging directory before archive creation')
if (Test-Path -LiteralPath $archive) {
    throw "Refusing to overwrite existing archive: $archive"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stage,
    $archive,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
)

$archiveScan = & $scanner -Path $archive -AllowSyntheticFixtures

[pscustomobject]@{
    status = 'ok'
    sourceRoot = $source
    stagePath = $stage
    archivePath = $archive
    archiveSha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    sourceFileCount = $planned.Count
    packagedFileCount = $planned.Count + 2
    directoryScan = $directoryScan
    archiveScan = $archiveScan
}
