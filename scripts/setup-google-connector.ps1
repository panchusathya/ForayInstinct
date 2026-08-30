<#
.SYNOPSIS
Create and attach the Vercel Connect Google connector this app authenticates
users through, then report what is left to do on the Google side.

.DESCRIPTION
The Windows counterpart of scripts/setup-google-connector.sh, for PowerShell.
It needs no bash and no jq: PowerShell reshapes the credential JSON itself.

Vercel expects top-level clientId and clientSecret keys, not Google's nested
web.client_id and web.client_secret download, so the download is reshaped into a
temporary file under your per-user temp directory, handed to Vercel, and deleted
on exit. Neither file is ever written into the repository.

Re-running is safe: an existing connector is reused, an existing attachment is
reported rather than duplicated, and an existing GOOGLE_CONNECTOR_UID is left
alone.

.PARAMETER CredentialsPath
The client-secret JSON downloaded from Google Cloud.

.PARAMETER Environments
Vercel environments to attach. Defaults to production and preview; a production
attachment does not enable preview or local development.

.PARAMETER ConnectorName
The connector name. Defaults to open-instinct, which the app falls back to when
GOOGLE_CONNECTOR_UID is unset.

.EXAMPLE
.\scripts\setup-google-connector.ps1 ~\Downloads\client_secret_1234.json
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string] $CredentialsPath,

  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]] $Environments = @('production', 'preview'),

  [string] $ConnectorName = 'open-instinct'
)

$ErrorActionPreference = 'Stop'

$connectorUid = "google/$ConnectorName"
$repoRoot = Split-Path -Parent $PSScriptRoot
$scopesFile = Join-Path $repoRoot 'lib\google-workspace\config.ts'

if (-not (Test-Path -LiteralPath $CredentialsPath)) {
  throw "No such file: $CredentialsPath"
}
if (-not (Get-Command vercel -ErrorAction SilentlyContinue)) {
  throw 'vercel CLI not found. Install it with: npm i -g vercel'
}

$credentials = Get-Content -LiteralPath $CredentialsPath -Raw | ConvertFrom-Json
$client = if ($credentials.web) { $credentials.web } else { $credentials.installed }
if (-not $client.client_id -or -not $client.client_secret) {
  throw "$CredentialsPath has no web.client_id/web.client_secret. Download the OAuth *web* client JSON from Google Cloud."
}

Push-Location $repoRoot
# The temp file lives under the per-user temp directory and is removed in the
# finally block, whether this succeeds, throws, or is interrupted.
$connectorData = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
try {
  if (-not (Test-Path -LiteralPath (Join-Path $repoRoot '.vercel\project.json'))) {
    Write-Host '==> Linking this directory to a Vercel project'
    vercel link
  }

  $payload = [ordered]@{
    clientId     = $client.client_id
    clientSecret = $client.client_secret
  } | ConvertTo-Json
  # A UTF-8 BOM would make Vercel reject the payload, so write without one.
  [System.IO.File]::WriteAllText(
    $connectorData, $payload, (New-Object System.Text.UTF8Encoding $false))

  $existing = (vercel connect list 2>$null | Out-String)
  if ($existing -match [regex]::Escape($connectorUid)) {
    Write-Host "==> Connector $connectorUid already exists, reusing it"
  }
  else {
    Write-Host "==> Creating connector $connectorUid"
    vercel connect create google --connection-method oauth --name $ConnectorName --data "@$connectorData"
    if ($LASTEXITCODE -ne 0) { throw "vercel connect create failed with exit code $LASTEXITCODE" }
  }

  foreach ($environment in $Environments) {
    Write-Host "==> Attaching $connectorUid to $environment"
    vercel connect attach $connectorUid --environment $environment --yes
    if ($LASTEXITCODE -ne 0) {
      Write-Host "    (already attached to $environment, or the attach was rejected - see above)"
    }
  }

  # The app falls back to google/open-instinct, so the variable only has to be
  # set when the connector carries another name. Setting it anyway keeps the
  # deployed value explicit rather than implied.
  $envList = (vercel env ls 2>$null | Out-String)
  if ($envList -match 'GOOGLE_CONNECTOR_UID') {
    Write-Host '==> GOOGLE_CONNECTOR_UID is already set; leaving it alone.'
    Write-Host "    It must equal $connectorUid. If it does not:"
    Write-Host '      vercel env rm GOOGLE_CONNECTOR_UID <environment>'
    Write-Host '      then re-run this script.'
  }
  else {
    foreach ($environment in $Environments) {
      Write-Host "==> Setting GOOGLE_CONNECTOR_UID for $environment"
      $connectorUid | vercel env add GOOGLE_CONNECTOR_UID $environment
    }
  }

  Write-Host ''
  Write-Host '==> Connectors now on this project'
  vercel connect list

  $scopes = @()
  $config = Get-Content -LiteralPath $scopesFile -Raw
  if ($config -match '(?s)GOOGLE_WORKSPACE_SCOPES = \[(.*?)\] as const;') {
    $scopes = [regex]::Matches($Matches[1], '"([^"]+)"') |
      ForEach-Object { '     ' + $_.Groups[1].Value }
  }

  Write-Host @"

Connector $connectorUid is set up. Two things finish the job:

1. Redeploy so the deployment picks up GOOGLE_CONNECTOR_UID:

     vercel deploy --prod

2. On the Google Cloud OAuth consent screen, the app's own scope list must be
   declared, and while publishing status is Testing your Google account must be
   listed under Test users. Until it is, the Connect button appears and Google
   then blocks consent. The scopes this app requests:

$($scopes -join "`n")

   The OAuth client also needs https://connect.vercel.com/callback as an
   authorized redirect URI, and the Gmail, Calendar, and People APIs enabled.

Then hard-refresh Workspace. It should read Connect, not Setup required. If it
still reads Setup required, the deployment's runtime logs now name the reason:

     vercel logs --prod | Select-String google-workspace
"@
}
finally {
  Remove-Item -LiteralPath $connectorData -Force -ErrorAction SilentlyContinue
  Pop-Location
}
