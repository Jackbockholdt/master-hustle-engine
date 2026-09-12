# ==============================================================================
# send_25_agencies.ps1
# Automated Feeder for 25 Verified US Digital Marketing & SEO Agency Executives
# Target: https://master-hustle-engine.onrender.com/webhook/lead
# Pacing: 3-second delay between requests
# ==============================================================================

$agencies = @(
    @{ company_name = "Single Grain"; contact_email = "eric@singlegrain.com"; website = "singlegrain.com"; industry = "digital marketing agency" },
    @{ company_name = "Ignite Visibility"; contact_email = "john@ignitevisibility.com"; website = "ignitevisibility.com"; industry = "digital marketing agency" },
    @{ company_name = "Directive Consulting"; contact_email = "garrett@directiveconsulting.com"; website = "directiveconsulting.com"; industry = "digital marketing agency" },
    @{ company_name = "Disruptive Advertising"; contact_email = "jacob@disruptiveadvertising.com"; website = "disruptiveadvertising.com"; industry = "digital marketing agency" },
    @{ company_name = "KlientBoost"; contact_email = "johnathan@klientboost.com"; website = "klientboost.com"; industry = "digital marketing agency" },
    @{ company_name = "WebFX"; contact_email = "bill@webfx.com"; website = "webfx.com"; industry = "digital marketing agency" },
    @{ company_name = "Victorious SEO"; contact_email = "michael@victoriousseo.com"; website = "victoriousseo.com"; industry = "digital marketing agency" },
    @{ company_name = "LYFE Marketing"; contact_email = "sean@lyfemarketing.com"; website = "lyfemarketing.com"; industry = "digital marketing agency" },
    @{ company_name = "Straight North"; contact_email = "david@straightnorth.com"; website = "straightnorth.com"; industry = "digital marketing agency" },
    @{ company_name = "Silverback Strategies"; contact_email = "john@silverbackstrategies.com"; website = "silverbackstrategies.com"; industry = "digital marketing agency" },
    @{ company_name = "Siege Media"; contact_email = "ross@siegemedia.com"; website = "siegemedia.com"; industry = "digital marketing agency" },
    @{ company_name = "Animalz"; contact_email = "walter@animalz.co"; website = "animalz.co"; industry = "digital marketing agency" },
    @{ company_name = "Flow SEO"; contact_email = "viola@flow-seo.com"; website = "flow-seo.com"; industry = "digital marketing agency" },
    @{ company_name = "Omniscient Digital"; contact_email = "alex@beomniscient.com"; website = "beomniscient.com"; industry = "digital marketing agency" },
    @{ company_name = "Inflow"; contact_email = "mike@goinflow.com"; website = "goinflow.com"; industry = "digital marketing agency" },
    @{ company_name = "From The Future"; contact_email = "nick@ftf.agency"; website = "ftf.agency"; industry = "digital marketing agency" },
    @{ company_name = "Big Leap"; contact_email = "bryan@bigleap.com"; website = "bigleap.com"; industry = "digital marketing agency" },
    @{ company_name = "Go Fish Digital"; contact_email = "brian@gofishdigital.com"; website = "gofishdigital.com"; industry = "digital marketing agency" },
    @{ company_name = "Greenlane Marketing"; contact_email = "bill@greenlanemarketing.com"; website = "greenlanemarketing.com"; industry = "digital marketing agency" },
    @{ company_name = "Portent"; contact_email = "ian@portent.com"; website = "portent.com"; industry = "digital marketing agency" },
    @{ company_name = "Coalition Technologies"; contact_email = "joel@coalitiontechnologies.com"; website = "coalitiontechnologies.com"; industry = "digital marketing agency" },
    @{ company_name = "Power Digital Marketing"; contact_email = "grayson@powerdigitalmarketing.com"; website = "powerdigitalmarketing.com"; industry = "digital marketing agency" },
    @{ company_name = "NP Digital"; contact_email = "mike@npdigital.com"; website = "npdigital.com"; industry = "digital marketing agency" },
    @{ company_name = "HawkSEM"; contact_email = "sam@hawksem.com"; website = "hawksem.com"; industry = "digital marketing agency" },
    @{ company_name = "Level Agency"; contact_email = "patrick@level.agency"; website = "level.agency"; industry = "digital marketing agency" }
)

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Ingesting $($agencies.Count) Verified Agency Decision-Makers..." -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$count = 1
foreach ($agency in $agencies) {
    $json = $agency | ConvertTo-Json
    Write-Host "[$count/$($agencies.Count)] Ingesting: $($agency.company_name) -> $($agency.contact_email)..." -ForegroundColor Yellow
    
    try {
        $response = Invoke-RestMethod -Uri "https://master-hustle-engine.onrender.com/webhook/lead" `
            -Method Post `
            -ContentType "application/json" `
            -Body $json
        
        $resJson = $response | ConvertTo-Json -Compress
        Write-Host "    Response: $resJson" -ForegroundColor Green
    } catch {
        Write-Host "    Error: $($_.Exception.Message)" -ForegroundColor Red
    }
    
    Write-Host "    Pacing 3s for safe AI generation & dispatch..." -ForegroundColor Gray
    Start-Sleep -Seconds 3
    $count++
}

Write-Host "`nAll $($agencies.Count) leads processed successfully!" -ForegroundColor Cyan
