# CI-only checks of the actual user ZIP. Not shipped to users.
$ErrorActionPreference = 'Stop'
$archive = Join-Path $PSScriptRoot '../downloads/igor-client-finder.zip'
$destination = Join-Path $env:RUNNER_TEMP ('client finder user zip ' + [guid]::NewGuid())
Expand-Archive -LiteralPath $archive -DestinationPath $destination
$root = Join-Path $destination 'igor-client-finder'
Push-Location $root
try {
    if (Test-Path test) { throw 'Developer tests unexpectedly shipped' }
    if (Test-Path .github) { throw 'Workflow unexpectedly shipped' }
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed in extracted user ZIP' }
    & cmd /d /c 'audit-base.cmd --help < NUL'
    if ($LASTEXITCODE -ne 0) { throw 'Extracted audit-base.cmd --help failed' }
    # One explicitly synthetic contact, no websites/network or browser downloads.
    @'
import {mkdir,writeFile} from 'node:fs/promises';
import {normalizeElement} from './src/model.mjs';
import {CITIES} from './src/config.mjs';
const row=normalizeElement({type:'node',id:1,lat:CITIES[0].lat,lon:CITIES[0].lon,tags:{shop:'car_repair',name:'SYNTHETIC ARCHIVE CHECK ONLY',phone:'+7 000 000-00-01'}},CITIES[0],Date.now());
await mkdir('outputs/synthetic-archive-check',{recursive:true});
await writeFile('outputs/synthetic-archive-check/organizations.json',JSON.stringify([row]));
for(const dir of ['outputs','.cache','.tools']) {await mkdir(dir,{recursive:true});await writeFile(dir+'/keep.txt','preserve');}
'@ | & node --input-type=module
    if ($LASTEXITCODE -ne 0) { throw 'Synthetic local setup failed' }
    & cmd /d /c 'audit-base.cmd < NUL'
    if ($LASTEXITCODE -ne 0) { throw 'Actual extracted audit-base.cmd failed' }
    $reports = @(Get-ChildItem outputs -Directory -Filter 'base-audit-*')
    if ($reports.Count -ne 1) { throw 'Expected exactly one offline report' }
    $report = Get-Content (Join-Path $reports[0].FullName 'report.json') -Raw | ConvertFrom-Json
    if ($report.totalInput -ne 1 -or $report.checked -ne 1 -or $report.websiteChecks -ne 0 -or $report.shortlisted -ne 0 -or $report.status -ne 'complete') { throw 'Unexpected offline result' }
    foreach ($dir in @('outputs','.cache','.tools')) {
        if ((Get-Content (Join-Path $dir 'keep.txt') -Raw) -ne 'preserve') { throw "Data marker changed: $dir" }
    }
    Write-Host 'Extracted user ZIP: npm ci, actual audit-base.cmd, offline report and data preservation passed. Synthetic input only.'
} finally { Pop-Location }
