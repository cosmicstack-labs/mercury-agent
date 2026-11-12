# Mercury installer for Windows.
#
#   irm https://mercuryagent.sh/install.ps1 | iex
#
# Environment variables:
#   $env:MERCURY_VERSION   Version to install (e.g. "1.1.9"). Default: latest.
#                          (Stable channel only - dev tracks the latest dev
#                          build.)
#   $env:MERCURY_CHANNEL   Distribution channel: "stable" (default) or "dev".
#   $env:MERCURY_INSTALL   Install prefix.    Default: $HOME\.mercury
#                          (~\.mercury-dev for the dev channel.)
#                          Binary lands at $env:MERCURY_INSTALL\bin\mercury.exe.
#                          (mercury-dev.exe on the dev channel.)
#   $env:MERCURY_NO_PATH   If "1", skip modifying user PATH.
#   $env:MERCURY_DOWNLOAD_BASE  Base URL the release assets are fetched from
#                          (default: GitHub Releases). Used by CI.
#   $env:MERCURY_NO_PAUSE  If "1", a failure exits without waiting for Enter.

#Requires -Version 5
$ErrorActionPreference = 'Stop'

$Repo     = 'cosmicstack-labs/mercury-agent'
$GhDl     = if ($env:MERCURY_DOWNLOAD_BASE) { $env:MERCURY_DOWNLOAD_BASE.TrimEnd('/') } else { "https://github.com/$Repo/releases/download" }

# ----- helpers ---------------------------------------------------------------

function Write-Info  ([string]$msg) { Write-Host "-> $msg" -ForegroundColor Green }
function Write-Warn2 ([string]$msg) { Write-Host "! $msg" -ForegroundColor Yellow }
function Die ([string]$msg) {
    Write-Host "x $msg" -ForegroundColor Red
    # "irm ... | iex" from a fresh console closes the window on exit, so the
    # error was unreadable. Wait for Enter when a person is watching.
    if ($env:MERCURY_NO_PAUSE -ne '1' -and [Environment]::UserInteractive -and $Host.Name -eq 'ConsoleHost') {
        try { $null = Read-Host 'Press Enter to close' } catch { }
    }
    exit 1
}

function Get-MercuryArch {
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ([Environment]::Is64BitOperatingSystem) {
        if ($arch -eq 'ARM64') { return 'arm64' }
        return 'x64'
    }
    Die "32-bit Windows is not supported. Mercury ships x64 and arm64 binaries only."
}

function Resolve-LatestVersion ([uri]$LatestUri = "https://github.com/$Repo/releases/latest") {
    # PowerShell 5.1 exposes HttpWebResponse.ResponseUri; PowerShell 7 uses
    # HttpResponseMessage.RequestMessage.RequestUri after following redirects.
    $resp = Invoke-WebRequest -Uri $LatestUri -MaximumRedirection 5 -UseBasicParsing
    $final = $resp.BaseResponse.ResponseUri
    if (-not $final) { $final = $resp.BaseResponse.RequestMessage.RequestUri }
    $final = [uri]$final
    $tagPrefix = $LatestUri.AbsolutePath -replace '/latest/?$', '/tag/'
    $tagPattern = '^' + [regex]::Escape($tagPrefix) + 'v?([0-9][0-9A-Za-z.+-]*)/?$'
    if ($final -and $final.IsAbsoluteUri -and $final.Scheme -eq $LatestUri.Scheme -and
        $final.Authority -eq $LatestUri.Authority -and -not $final.UserInfo -and
        -not $final.Query -and -not $final.Fragment -and $final.AbsolutePath -match $tagPattern) {
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
Write-Host 'Mercury installer' -ForegroundColor White
Write-Host '   Soul-driven AI agent - https://mercuryagent.sh'
Write-Host ''
if ($IsDev) {
    Write-Warn2 'Dev channel - unstable preview builds.'
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
# MERCURY_ASSET forces a build (support use); mercury-win-x64-baseline.exe runs on CPUs without AVX2.
if ($env:MERCURY_ASSET) { $asset = $env:MERCURY_ASSET }
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
        # Windows PowerShell 5.1 returns a byte[] in .Content for
        # application/octet-stream (what GitHub serves checksums.txt as);
        # splitting that yields the literal "System.Byte[]" and no checksum
        # ever matches. Decode it ourselves; PowerShell 7 already hands a string.
        $raw = (Invoke-WebRequest -Uri $checksumsUrl -UseBasicParsing).Content
        $checksums = if ($raw -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($raw) } else { [string]$raw }
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
        # AppleDouble sidecars (._*, macOS tar's xattr artifact - invisible to
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

    $candidateBin = Join-Path $stageDir $binName
    Move-Item -Path $binaryTmp -Destination $candidateBin
    try {
        $smoke = & $candidateBin --version 2>&1
        $smokeExit = $LASTEXITCODE
    } catch { Die "The downloaded binary could not start; the previous installation was preserved: $_" }
    # STATUS_ILLEGAL_INSTRUCTION on CPUs without AVX2: validate the baseline
    # too, before replacing either artifact in a working installation.
    if ($smokeExit -ne 0 -and $asset -ne 'mercury-win-x64-baseline.exe' -and ($smokeExit -eq -1073741795 -or $smokeExit -eq 3221225501)) {
        Write-Info 'This CPU cannot run the default build (illegal instruction) - switching to the baseline build'
        $asset = 'mercury-win-x64-baseline.exe'
        $expected = Get-RequiredChecksum -Checksums $checksums -Asset $asset
        Save-VerifiedAsset -Uri "$releaseDir/$asset" -Path $candidateBin -ExpectedHash $expected -Asset $asset
        try {
            $smoke = & $candidateBin --version 2>&1
            $smokeExit = $LASTEXITCODE
        } catch { Die "The baseline binary could not start; the previous installation was preserved: $_" }
    }
    if ($smokeExit -ne 0) {
        Die "Mercury $versionLabel cannot run on this machine; the previous installation was preserved: $smoke"
    }
    Write-Info "Smoke test passed: $binName --version -> $smoke"

    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    # Windows cannot overwrite a running executable. `mercury upgrade` hands
    # us its own PID in MERCURY_WAIT_PID: wait for it to exit (not a fixed
    # sleep). Then wait for any other process still running the old binary
    # (a daemon that has not finished its graceful shutdown yet).
    if ($env:MERCURY_WAIT_PID) {
        $waitPid = 0
        if ([int]::TryParse($env:MERCURY_WAIT_PID, [ref]$waitPid) -and $waitPid -gt 0) {
            Write-Info "Waiting for Mercury (PID $waitPid) to exit..."
            Wait-Process -Id $waitPid -Timeout 60 -ErrorAction SilentlyContinue
        }
    }
    if (Test-Path $binPath) {
        $holders = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
            try { $_.Path -and ([IO.Path]::GetFullPath($_.Path) -ieq [IO.Path]::GetFullPath($binPath)) } catch { $false }
        })
        if ($holders.Count -gt 0) {
            Write-Info ("Waiting for running Mercury (PID {0}) to exit..." -f ($holders.Id -join ', '))
            $holders | Wait-Process -Timeout 30 -ErrorAction SilentlyContinue
            $still = @($holders | Where-Object { -not $_.HasExited })
            if ($still.Count -gt 0) {
                Die ("Mercury is still running (PID {0}). Run `mercury stop` and re-run the installer." -f ($still.Id -join ', '))
            }
        }
    }
    # Backups stay on the installation's filesystem until both moves succeed.
    # If recovery itself fails, retain those files and report their location.
    $backupDir = Join-Path $binDir ('.mercury-install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $backupDir | Out-Null
    $previousBinary = Join-Path $backupDir 'previous-binary'
    $previousWeb = Join-Path $backupDir 'previous-web'
    $webDir = Join-Path $binDir 'web'
    $binaryPromoted = $false
    $webPromoted = $false
    try {
        # Finish any cross-volume copy before moving the old installation.
        $candidateDir = Join-Path $backupDir 'candidate'
        Move-Item -Path $stageDir -Destination $candidateDir
        $candidateBin = Join-Path $candidateDir $binName
        if (Test-Path $binPath) { Move-Item -Path $binPath -Destination $previousBinary }
        if (Test-Path $webDir) { Move-Item -Path $webDir -Destination $previousWeb }
        Move-Item -Path $candidateBin -Destination $binPath
        $binaryPromoted = $true
        Move-Item -Path (Join-Path $candidateDir 'web') -Destination $webDir
        $webPromoted = $true
    } catch {
        $promotionError = $_
        $restoreFailed = $false
        foreach ($part in @(
            @{ Target = $binPath; Backup = $previousBinary; Promoted = $binaryPromoted },
            @{ Target = $webDir; Backup = $previousWeb; Promoted = $webPromoted }
        )) {
            try {
                if ($part.Promoted) { Remove-Item -LiteralPath $part.Target -Recurse -Force }
                if (Test-Path $part.Backup) { Move-Item -Path $part.Backup -Destination $part.Target }
            } catch { $restoreFailed = $true }
        }
        if ($restoreFailed) {
            Write-Warn2 "Could not fully restore the previous installation. Recovery files: $backupDir"
        } else {
            Remove-Item -LiteralPath $backupDir -Recurse -Force
        }
        throw $promotionError
    }
    Remove-Item -LiteralPath $backupDir -Recurse -Force
    Write-Info 'Web dashboard assets installed'
}
finally {
    Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Info "Installed to $binPath"

$pathUpdated = Update-UserPath -BinDir $binDir

Write-Host ''
Write-Host "OK Mercury $versionLabel is ready." -ForegroundColor Green
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
    Write-Warn2 'Dev channel - preview builds, may break. Re-run this script to update.'
}
Write-Host ''
