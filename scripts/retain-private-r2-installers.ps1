$ErrorActionPreference = 'Stop'

foreach ($name in @('R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'SUPABASE_SERVICE_ROLE_KEY')) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
    throw "$name is required for safe private R2 retention. No objects were changed."
  }
}

$expectedActiveKey = [string]$env:EXPECTED_ACTIVE_INSTALLER_PATH
$projectUrl = 'https://ocmzgamnehwbkuwkjdrr.supabase.co'
$r2Endpoint = "https://$env:R2_ACCOUNT_ID.r2.cloudflarestorage.com"
$maxRetainedReleases = 3

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
  choco install awscli -y --no-progress
  if ($LASTEXITCODE -ne 0 -or -not (Get-Command aws -ErrorAction SilentlyContinue)) {
    throw 'AWS CLI could not be installed; no R2 objects were changed.'
  }
}

$headers = @{
  apikey = $env:SUPABASE_SERVICE_ROLE_KEY
  Authorization = "Bearer $($env:SUPABASE_SERVICE_ROLE_KEY)"
}
$activeRows = @(Invoke-RestMethod -Uri "$projectUrl/rest/v1/desktop_releases?platform=eq.win32&channel=eq.latest&is_active=eq.true&select=version,installer_path,installer_size" -Headers $headers)
if ($activeRows.Count -ne 1) {
  throw "Expected exactly one active private Windows release; found $($activeRows.Count). No R2 objects were changed."
}
$activeKey = [string]$activeRows[0].installer_path
if ($activeKey -notmatch '^win32/latest/Nexfix-POS-\d+\.\d+\.\d+-x64-installer\.exe$') {
  throw "Active release path is invalid: $activeKey. No R2 objects were changed."
}
if ($expectedActiveKey -and $activeKey -ne $expectedActiveKey) {
  throw "Published installer does not match the active release pointer. Active: $activeKey; current build: $expectedActiveKey. No R2 objects were changed."
}

$env:AWS_ACCESS_KEY_ID = $env:R2_ACCESS_KEY_ID
$env:AWS_SECRET_ACCESS_KEY = $env:R2_SECRET_ACCESS_KEY
$env:AWS_DEFAULT_REGION = 'auto'

$json = aws s3api list-objects-v2 --bucket $env:R2_BUCKET --prefix 'win32/latest/Nexfix-POS-' --endpoint-url $r2Endpoint --region auto --query 'Contents[].Key' --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not list private R2 installer objects. No objects were changed.' }
$keys = @(ConvertFrom-Json -InputObject ($json -join "`n"))
$versionedInstallers = @(
  $keys | ForEach-Object {
    $key = [string]$_
    if ($key -match '^win32/latest/Nexfix-POS-(?<version>\d+\.\d+\.\d+)-x64-installer\.exe$') {
      [pscustomobject]@{ Key = $key; Version = [version]$Matches['version'] }
    } else {
      throw "Unexpected object key under the private installer prefix: $key. No objects were changed."
    }
  } | Sort-Object Version -Descending
)
if ($versionedInstallers.Count -lt 1) { throw 'No private R2 installer objects were found. No objects were changed.' }

$activeEntry = @($versionedInstallers | Where-Object { $_.Key -eq $activeKey })
if ($activeEntry.Count -ne 1) { throw "Active installer is missing from R2: $activeKey. No objects were changed." }
$activeHeadJson = aws s3api head-object --bucket $env:R2_BUCKET --key $activeKey --endpoint-url $r2Endpoint --region auto --output json
if ($LASTEXITCODE -ne 0) { throw "Active installer could not be verified in R2: $activeKey. No objects were changed." }
$activeHead = ConvertFrom-Json -InputObject ($activeHeadJson -join "`n")
if ([int64]$activeHead.ContentLength -ne [int64]$activeRows[0].installer_size) {
  throw 'Active R2 installer size does not match the Supabase release record. No objects were changed.'
}

# Always keep the active database-published installer, even if an older release
# is re-run. Fill the other two slots with the newest versions by semantic version.
$newestOtherInstallers = @($versionedInstallers | Where-Object { $_.Key -ne $activeKey } | Select-Object -First ($maxRetainedReleases - 1))
$retained = @($activeEntry) + @($newestOtherInstallers)
$retainedKeys = @($retained | ForEach-Object { [string]$_.Key } | Sort-Object)
$removeKeys = @($versionedInstallers | Where-Object { $retainedKeys -notcontains $_.Key } | ForEach-Object { [string]$_.Key })
if ($retainedKeys -notcontains $activeKey) { throw 'Active installer is not protected by retention. No objects were changed.' }

Write-Host "Active release protected: $($activeRows[0].version) / $activeKey"
Write-Host "Retaining active + newest private installers (maximum $maxRetainedReleases)."
Write-Host "Superseded installers to remove: $($removeKeys.Count)"
foreach ($key in $removeKeys) {
  Write-Host "Removing superseded private installer: $key"
  aws s3api delete-object --bucket $env:R2_BUCKET --key $key --endpoint-url $r2Endpoint --region auto --output text | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to remove superseded R2 installer: $key" }
}

$verifyJson = aws s3api list-objects-v2 --bucket $env:R2_BUCKET --prefix 'win32/latest/Nexfix-POS-' --endpoint-url $r2Endpoint --region auto --query 'Contents[].Key' --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not verify private R2 installer retention.' }
$remainingKeys = @(ConvertFrom-Json -InputObject ($verifyJson -join "`n") | ForEach-Object { [string]$_ } | Sort-Object)
$differences = @(Compare-Object -ReferenceObject $retainedKeys -DifferenceObject $remainingKeys -CaseSensitive)
if ($differences.Count -gt 0) {
  throw "R2 retention verification failed. Expected: $($retainedKeys -join ', '); found: $($remainingKeys -join ', ')"
}
$finalHeadJson = aws s3api head-object --bucket $env:R2_BUCKET --key $activeKey --endpoint-url $r2Endpoint --region auto --output json
if ($LASTEXITCODE -ne 0) { throw 'Active installer disappeared during R2 retention cleanup.' }
$finalHead = ConvertFrom-Json -InputObject ($finalHeadJson -join "`n")
if ([int64]$finalHead.ContentLength -ne [int64]$activeRows[0].installer_size) {
  throw 'Active installer size changed during R2 retention cleanup.'
}
Write-Host "R2 retention verified: active release $($activeRows[0].version) remains and $($remainingKeys.Count) installer(s) are retained."
