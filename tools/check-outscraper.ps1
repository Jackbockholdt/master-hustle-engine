#Requires -Version 5.1
<#
  check-outscraper.ps1

  Dry-runs the Outscraper lead scrape against a running engine and reports the
  real yield: how many places came back, how many carried an email, where the
  rest were dropped, and how many would actually queue.

  Dry run means the engine does NOT write to the lead queue, does NOT spend
  email-validator credits, and does NOT send anything. Sending is governed
  separately by OUTBOUND_PAUSED and DAILY_SEND_CAP and is untouched here.

  It is NOT free: the Google Maps scrape itself bills Outscraper credits per
  place returned. Keep -Limit small. The script shows the worst-case place
  count and asks before spending anything.
#>

[CmdletBinding()]
param(
  [string]   $EngineUrl = 'https://master-hustle-engine.onrender.com',
  [string]   $AdminKey,
  [int]      $Limit     = 5,
  [string[]] $Queries,
  [switch]   $Yes
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Head($text) {
  Write-Host ''
  Write-Host ('=' * 62) -ForegroundColor DarkGray
  Write-Host "  $text" -ForegroundColor Cyan
  Write-Host ('=' * 62) -ForegroundColor DarkGray
}

function Write-Row($label, $value, $color = 'Gray') {
  Write-Host ('  {0,-24}' -f $label) -NoNewline
  Write-Host $value -ForegroundColor $color
}

Write-Head 'Outscraper dry run - yield check'

$EngineUrl = $EngineUrl.TrimEnd('/')
Write-Host "  Engine: $EngineUrl" -ForegroundColor DarkGray

# --- admin key -------------------------------------------------------------
if (-not $AdminKey) { $AdminKey = $env:ADMIN_KEY }
if (-not $AdminKey) {
  Write-Host ''
  Write-Host '  ADMIN_KEY is required (it gates /api/admin).' -ForegroundColor Yellow
  Write-Host '  Render dashboard -> master-hustle-engine -> Environment -> ADMIN_KEY' -ForegroundColor DarkGray
  Write-Host ''
  $secure = Read-Host '  Paste ADMIN_KEY (hidden)' -AsSecureString
  $AdminKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
if (-not $AdminKey) { Write-Host '  No key given - stopping.' -ForegroundColor Red; exit 1 }

# --- confirm the spend -----------------------------------------------------
$queryCount = if ($Queries) { $Queries.Count } else { 0 }
$worstCase  = if ($queryCount -gt 0) { $queryCount * $Limit } else { $Limit }
$scope      = if ($queryCount -gt 0) { "$queryCount query/queries x $Limit" } else { "the engine's configured OUTSCRAPER_QUERIES x $Limit each" }

Write-Host ''
Write-Host "  About to scrape: $scope" -ForegroundColor Yellow
if ($queryCount -gt 0) {
  Write-Host "  Worst case ~$worstCase places billed to your Outscraper account." -ForegroundColor Yellow
} else {
  Write-Host "  Worst case $Limit places PER configured query, billed to Outscraper." -ForegroundColor Yellow
}
Write-Host '  Nothing is queued and nothing is emailed.' -ForegroundColor DarkGray

if (-not $Yes) {
  $go = Read-Host '  Continue? (y/N)'
  if ($go -notmatch '^(y|yes)$') { Write-Host '  Cancelled.' -ForegroundColor DarkGray; exit 0 }
}

# --- call ------------------------------------------------------------------
$payload = @{ dry_run = $true; limit = $Limit }
if ($Queries) { $payload.queries = $Queries }
$body = $payload | ConvertTo-Json -Depth 4

Write-Host ''
Write-Host '  Scraping... (this can take a minute or two)' -ForegroundColor DarkGray

try {
  $r = Invoke-RestMethod -Method Post -Uri "$EngineUrl/admin/scrape-now" `
        -Headers @{ 'X-Admin-Key' = $AdminKey } `
        -ContentType 'application/json' -Body $body -TimeoutSec 600
}
catch {
  $resp   = $_.Exception.Response
  $status = if ($resp) { [int]$resp.StatusCode } else { 0 }
  $detail = ''
  if ($resp) {
    try {
      $sr = New-Object IO.StreamReader($resp.GetResponseStream())
      $detail = $sr.ReadToEnd()
    } catch { }
  }

  Write-Host ''
  switch ($status) {
    503 { Write-Host '  OUTSCRAPER_API_KEY is not set on the engine.' -ForegroundColor Red
          Write-Host '  Render -> Environment -> add OUTSCRAPER_API_KEY, then redeploy.' -ForegroundColor Yellow }
    400 { Write-Host '  No queries configured.' -ForegroundColor Red
          Write-Host '  Set OUTSCRAPER_QUERIES on the engine, or pass -Queries "seo agency, Austin, TX".' -ForegroundColor Yellow }
    409 { Write-Host '  A scrape is already running. Wait for it to finish.' -ForegroundColor Yellow }
    502 { Write-Host '  Outscraper rejected the request (credits, plan, or a bad query).' -ForegroundColor Red }
    401 { Write-Host '  ADMIN_KEY rejected.' -ForegroundColor Red }
    403 { Write-Host '  ADMIN_KEY rejected.' -ForegroundColor Red }
    0   { Write-Host "  Could not reach $EngineUrl" -ForegroundColor Red
          Write-Host '  Is the Render service awake?' -ForegroundColor Yellow }
    default { Write-Host "  HTTP $status" -ForegroundColor Red }
  }
  if ($detail) { Write-Host "  $detail" -ForegroundColor DarkGray }
  Write-Host ''
  exit 1
}

# --- report ----------------------------------------------------------------
$places = [int]$r.places
$mail   = [int]$r.with_email
$would  = [int]$r.would_queue
$pct    = if ($places -gt 0) { [math]::Round(100 * $mail / $places, 1) } else { 0 }
$endPct = if ($places -gt 0) { [math]::Round(100 * $would / $places, 1) } else { 0 }

Write-Head 'Result'
Write-Row 'Places returned'   $places
Write-Row 'Carried an email'  "$mail  ($pct% of places)"
Write-Host '  ---- dropped ----' -ForegroundColor DarkGray
Write-Row '  off-ICP'          ([int]$r.disqualified)
Write-Row '  low quality'      ([int]$r.low_quality)
Write-Row '  already contacted' ([int]$r.duplicate)
Write-Row '  do-not-contact'   ([int]$r.suppressed)
Write-Host ''

$verdict = if ($would -gt 0) { 'Green' } else { 'Red' }
Write-Row 'WOULD QUEUE' "$would  ($endPct% end-to-end)" $verdict
Write-Row 'Took' "$([int]$r.seconds)s" 'DarkGray'

if ($r.queue) {
  Write-Host ''
  Write-Row 'Queue now - pending' ([int]$r.queue.pending) 'DarkGray'
  Write-Row 'Queue now - sent'    ([int]$r.queue.sent)    'DarkGray'
}

if ($r.skipped -and $r.skipped.Count -gt 0) {
  Write-Head 'Why rows were dropped'
  $r.skipped | Group-Object reason | Sort-Object Count -Descending |
    Select-Object -First 12 | ForEach-Object {
      Write-Host ('  {0,4}x  {1}' -f $_.Count, $_.Name) -ForegroundColor DarkGray
    }
}

if ($r.sample -and $r.sample.Count -gt 0) {
  Write-Head "Would queue ($($r.sample.Count) shown)"
  $r.sample | ForEach-Object {
    Write-Host ("  {0}" -f $_.company) -ForegroundColor White
    Write-Host ("     {0}   {1}" -f $_.email, $_.website) -ForegroundColor DarkGray
  }
}

# --- read the result -------------------------------------------------------
Write-Head 'Reading this'
if ($places -eq 0) {
  Write-Host '  Outscraper returned nothing. Check the query wording and your credits.' -ForegroundColor Yellow
}
elseif ($would -eq 0 -and $mail -gt 0) {
  Write-Host '  Places had emails but none survived the screen.' -ForegroundColor Yellow
  Write-Host '  If the drop reasons above are mostly "generic mailbox", that is the' -ForegroundColor Gray
  Write-Host '  role-inbox gate. Set ALLOW_ROLE_MAILBOXES=true and redeploy.' -ForegroundColor Gray
}
elseif ($would -gt 0) {
  Write-Host "  Working. ~$endPct% of scraped places become queueable leads." -ForegroundColor Green
  Write-Host '  1-3% end-to-end is normal for Google Maps. Budget from that number,' -ForegroundColor Gray
  Write-Host '  not from the place count.' -ForegroundColor Gray
}
Write-Host ''
Write-Host '  Nothing was queued and nothing was emailed - this was a dry run.' -ForegroundColor DarkGray
Write-Host ''
