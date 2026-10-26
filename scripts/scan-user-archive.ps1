# Report-only availability assessment; never enables/disables Defender or adds exclusions.
$ErrorActionPreference = 'Stop'
$summary = [ordered]@{ available = $false; result = 'not_scanned'; reason = ''; signatureDate = $null; sha256 = (Get-FileHash "$PSScriptRoot/../downloads/igor-client-finder.zip" -Algorithm SHA256).Hash }
$reportPath = Join-Path $env:RUNNER_TEMP 'igor-user-zip-antivirus.json'
try {
    try { $status = Get-MpComputerStatus -ErrorAction Stop }
    catch { $summary.reason = 'Get-MpComputerStatus unavailable: ' + $_.Exception.Message; return }
    $summary.signatureDate = $status.AntivirusSignatureLastUpdated
    if (-not $status.AntivirusEnabled -or -not $status.AMServiceEnabled) {
        $summary.reason = 'Defender engine/service is not enabled on this runner; no protection settings changed.'; return
    }
    $exe = Get-ChildItem "$env:ProgramData/Microsoft/Windows Defender/Platform/*/MpCmdRun.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
    if (-not $exe) { $exe = Join-Path $env:ProgramFiles 'Windows Defender/MpCmdRun.exe' }
    if (-not (Test-Path $exe)) { $summary.reason = 'MpCmdRun.exe unavailable'; return }
    $summary.available = $true
    $archive = (Resolve-Path "$PSScriptRoot/../downloads/igor-client-finder.zip").Path
    $stdout = Join-Path $env:RUNNER_TEMP 'igor-defender-stdout.txt'
    $stderr = Join-Path $env:RUNNER_TEMP 'igor-defender-stderr.txt'
    $process = Start-Process -FilePath $exe -ArgumentList @('-Scan','-ScanType','3','-File',('"' + $archive + '"')) -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    if (-not $process.WaitForExit(120000)) { $summary.result = 'incomplete'; $summary.reason = 'Scanner exceeded 120 seconds; no clean verdict'; throw $summary.reason }
    $process.WaitForExit()
    Get-Content $stdout, $stderr -ErrorAction SilentlyContinue | Write-Host
    $summary.exitCode = $process.ExitCode
    if ($process.ExitCode -ne 0) { $summary.result = 'scan_error_or_detection'; throw "Defender scan returned $($process.ExitCode); inspect log before publishing" }
    if (-not (Test-Path $archive)) { throw 'Archive missing after scan' }
    if ((Get-FileHash $archive -Algorithm SHA256).Hash -ne $summary.sha256) { throw 'Archive bytes changed during scan' }
    $detections = @(Get-MpThreatDetection -ErrorAction Stop | Where-Object { $_.Resources -match 'igor-client-finder[.]zip' })
    if ($detections.Count) { $summary.result = 'detection_reported'; throw 'Defender recorded a detection for this archive; do not publish' }
    $summary.result = 'scan_completed_no_detection_reported'
    $summary.reason = 'Limited to this runner and its recorded signature date; not a guarantee for another Defender installation.'
} finally {
    $summary | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 $reportPath
    $summary | ConvertTo-Json -Depth 4 | Write-Host
    "### User ZIP antivirus check`n``````json`n$($summary | ConvertTo-Json -Depth 4)`n```````n" | Out-File -Append -Encoding utf8 $env:GITHUB_STEP_SUMMARY
}
