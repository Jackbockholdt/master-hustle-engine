# ==============================================================================
# Master Hustle Engine - Multi-City Agency Outbound Batch Runner
# Targets: Austin, Miami, NYC, Atlanta, Denver
# ==============================================================================

$endpoint = "http://localhost:10000/api/intake/scrape-agencies"
$leadsPerBatch = 5
$delayBetweenBatchesSeconds = 120 # 2-minute cooldown to protect inbox reputation

$targets = @(
    @{ City = "Austin, TX";   Query = "AI automation agency, Austin, TX" },
    @{ City = "Miami, FL";    Query = "AI automation agency, Miami, FL" },
    @{ City = "New York, NY"; Query = "AI automation agency, New York, NY" },
    @{ City = "Atlanta, GA";  Query = "AI automation agency, Atlanta, GA" },
    @{ City = "Denver, CO";   Query = "AI automation agency, Denver, CO" }
)

Write-Host ">>> Checking engine health on port 10000..." -ForegroundColor Cyan
try {
    $health = Invoke-RestMethod -Uri "http://localhost:10000/api/health" -TimeoutSec 5
    if ($health.status -ne "ok") {
        Write-Warning "Health status is not 'ok'. Review server logs before continuing."
        exit
    }
    Write-Host ">>> Engine is live and healthy. Starting outreach batches.`n" -ForegroundColor Green
} catch {
    Write-Error "Could not reach http://localhost:10000. Ensure server.js is running."
    exit
}

$batchIndex = 1
foreach ($target in $targets) {
    Write-Host "====================================================" -ForegroundColor Yellow
    Write-Host "[$batchIndex/$($targets.Count)] Triggering batch: $($target.City)" -ForegroundColor Yellow
    Write-Host "Query: $($target.Query) | Target Limit: $leadsPerBatch" -ForegroundColor DarkGray

    $payload = @{
        query  = $target.Query
        limit  = $leadsPerBatch
        dryRun = $false
    } | ConvertTo-Json

    try {
        $response = Invoke-RestMethod -Uri $endpoint -Method POST -ContentType "application/json" -Body $payload
        
        $processed = if ($response.processedLeads) { $response.processedLeads.Count } else { 0 }
        $sent = if ($response.emailsDispatched -ne $null) { $response.emailsDispatched } else { "N/A" }
        $paused = if ($response.outboundPaused -ne $null) { $response.outboundPaused } else { "N/A" }

        Write-Host ">>> Status: Batch accepted" -ForegroundColor Green
        Write-Host "    - Leads Processed  : $processed"
        Write-Host "    - Emails Dispatched: $sent"
        Write-Host "    - Outbound Paused  : $paused"

        if ($response.processedLeads) {
            foreach ($item in $response.processedLeads) {
                $statusColor = if ($item.dispatchBlocked) { "Red" } else { "Green" }
                Write-Host "      * Lead: $($item.lead.company) ($($item.lead.email)) -> Blocked: $($item.dispatchBlocked)" -ForegroundColor $statusColor
            }
        }
    } catch {
        Write-Error "Failed to process batch for $($target.City): $_"
    }

    if ($batchIndex -lt $targets.Count) {
        Write-Host "`nWaiting $delayBetweenBatchesSeconds seconds before next market..." -ForegroundColor Cyan
        Start-Sleep -Seconds $delayBetweenBatchesSeconds
    }
    $batchIndex++
}

Write-Host "`n====================================================" -ForegroundColor Green
Write-Host "All 5 city batches executed. Check Gmail Sent folder for outgoing delivery logs." -ForegroundColor Green
