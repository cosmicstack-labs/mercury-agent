# Mercury installer for Windows.
#
#   irm https://mercuryagent.sh/install.ps1 | iex
#
# Environment variables:
#   $env:MERCURY_VERSION   Version to install (e.g. "1.1.9"). Default: latest.
#                          (Stable channel only — dev tracks the latest dev
#                          build.)
#   $env:MERCURY_CHANNEL   Distribution channel: "stable" (default) or "dev".
#   $env:MERCURY_INSTALL   Install prefix.    Default: $HOME\.mercury
#                          (~\.mercury-dev for the dev channel.)
#                          Binary lands at $env:MERCURY_INSTALL\bin\mercury.exe.
#                          (mercury-dev.exe on the dev channel.)
#   $env:MERCURY_NO_PATH   If "1", skip modifying user PATH.

#Requires -Version 5
$ErrorActionPreference = 'Stop'

$Repo     = 'cosmicstack-labs/mercury-agent'
$GhDl     = "https://github.com/$Repo/releases/download"

# ----- helpers ---------------------------------------------------------------

function Write-Info  ([string]$msg) { Write-Host "→ $msg" -ForegroundColor Green }
function Write-Warn2 ([string]$msg) { Write-Host "! $msg" -ForegroundColor Yellow }
function Die         ([string]$msg) { Write-Host "x $msg" -ForegroundColor Red; exit 1 }

function Get-MercuryArch {
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ([Environment]::Is64BitOperatingSystem) {
        if ($arch -eq 'ARM64') { return 'arm64' }
        return 'x64'
    }
    Die "32-bit Windows is not supported. Mercury ships x64 and arm64 binaries only."
}

function Resolve-LatestVersion {
    # The /releases/latest URL redirects to /releases/tag/vX.Y.Z. We follow it
    # without hitting the JSON API (no rate limits, no auth needed).
    $resp = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/latest" `
        -MaximumRedirection 5 -UseBasicParsing
    $final = $resp.BaseResponse.ResponseUri.AbsoluteUri
    if ($final -match '/tag/v?([0-9][^/]*)/?$') {
        return $Matches[1]
    }
    Die "Could not determine the latest Mercury version from $final"
}

function Get-RequiredChecksum ([string]$Checksums, [string]$Asset) {
    $matches = @($Checksums -split "`r?`n" |
        Where-Object { $_ -match "^[a-fA-F0-9]{64}\s+$([regex]::Escape($Asset))\s*$" } |
        ForEach-Object { ($_ -split '\s+')[0] })
    if ($matches.Count -ne 1) {
        Die "checksums.txt must contain exactly one checksum for $Asset"
    }
    return $matches[0].ToLower()
}

function Save-VerifiedAsset ([string]$Uri, [string]$Path, [string]$ExpectedHash, [string]$Asset) {
    $actualHash = ''
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        $downloadUri = $Uri
        if ($attempt -gt 1) {
            $separator = if ($Uri.Contains('?')) { '&' } else { '?' }
            $downloadUri = "$Uri${separator}cacheBust=$([guid]::NewGuid().ToString('N'))"
        }

        try {
            Invoke-WebRequest -Uri $downloadUri -OutFile $Path -UseBasicParsing `
                -Headers @{ 'Cache-Control' = 'no-cache' }
        } catch {
            if ($attempt -eq 2) { Die "Failed to download $Asset from $Uri" }
            Write-Warn2 "Download failed for $Asset; retrying without cache..."
            continue
        }

        $actualHash = (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLower()
        if ($actualHash -eq $ExpectedHash) { return }

        Remove-Item $Path -Force -ErrorAction SilentlyContinue
        if ($attempt -eq 1) {
            Write-Warn2 "Checksum mismatch for $Asset; retrying without cache..."
        }
    }

    Die "Checksum mismatch for $Asset`n   expected: $ExpectedHash`n   actual:   $actualHash"
}

function Update-UserPath ([string]$BinDir) {
    if ($env:MERCURY_NO_PATH -eq '1') { return $false }

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($null -eq $userPath) { $userPath = '' }

    # Normalize for comparison so we don't add duplicates.
    $entries = $userPath -split ';' | Where-Object { $_ -ne '' }
    foreach ($e in $entries) {
        if ($e.TrimEnd('\') -ieq $BinDir.TrimEnd('\')) {
            Write-Info "PATH already contains $BinDir"
            return $false
        }
    }

    $newPath = if ($userPath -eq '') { $BinDir } else { "$BinDir;$userPath" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    # Also update the current session so the user can run `mercury` immediately.
    $env:Path = "$BinDir;$env:Path"
    Write-Info "Added $BinDir to your user PATH"
    return $true
}

# ----- main ------------------------------------------------------------------

# Channel: stable (default) vs dev. The dev channel tracks the rolling
# `mercury-dev-latest` PRE-release (never shown to stable users) and installs
# as mercury-dev.exe in ~\.mercury-dev, so both channels coexist.
$IsDev = ($env:MERCURY_CHANNEL -eq 'dev')

Write-Host ''
Write-Host '☿ Mercury installer' -ForegroundColor White
Write-Host '   Soul-driven AI agent · https://mercuryagent.sh'
Write-Host ''
if ($IsDev) {
    Write-Warn2 'Dev channel — unstable preview builds.'
    Write-Host ("  Installs as {0}\bin\mercury-dev.exe (coexists with stable)." -f (Join-Path $HOME '.mercury-dev'))
    Write-Host ''
}

$arch = Get-MercuryArch
Write-Info "Detected platform: win-$arch"

if ($IsDev) {
    $releaseDir = "$GhDl/mercury-dev-latest"
    $versionLabel = 'dev (rolling mercury-dev-latest)'
} else {
    $version = $env:MERCURY_VERSION
    if ([string]::IsNullOrEmpty($version)) {
        Write-Info 'Resolving latest version from GitHub...'
        $version = Resolve-LatestVersion
    }
    $releaseDir = "$GhDl/v$version"
    $versionLabel = "v$version"
}
Write-Info "Installing Mercury $versionLabel"

# Mercury's release naming for Windows: mercury-win-x64.exe (no arm64 build yet).
if ($arch -ne 'x64') {
    Die "Mercury does not currently ship a Windows $arch binary. Latest available: win-x64."
}

$asset = "mercury-win-x64.exe"
$url   = "$releaseDir/$asset"

$prefix = $env:MERCURY_INSTALL
if ([string]::IsNullOrEmpty($prefix)) {
    $prefix = if ($IsDev) { Join-Path $HOME '.mercury-dev' } else { Join-Path $HOME '.mercury' }
}
$binDir  = Join-Path $prefix 'bin'
$binName = if ($IsDev) { 'mercury-dev.exe' } else { 'mercury.exe' }
$binPath = Join-Path $binDir $binName

$tmpDir = Join-Path $env:TEMP ("mercury-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpDir | Out-Null
$binaryTmp = Join-Path $tmpDir $asset
$webTmp = Join-Path $tmpDir 'web.tar.gz'
$stageDir = Join-Path $tmpDir 'stage'

try {
    $checksumsUrl = "$releaseDir/checksums.txt"
    Write-Info 'Downloading checksums.txt ...'
    try {
        $checksums = (Invoke-WebRequest -Uri $checksumsUrl -UseBasicParsing).Content
    } catch {
        Die "Failed to download required checksums from $checksumsUrl"
    }
    $expectedBinary = Get-RequiredChecksum -Checksums $checksums -Asset $asset
    $expectedWeb = Get-RequiredChecksum -Checksums $checksums -Asset 'web.tar.gz'

    Write-Info "Downloading $asset ..."
    Save-VerifiedAsset -Uri $url -Path $binaryTmp -ExpectedHash $expectedBinary -Asset $asset

    $webTarUrl = "$releaseDir/web.tar.gz"
    Write-Info 'Downloading web.tar.gz ...'
    Save-VerifiedAsset -Uri $webTarUrl -Path $webTmp -ExpectedHash $expectedWeb -Asset 'web.tar.gz'
    Write-Info 'Checksums verified (sha256)'

    $archiveEntries = @(tar -tzf $webTmp)
    if ($LASTEXITCODE -ne 0) { Die 'Failed to inspect web.tar.gz' }
    foreach ($entry in $archiveEntries) {
        # AppleDouble sidecars (._*, macOS tar's xattr artifact — invisible to
        # bsdtar, listed by GNU tar) are inert; the extraction stage discards
        # them. Traversal attempts stay fatal.
        if (($entry -notmatch '^web(/|$)' -and $entry -notmatch '^\._') -or $entry -match '(^|/)\.\.(/|$)') {
            Die "web.tar.gz contains an unsafe path: $entry"
        }
    }
    New-Item -ItemType Directory -Path $stageDir | Out-Null
    tar -xzf $webTmp -C $stageDir
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $stageDir 'web') -PathType Container)) {
        Die 'Failed to extract the required web directory from web.tar.gz'
    }

    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    # Windows cannot overwrite a running executable; surface that error.
    if (Test-Path $binPath) { Remove-Item $binPath -Force }
    Move-Item -Path $binaryTmp -Destination $binPath -Force
    $webDir = Join-Path $binDir 'web'
    if (Test-Path $webDir) { Remove-Item $webDir -Recurse -Force }
    Move-Item -Path (Join-Path $stageDir 'web') -Destination $webDir
    Write-Info 'Web dashboard assets installed'
}
finally {
    Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Info "Installed to $binPath"

$pathUpdated = Update-UserPath -BinDir $binDir

Write-Host ''
Write-Host "✓ Mercury $versionLabel is ready." -ForegroundColor Green
Write-Host ''

if ($pathUpdated) {
    Write-Warn2 'Open a new terminal for the PATH change to take effect.'
    Write-Host ''
}

Write-Host 'Get started:'
Write-Host "   $binPath --help"
if ($pathUpdated) {
    Write-Host "   $binName              # first run launches setup wizard"
} else {
    Write-Host "   $binPath              # first run launches setup wizard"
}
if ($IsDev) {
    Write-Warn2 'Dev channel — preview builds, may break. Re-run this script to update.'
}
Write-Host ''
