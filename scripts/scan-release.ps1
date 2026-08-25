[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [int64]$MaxFileBytes = 1MB,
    [int]$MaxEntries = 1000,
    [int64]$MaxTotalBytes = 25MB,
    [switch]$AllowSyntheticFixtures,
    [switch]$RequireGitleaks,
    [string]$GitRepository
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Add-Finding {
    param(
        [Parameter(Mandatory = $true)][string]$Rule,
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Nullable[int]]$Line
    )

    $safePath = $RelativePath
    $privateVaultInPath = '(?i)(?:obsidian[\\/]+codex' + [char]0x77E5 + [char]0x8BC6 + [char]0x5E93 + '|codex' + [char]0x77E5 + [char]0x8BC6 + [char]0x5E93 + ')'
    $sensitivePathPattern = '(?i)(?:[A-Za-z]:[\\/]+Users[\\/]+|/(?:Users|home)/|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-)[A-Za-z0-9_-]{10,}|(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{17}[0-9Xx](?!\d))'
    if ($safePath -match $sensitivePathPattern -or $safePath -match $privateVaultInPath) {
        $safePath = '<redacted-path>'
    }
    $item = [ordered]@{ rule = $Rule; path = $safePath }
    if ($null -ne $Line) { $item.line = $Line }
    $script:findings.Add([pscustomobject]$item)
}

function Get-LineNumber {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][int]$Index
    )

    if ($Index -le 0) { return 1 }
    return ([regex]::Matches($Text.Substring(0, $Index), "`n").Count + 1)
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Test-AllowedReleasePath {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    $normalized = $RelativePath.Replace('\', '/')
    if (-not $normalized -or $normalized.StartsWith('/') -or
        $normalized -match '^[A-Za-z]:' -or
        $normalized -match '(^|/)\.\.(/|$)' -or
        $normalized.Contains([char]0)) {
        Add-Finding -Rule 'unsafe-or-absolute-path' -RelativePath $RelativePath
        return $false
    }

    $rootFiles = @(
        '.gitignore', '.gitattributes', 'AGENTS.md', 'START-HERE.md', 'INSTALL.cmd',
        'README.md', 'LICENSE', 'SECURITY.md',
        'PRIVACY.md', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'package.json',
        'package-lock.json', 'requirements-semantic.txt', 'release-manifest.json',
        'SHA256SUMS'
    )
    $rootDirectories = @('src', 'scripts', 'schemas', 'docs', 'skill', 'test', '.github')
    $segments = @($normalized.Split('/') | Where-Object { $_ })
    if ($segments.Count -eq 1) {
        if ($rootFiles -notcontains $segments[0]) {
            Add-Finding -Rule 'not-on-root-allowlist' -RelativePath $RelativePath
            return $false
        }
    }
    elseif ($rootDirectories -notcontains $segments[0]) {
        Add-Finding -Rule 'not-in-allowed-directory' -RelativePath $RelativePath
        return $false
    }

    $deniedSegments = @(
        '.git', '.obsidian', '.cache', '.qmd', '.pytest_cache', '.venv', '__pycache__',
        'node_modules', 'private-eval', 'package-stage', 'coverage', 'dist',
        'models', 'model', 'audit', 'audits', 'candidates', 'candidate-data',
        'logs', 'backups', 'cache', 'indexes', 'runtime', 'venv'
    )
    foreach ($segment in $segments) {
        if ($deniedSegments -contains $segment.ToLowerInvariant()) {
            Add-Finding -Rule 'denied-data-directory' -RelativePath $RelativePath
            return $false
        }
    }

    if (-not $AllowSyntheticFixtures -and $normalized -match '^(?i)test/fixtures/vault(?:/|$)') {
        Add-Finding -Rule 'synthetic-vault-fixture-not-approved' -RelativePath $RelativePath
        return $false
    }

    $leaf = [System.IO.Path]::GetFileName($normalized)
    if ($leaf -match '^(?i)\.env(?:\..*)?$' -or
        $leaf -match '^(?i)config\.local(?:\..*)?$' -or
        $leaf -match '^(?i)(?:credentials?|secrets?|vault-path)(?:\..*)?$') {
        Add-Finding -Rule 'sensitive-filename' -RelativePath $RelativePath
        return $false
    }

    $extension = [System.IO.Path]::GetExtension($leaf).ToLowerInvariant()
    $allowedExtensions = @(
        '.js', '.mjs', '.cjs', '.json', '.jsonl', '.md', '.ps1', '.py',
        '.txt', '.yaml', '.yml', '.toml', '.cmd'
    )
    $allowedExtensionless = @('LICENSE', '.gitignore', '.gitattributes', 'SHA256SUMS')
    if ($allowedExtensionless -notcontains $leaf -and $allowedExtensions -notcontains $extension) {
        Add-Finding -Rule 'binary-or-unapproved-file-type' -RelativePath $RelativePath
        return $false
    }
    return $true
}

function Test-Content {
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][byte[]]$Bytes
    )

    if ($Bytes -contains 0) {
        Add-Finding -Rule 'binary-null-byte' -RelativePath $RelativePath
        return
    }

    try {
        $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
        $text = $strictUtf8.GetString($Bytes)
    }
    catch {
        Add-Finding -Rule 'invalid-utf8' -RelativePath $RelativePath
        return
    }

    $privateVaultName = '(?i)(?:obsidian[\\/]+codex' + [char]0x77E5 + [char]0x8BC6 + [char]0x5E93 + '|codex' + [char]0x77E5 + [char]0x8BC6 + [char]0x5E93 + ')'
    $credentialWords = '(?i)\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)\b\s*[:=]\s*["'']?([^\s"'';,}]{8,})'
    $privateKeyHeader = '-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----'
    $rules = @(
        [pscustomobject]@{ Name = 'windows-user-profile-path'; Pattern = '(?i)[A-Za-z]:[\\/]+Users[\\/]+(?!<|%|\$|\{)[^\\/\r\n"''<>]+(?:[\\/]|(?=["''\r\n\s]|$))' },
        [pscustomobject]@{ Name = 'unix-user-home-path'; Pattern = '(?i)/(?:Users|home)/(?!<|\$|\{)[^/\s"''<>]+(?:/|(?=["''\r\n\s]|$))' },
        [pscustomobject]@{ Name = 'known-private-vault-name'; Pattern = $privateVaultName },
        [pscustomobject]@{ Name = 'email-address'; Pattern = '(?i)(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![A-Z0-9.-])' },
        [pscustomobject]@{ Name = 'mainland-mobile-number'; Pattern = '(?<![0-9a-fA-F])1[3-9]\d{9}(?![0-9a-fA-F])' },
        [pscustomobject]@{ Name = 'mainland-id-number'; Pattern = '(?<![0-9a-fA-F])\d{17}[0-9Xx](?![0-9a-fA-F])' },
        [pscustomobject]@{ Name = 'private-key'; Pattern = $privateKeyHeader },
        [pscustomobject]@{ Name = 'github-token'; Pattern = '(?i)\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b' },
        [pscustomobject]@{ Name = 'openai-token'; Pattern = '(?i)\bsk-[A-Za-z0-9_-]{20,}\b' },
        [pscustomobject]@{ Name = 'aws-access-key'; Pattern = '\b(?:AKIA|ASIA)[A-Z0-9]{16}\b' },
        [pscustomobject]@{ Name = 'slack-token'; Pattern = '(?i)\bxox[baprs]-[A-Za-z0-9-]{20,}\b' },
        [pscustomobject]@{ Name = 'google-api-key'; Pattern = '\bAIza[A-Za-z0-9_-]{30,}\b' }
    )

    foreach ($rule in $rules) {
        $match = [regex]::Match($text, $rule.Pattern)
        if ($match.Success) {
            Add-Finding -Rule $rule.Name -RelativePath $RelativePath -Line (Get-LineNumber -Text $text -Index $match.Index)
        }
    }

    foreach ($match in [regex]::Matches($text, $credentialWords)) {
        $value = $match.Groups[1].Value
        if ($value -match '^(?i)(?:redacted|example|sample|dummy|changeme|replace-me|your[_-]|<|\$\{|\$env:|process\.env)') {
            continue
        }
        Add-Finding -Rule 'credential-assignment' -RelativePath $RelativePath -Line (Get-LineNumber -Text $text -Index $match.Index)
        break
    }
}

function Read-DirectoryEntries {
    param([Parameter(Mandatory = $true)][string]$Directory)

    $root = (Resolve-Path -LiteralPath $Directory -ErrorAction Stop).ProviderPath.TrimEnd('\', '/')
    $items = @()
    $runningTotal = [int64]0
    $entryCount = 0
    $limitReached = $false
    $pending = New-Object System.Collections.Stack
    $pending.Push([pscustomobject]@{ FullPath = $root; RelativePath = '' })
    while ($pending.Count -gt 0 -and -not $limitReached) {
        $current = $pending.Pop()
        foreach ($item in Get-ChildItem -LiteralPath $current.FullPath -Force) {
            $relative = if ($current.RelativePath) {
                "$($current.RelativePath)/$($item.Name)"
            }
            else {
                [string]$item.Name
            }
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                Add-Finding -Rule 'reparse-point' -RelativePath $relative
                continue
            }
            if ($item.PSIsContainer) {
                $pending.Push([pscustomobject]@{ FullPath = $item.FullName; RelativePath = $relative })
                continue
            }
            $entryCount += 1
            if ($entryCount -gt $MaxEntries) {
                Add-Finding -Rule 'entry-count-limit-exceeded' -RelativePath '<release>'
                $pending.Clear()
                $limitReached = $true
                break
            }
            $runningTotal += [int64]$item.Length
            $bytes = [byte[]]@()
            if ([int64]$item.Length -le $MaxFileBytes -and $runningTotal -le $MaxTotalBytes) {
                $bytes = [System.IO.File]::ReadAllBytes($item.FullName)
            }
            $items += [pscustomobject]@{
                Path = $relative
                Length = [int64]$item.Length
                Bytes = $bytes
            }
        }
    }
    return $items
}

function Read-ZipEntries {
    param([Parameter(Mandatory = $true)][string]$Archive)

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        $items = @()
        $runningTotal = [int64]0
        $entryCount = 0
        foreach ($entry in $zip.Entries) {
            if (-not $entry.Name) { continue }
            $entryCount += 1
            if ($entryCount -gt $MaxEntries) {
                Add-Finding -Rule 'entry-count-limit-exceeded' -RelativePath '<release>'
                break
            }
            $relative = $entry.FullName.Replace('\', '/')
            $unixFileType = ([int64]$entry.ExternalAttributes -shr 16) -band 0xF000
            if ($unixFileType -eq 0xA000) {
                Add-Finding -Rule 'archive-symbolic-link' -RelativePath $relative
                continue
            }
            $runningTotal += [int64]$entry.Length
            $bytes = [byte[]]@()
            if ([int64]$entry.Length -le $MaxFileBytes -and $runningTotal -le $MaxTotalBytes) {
                $stream = $entry.Open()
                try {
                    $memory = New-Object System.IO.MemoryStream
                    try {
                        $stream.CopyTo($memory)
                        $bytes = $memory.ToArray()
                    }
                    finally {
                        $memory.Dispose()
                    }
                }
                finally {
                    $stream.Dispose()
                }
            }
            $items += [pscustomobject]@{
                Path = $relative
                Length = [int64]$entry.Length
                Bytes = $bytes
            }
        }
        return $items
    }
    finally {
        $zip.Dispose()
    }
}

$script:findings = New-Object System.Collections.Generic.List[object]
$target = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).ProviderPath
$targetItem = Get-Item -LiteralPath $target -Force
if (($targetItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Add-Finding -Rule 'reparse-point' -RelativePath '<release-root>'
}
if ($targetItem.PSIsContainer) {
    $entries = @(Read-DirectoryEntries -Directory $target)
    $targetType = 'directory'
}
elseif ($targetItem.Extension -ieq '.zip') {
    $entries = @(Read-ZipEntries -Archive $target)
    $targetType = 'zip'
}
else {
    throw 'Path must point to a release directory or .zip archive.'
}

if ($entries.Count -gt $MaxEntries) {
    Add-Finding -Rule 'entry-count-limit-exceeded' -RelativePath '<release>'
}
$totalBytes = [int64]0
$seen = @{}
$entryMap = @{}
foreach ($entry in $entries) {
    $relative = [string]$entry.Path
    $key = $relative.ToLowerInvariant()
    if ($seen.ContainsKey($key)) {
        Add-Finding -Rule 'duplicate-case-insensitive-path' -RelativePath $relative
        continue
    }
    $seen[$key] = $true
    $entryMap[$relative] = $entry
    $totalBytes += [int64]$entry.Length
    [void](Test-AllowedReleasePath -RelativePath $relative)
    if ([int64]$entry.Length -gt $MaxFileBytes) {
        Add-Finding -Rule 'file-size-limit-exceeded' -RelativePath $relative
        continue
    }
    if ([int64]$entry.Length -ne [int64]$entry.Bytes.Length) {
        Add-Finding -Rule 'length-mismatch' -RelativePath $relative
        continue
    }
    if ($relative -ne 'SHA256SUMS') {
        Test-Content -RelativePath $relative -Bytes $entry.Bytes
    }
}
if ($totalBytes -gt $MaxTotalBytes) {
    Add-Finding -Rule 'release-size-limit-exceeded' -RelativePath '<release>'
}

$required = @(
    'AGENTS.md', 'START-HERE.md', 'INSTALL.cmd', 'scripts/install-wizard.ps1',
    'README.md', 'LICENSE', 'SECURITY.md', 'PRIVACY.md', 'THIRD_PARTY_NOTICES.md',
    'package.json', 'package-lock.json', 'release-manifest.json', 'SHA256SUMS',
    'schemas/config.schema.json', 'schemas/evidence.schema.json',
    'schemas/candidate-store.schema.json', 'schemas/audit-event.schema.json'
)
foreach ($relative in $required) {
    if (-not $entryMap.ContainsKey($relative)) {
        Add-Finding -Rule 'required-file-missing' -RelativePath $relative
    }
}

if ($entryMap.ContainsKey('release-manifest.json')) {
    try {
        $manifestText = (New-Object System.Text.UTF8Encoding($false, $true)).GetString($entryMap['release-manifest.json'].Bytes)
        $manifest = $manifestText | ConvertFrom-Json
        if ([int]$manifest.schemaVersion -ne 1 -or -not $manifest.files) {
            throw 'Unsupported manifest structure.'
        }
        if ($entryMap.ContainsKey('package.json')) {
            $packageText = (New-Object System.Text.UTF8Encoding($false, $true)).GetString($entryMap['package.json'].Bytes)
            $package = $packageText | ConvertFrom-Json
            if ([string]$manifest.package -ne [string]$package.name -or
                [string]$manifest.version -ne [string]$package.version) {
                Add-Finding -Rule 'manifest-package-identity-mismatch' -RelativePath 'release-manifest.json'
            }
        }
        $manifestPaths = @{}
        foreach ($file in $manifest.files) {
            $relative = [string]$file.path
            if ($manifestPaths.ContainsKey($relative)) {
                Add-Finding -Rule 'duplicate-manifest-path' -RelativePath $relative
                continue
            }
            $manifestPaths[$relative] = $true
            if (-not $entryMap.ContainsKey($relative)) {
                Add-Finding -Rule 'manifest-file-missing' -RelativePath $relative
                continue
            }
            $actual = $entryMap[$relative]
            if ([int64]$file.bytes -ne [int64]$actual.Length) {
                Add-Finding -Rule 'manifest-size-mismatch' -RelativePath $relative
            }
            if ([string]$file.sha256 -ne (Get-Sha256 -Bytes $actual.Bytes)) {
                Add-Finding -Rule 'manifest-hash-mismatch' -RelativePath $relative
            }
        }
        foreach ($entry in $entries) {
            if ($entry.Path -in @('release-manifest.json', 'SHA256SUMS')) { continue }
            if (-not $manifestPaths.ContainsKey([string]$entry.Path)) {
                Add-Finding -Rule 'unmanifested-file' -RelativePath ([string]$entry.Path)
            }
        }
        if (-not [bool]$manifest.policy -or
            [bool]$manifest.policy.containsVault -or
            [bool]$manifest.policy.containsDerivedData -or
            [bool]$manifest.policy.containsModels -or
            [bool]$manifest.policy.containsCredentials -or
            [string]$manifest.policy.selection -ne 'explicit-allowlist') {
            Add-Finding -Rule 'unsafe-manifest-policy' -RelativePath 'release-manifest.json'
        }
    }
    catch {
        Add-Finding -Rule 'invalid-release-manifest' -RelativePath 'release-manifest.json'
    }
}

if ($entryMap.ContainsKey('SHA256SUMS')) {
    try {
        $sumText = (New-Object System.Text.UTF8Encoding($false, $true)).GetString($entryMap['SHA256SUMS'].Bytes)
        $sumPaths = @{}
        foreach ($line in ($sumText -split "`r?`n")) {
            if (-not $line.Trim()) { continue }
            if ($line -notmatch '^([0-9a-f]{64})  (.+)$') { throw 'Invalid SHA256SUMS line.' }
            $hash = $matches[1]
            $relative = $matches[2]
            if ($sumPaths.ContainsKey($relative)) { throw 'Duplicate SHA256SUMS path.' }
            $sumPaths[$relative] = $true
            if (-not $entryMap.ContainsKey($relative)) {
                Add-Finding -Rule 'checksum-file-missing' -RelativePath $relative
                continue
            }
            if ($hash -ne (Get-Sha256 -Bytes $entryMap[$relative].Bytes)) {
                Add-Finding -Rule 'checksum-mismatch' -RelativePath $relative
            }
        }
        foreach ($entry in $entries) {
            if ($entry.Path -eq 'SHA256SUMS') { continue }
            if (-not $sumPaths.ContainsKey([string]$entry.Path)) {
                Add-Finding -Rule 'checksum-entry-missing' -RelativePath ([string]$entry.Path)
            }
        }
    }
    catch {
        Add-Finding -Rule 'invalid-checksum-file' -RelativePath 'SHA256SUMS'
    }
}

$gitleaksStatus = 'not-requested'
if ($GitRepository -or $RequireGitleaks) {
    $gitleaks = Get-Command gitleaks -ErrorAction SilentlyContinue
    if (-not $gitleaks) {
        Add-Finding -Rule 'gitleaks-not-installed' -RelativePath '<release>'
        $gitleaksStatus = 'unavailable'
    }
    elseif ($GitRepository) {
        $repo = (Resolve-Path -LiteralPath $GitRepository -ErrorAction Stop).ProviderPath
        & $gitleaks.Source git $repo --redact --no-banner --exit-code 7 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Add-Finding -Rule 'gitleaks-history-failed' -RelativePath '<git-history>'
            $gitleaksStatus = 'failed'
        }
        else {
            $gitleaksStatus = 'passed'
        }
    }
    elseif ($targetType -eq 'directory') {
        & $gitleaks.Source dir $target --redact --no-banner --exit-code 7 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Add-Finding -Rule 'gitleaks-directory-failed' -RelativePath '<release>'
            $gitleaksStatus = 'failed'
        }
        else {
            $gitleaksStatus = 'passed'
        }
    }
    else {
        Add-Finding -Rule 'gitleaks-needs-directory-or-git-repository' -RelativePath '<release>'
        $gitleaksStatus = 'not-run'
    }
}

if ($script:findings.Count -gt 0) {
    $safeReport = $script:findings | ConvertTo-Json -Depth 4
    throw "Release scan failed with $($script:findings.Count) finding(s). Match values are intentionally redacted.`n$safeReport"
}

[pscustomobject]@{
    status = 'ok'
    targetType = $targetType
    fileCount = $entries.Count
    totalBytes = $totalBytes
    gitleaks = $gitleaksStatus
    containsVault = $false
    containsDerivedData = $false
    containsModels = $false
    containsCredentials = $false
}
