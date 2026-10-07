# Mercury DEV-channel installer for Windows.
#
#   irm https://mercuryagent.sh/install-dev.ps1 | iex
#
# Installs the rolling `mercury-dev-latest` GitHub pre-release as
# mercury-dev.exe under ~\.mercury-dev — it coexists with a stable install
# (mercury.exe under ~\.mercury) on the same machine. Re-run to update.
#
# This is a thin wrapper around the stable installer with
# MERCURY_CHANNEL=dev; all logic lives in install.ps1 so the two never drift.

#Requires -Version 5
$ErrorActionPreference = 'Stop'

# Running from a checkout: prefer the sibling stable installer.
$sibling = Join-Path $PSScriptRoot 'install.ps1'
if (Test-Path $sibling) {
    $env:MERCURY_CHANNEL = 'dev'
    & $sibling
    return
}

# Otherwise pull the stable installer from the always-current site URL. The
# env var is set in this session, which iex executes inside.
$env:MERCURY_CHANNEL = 'dev'
Invoke-RestMethod -Uri 'https://mercuryagent.sh/install.ps1' | Invoke-Expression