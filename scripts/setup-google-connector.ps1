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

$script:VercelExitCode = 0

<#
Run the Vercel CLI without letting its output abort the script.

The CLI writes its version banner to stderr on every call. Under
ErrorActionPreference=Stop, PowerShell promotes native-command stderr to a
terminating NativeCommandError, so a command that succeeded still kills the
run. Exit codes decide success here, not stderr.

-Capture returns the combined output as strings to match against; without it
the command keeps the console, which interactive commands like `vercel link`
need in order to prompt.
#>
function Invoke-Vercel {
  param(
    [Parameter(Mandatory = $true)] [string[]] $Arguments,
    [switch] $Capture,
    [string] $StdIn
  )

  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($StdIn) {
      $output = $StdIn | & vercel @Arguments 2>&1 | ForEach-Object { "$_" }
    }
    elseif ($Capture) {
      $output = & vercel @Arguments 2>&1 | ForEach-Object { "$_" }
    }
    else {
      & vercel @Arguments
      $output = @()
    }
    $script:VercelExitCode = $LASTEXITCODE
    return $output
  }
  finally {
    $ErrorActionPreference = $previous
  }
}

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
    Invoke-Vercel -Arguments @('link')
    if ($script:VercelExitCode -ne 0) {
      throw "vercel link failed with exit code $script:VercelExitCode"
    }
  }

  $payload = [ordered]@{
    clientId     = $client.client_id
    clientSecret = $client.client_secret
  } | ConvertTo-Json
  # A UTF-8 BOM would make Vercel reject the payload, so write without one.
  [System.IO.File]::WriteAllText(
    $connectorData, $payload, (New-Object System.Text.UTF8Encoding $false))

  # An empty connector list exits non-zero on some CLI versions, so the exit
  # code is deliberately not checked here; absence just means "create it".
  $existing = (Invoke-Vercel -Arguments @('connect', 'list') -Capture) -join "`n"
  if ($existing -match [regex]::Escape($connectorUid)) {
    Write-Host "==> Connector $connectorUid already exists, reusing it"
  }
  else {
    Write-Host "==> Creating connector $connectorUid"
    Invoke-Vercel -Capture -Arguments @(
      'connect', 'create', 'google',
      '--connection-method', 'oauth',
      '--name', $ConnectorName,
      '--data', "@$connectorData"
    ) | Write-Host
    if ($script:VercelExitCode -ne 0) {
      throw "vercel connect create failed with exit code $script:VercelExitCode"
    }
  }

  foreach ($environment in $Environments) {
    Write-Host "==> Attaching $connectorUid to $environment"
    Invoke-Vercel -Capture -Arguments @(
      'connect', 'attach', $connectorUid, '--environment', $environment, '--yes'
    ) | Write-Host
    if ($script:VercelExitCode -ne 0) {
      Write-Host "    (already attached to $environment, or the attach was rejected - see above)"
    }
  }

  # The app falls back to google/open-instinct, so the variable only has to be
  # set when the connector carries another name. Setting it anyway keeps the
  # deployed value explicit rather than implied.
  $envList = (Invoke-Vercel -Arguments @('env', 'ls') -Capture) -join "`n"
  if ($envList -match 'GOOGLE_CONNECTOR_UID') {
    Write-Host '==> GOOGLE_CONNECTOR_UID is already set; leaving it alone.'
    Write-Host "    It must equal $connectorUid. If it does not:"
    Write-Host '      vercel env rm GOOGLE_CONNECTOR_UID <environment>'
    Write-Host '      then re-run this script.'
  }
  else {
    foreach ($environment in $Environments) {
      Write-Host "==> Setting GOOGLE_CONNECTOR_UID for $environment"
      Invoke-Vercel -StdIn $connectorUid -Arguments @(
        'env', 'add', 'GOOGLE_CONNECTOR_UID', $environment
      ) | Write-Host
    }
  }

  Write-Host ''
  Write-Host '==> Connectors now on this project'
  Invoke-Vercel -Arguments @('connect', 'list') -Capture | Write-Host

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
