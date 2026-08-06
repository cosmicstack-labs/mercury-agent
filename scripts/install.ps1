# Mercury installer for Windows.
#
#   irm https://mercuryagent.sh/install.ps1 | iex
#
# Environment variables:
#   $env:MERCURY_VERSION   Version to install (e.g. "1.1.9"). Default: latest.
#   $env:MERCURY_INSTALL   Install prefix.    Default: $HOME\.mercury
#                          Binary lands at $env:MERCURY_INSTALL\bin\mercury.exe.
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

Write-Host ''
Write-Host '☿ Mercury installer' -ForegroundColor White
Write-Host '   Soul-driven AI agent · https://mercuryagent.sh'
Write-Host ''

$arch = Get-MercuryArch
Write-Info "Detected platform: win-$arch"

$version = $env:MERCURY_VERSION
if ([string]::IsNullOrEmpty($version)) {
    Write-Info 'Resolving latest version from GitHub...'
    $version = Resolve-LatestVersion
}
Write-Info "Installing Mercury v$version"

# Mercury's release naming for Windows: mercury-win-x64.exe (no arm64 build yet).
if ($arch -ne 'x64') {
    Die "Mercury does not currently ship a Windows $arch binary. Latest available: win-x64."
}

$asset = "mercury-win-x64.exe"
$url   = "$GhDl/v$version/$asset"

$prefix = $env:MERCURY_INSTALL
if ([string]::IsNullOrEmpty($prefix)) { $prefix = Join-Path $HOME '.mercury' }
$binDir  = Join-Path $prefix 'bin'
$binPath = Join-Path $binDir 'mercury.exe'

New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$tmp = Join-Path $env:TEMP ("mercury-" + [guid]::NewGuid().ToString('N') + '.exe')

Write-Info "Downloading $asset ..."
try {
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
}
catch {
    Die @"
Failed to download $url
   The binary for v$version on win-x64 may not have been published yet.
   Browse releases: https://github.com/$Repo/releases
"@
}

# Optional sha256 verification against the release's checksums.txt.
try {
    $checksumsUrl = "$GhDl/v$version/checksums.txt"
    $checksums    = (Invoke-WebRequest -Uri $checksumsUrl -UseBasicParsing).Content
    $expected = ($checksums -split "`n" |
                 Where-Object { $_ -match "\s+$([regex]::Escape($asset))\s*$" } |
                 ForEach-Object { ($_ -split '\s+')[0] } |
                 Select-Object -First 1)
    if ($expected) {
        $actual = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash.ToLower()
        if ($actual -ne $expected.ToLower()) {
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
            Die "Checksum mismatch for $asset`n   expected: $expected`n   actual:   $actual"
        }
        Write-Info 'Checksum verified (sha256)'
    }
}
catch {
    # checksums.txt is optional — fall through silently.
}

# Replace any existing install (Windows can't overwrite a running .exe — let
# Move-Item surface that error if it happens, so the user knows to stop it).
if (Test-Path $binPath) { Remove-Item $binPath -Force }
Move-Item -Path $tmp -Destination $binPath -Force

# Download web dashboard assets (required for the web UI).
$webTarUrl = "$GhDl/v$version/web.tar.gz"
$webTmp = Join-Path $env:TEMP ("mercury-web-" + [guid]::NewGuid().ToString('N') + '.tar.gz')
try {
    Invoke-WebRequest -Uri $webTarUrl -OutFile $webTmp -UseBasicParsing
    $webDir = Join-Path $binDir 'web'
    New-Item -ItemType Directory -Force -Path $webDir | Out-Null
    tar -xzf $webTmp -C $binDir 2>$null
    Write-Info 'Web dashboard assets installed'
}
catch {
    Write-Warn2 'Web dashboard assets not found for v'"$version — web UI will not work"
}
finally {
    Remove-Item $webTmp -Force -ErrorAction SilentlyContinue
}

Write-Info "Installed to $binPath"

$pathUpdated = Update-UserPath -BinDir $binDir

Write-Host ''
Write-Host "✓ Mercury v$version is ready." -ForegroundColor Green
Write-Host ''

if ($pathUpdated) {
    Write-Warn2 'Open a new terminal for the PATH change to take effect.'
    Write-Host ''
}

Write-Host 'Get started:'
Write-Host "   $binPath --help"
if ($pathUpdated) {
    Write-Host '   mercury              # first run launches setup wizard'
} else {
    Write-Host "   $binPath              # first run launches setup wizard"
}
Write-Host ''
