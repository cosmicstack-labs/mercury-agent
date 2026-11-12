#Requires -Version 5
param([string]$LatestUri)
$ErrorActionPreference = 'Stop'

# Load only the resolver function, never the installer's main routine.
$installer = Join-Path $PSScriptRoot 'install.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$null, [ref]$null)
$resolver = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Resolve-LatestVersion' }, $true)
. ([scriptblock]::Create($resolver.Extent.Text))
$Repo = 'cosmicstack-labs/mercury-agent'
function Die ([string]$msg) { throw $msg }
function Assert-Equal ($Actual, $Expected) {
    if ($Actual -ne $Expected) { throw "Expected '$Expected', received '$Actual'" }
}
function Invoke-WebRequest {
    param($Uri, $MaximumRedirection, [switch]$UseBasicParsing)
    Assert-Equal $Uri "https://github.com/$Repo/releases/latest"
    Assert-Equal $MaximumRedirection 5
    Assert-Equal $UseBasicParsing $true
    return $script:response
}

$tag = [uri]"https://github.com/$Repo/releases/tag/v9.9.9"
$script:response = [pscustomobject]@{ BaseResponse = [pscustomobject]@{ ResponseUri = $tag } }
Assert-Equal (Resolve-LatestVersion) '9.9.9'
$script:response = [pscustomobject]@{ BaseResponse = [pscustomobject]@{ RequestMessage = [pscustomobject]@{ RequestUri = $tag } } }
Assert-Equal (Resolve-LatestVersion) '9.9.9'

foreach ($badUri in @(
    $null,
    "https://example.com/$Repo/releases/tag/v9.9.9",
    "https://github.com/other/repo/releases/tag/v9.9.9",
    "https://github.com/$Repo/releases/latest",
    "https://github.com/$Repo/releases/tag/v9.9.9?untrusted=1",
    "https://github.com/$Repo/releases/tag/v9.9.9#fragment"
)) {
    $script:response = [pscustomobject]@{ BaseResponse = [pscustomobject]@{ RequestMessage = [pscustomobject]@{ RequestUri = $badUri } } }
    $rejected = $false
    try { Resolve-LatestVersion | Out-Null } catch { $rejected = $true }
    Assert-Equal $rejected $true
}
Remove-Item Function:Invoke-WebRequest

# Optional local fixture exercises this runtime's actual HTTP response type,
# including redirection, without fetching or installing a public release.
if ($LatestUri) { Assert-Equal (Resolve-LatestVersion -LatestUri $LatestUri) '9.9.9' }

$previousChannel = $env:MERCURY_CHANNEL
try {
    function Invoke-RestMethod {
        param($Uri)
        Assert-Equal $Uri 'https://mercuryagent.sh/install.ps1'
        return '$script:devRan = $env:MERCURY_CHANNEL'
    }
    $script:devRan = $null
    $wrapper = [scriptblock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'install-dev.ps1')))
    & $wrapper
    Assert-Equal $script:devRan 'dev'
} finally {
    $env:MERCURY_CHANNEL = $previousChannel
    Remove-Item Function:Invoke-RestMethod
}
Write-Output "Installer helper checks passed (PowerShell $($PSVersionTable.PSVersion))."
