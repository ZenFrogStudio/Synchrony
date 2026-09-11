<#
.SYNOPSIS
  Starts the Chronos hub and a public HTTPS tunnel to it, and prints the URL
  to paste into claude.ai as the "Chronos Hub" custom connector.

.DESCRIPTION
  One command instead of three. Runs from the Chronos repo root:

    npm run hub:up                       (default root D:\03-Software)
    npm run hub:up -- -Root E:\projects  (another root)

  Builds dist\hub.js if it is missing, starts the hub on 127.0.0.1:7433,
  starts a Cloudflare quick tunnel to it, reads the tunnel host from
  cloudflared's output and prints the connector URL. Ctrl+C stops both.

  A quick tunnel gets a new random host every start, so the connector URL
  changes every restart. For a fixed URL use a named Cloudflare tunnel or
  Tailscale Funnel and run `npm run hub` on its own.
#>
param(
  [string]$Root = 'D:\03-Software',
  [int]$Port = 7433
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Say($text) { Write-Host "[hub-up] $text" }

# ---- prerequisites ---------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'node is not on PATH.'
}
if (-not (Test-Path 'dist\hub.js')) {
  Say 'dist\hub.js is missing; building (npm run compile)...'
  npm run compile | Out-Null
  if (-not (Test-Path 'dist\hub.js')) { throw 'build did not produce dist\hub.js' }
}
$cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflared) {
  Say 'cloudflared is not installed. Install it, then run this again:'
  Say '    winget install Cloudflare.cloudflared'
  Say 'Starting the hub without a tunnel so you can at least check http://127.0.0.1:' + $Port + '/healthz'
}

# ---- hub -------------------------------------------------------------------
Say "starting hub for $Root on 127.0.0.1:$Port"
$hub = Start-Process -FilePath node -ArgumentList @('dist\hub.js', '--root', $Root, '--port', $Port) `
  -NoNewWindow -PassThru -RedirectStandardError "$env:TEMP\chronos-hub.err.log"

Start-Sleep -Seconds 2
try {
  $health = Invoke-RestMethod "http://127.0.0.1:$Port/healthz" -TimeoutSec 5
  Say "hub is up: version $($health.version), $($health.instances) instance(s)"
} catch {
  Get-Content "$env:TEMP\chronos-hub.err.log" -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" }
  Stop-Process -Id $hub.Id -ErrorAction SilentlyContinue
  throw "hub did not answer on port $Port"
}

$tokenFile = Join-Path $env:USERPROFILE '.chronos-dashboard\hub.token'
$token = (Get-Content $tokenFile -Raw).Trim()

if (-not $cloudflared) {
  Say "local connector URL (not reachable from claude.ai without a tunnel): http://127.0.0.1:$Port/$token/mcp"
  Say 'press Ctrl+C to stop the hub'
  try { Wait-Process -Id $hub.Id } finally { Stop-Process -Id $hub.Id -ErrorAction SilentlyContinue }
  exit
}

# ---- tunnel ----------------------------------------------------------------
Say 'starting Cloudflare quick tunnel...'
$tunnelLog = "$env:TEMP\chronos-tunnel.log"
Remove-Item $tunnelLog -ErrorAction SilentlyContinue
$tunnel = Start-Process -FilePath $cloudflared.Source `
  -ArgumentList @('tunnel', '--url', "http://127.0.0.1:$Port", '--no-autoupdate') `
  -NoNewWindow -PassThru -RedirectStandardError $tunnelLog

$host_ = $null
for ($i = 0; $i -lt 30 -and -not $host_; $i++) {
  Start-Sleep -Seconds 1
  $line = Get-Content $tunnelLog -ErrorAction SilentlyContinue | Select-String -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
  if ($line) { $host_ = $line.Matches[0].Value }
}
if (-not $host_) {
  Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue
  Stop-Process -Id $hub.Id -ErrorAction SilentlyContinue
  Get-Content $tunnelLog -ErrorAction SilentlyContinue | Select-Object -Last 10 | ForEach-Object { Write-Host "  $_" }
  throw 'cloudflared did not report a tunnel URL within 30 s'
}

$connector = "$host_/$token/mcp"
Write-Host ''
Write-Host '  ====================================================================='
Write-Host '  Chronos Hub connector URL (claude.ai -> Settings -> Connectors -> Add):'
Write-Host "  $connector"
Write-Host '  Name it exactly:  Chronos Hub     Leave the OAuth fields empty.'
Write-Host '  ====================================================================='
Write-Host ''
Set-Content -Path (Join-Path $env:USERPROFILE '.chronos-dashboard\hub.connector-url') -Value $connector
Say "also written to $env:USERPROFILE\.chronos-dashboard\hub.connector-url"

try {
  npx --yes qrcode-terminal $connector 2>$null
  Say 'Scan or paste this URL into the Chronos phone app.'
} catch {
  # No npx / no network — the printed URL above still works, just without the QR aid.
}

Say 'both processes are running; press Ctrl+C to stop'

try {
  Wait-Process -Id $hub.Id
} finally {
  Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue
  Stop-Process -Id $hub.Id -ErrorAction SilentlyContinue
  Say 'stopped'
}
