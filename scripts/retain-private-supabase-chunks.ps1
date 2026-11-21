param([switch]$Apply)

$ErrorActionPreference = 'Stop'

foreach ($name in @('SUPABASE_SERVICE_ROLE_KEY')) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
    throw "$name is required for safe Supabase release retention. No objects were changed."
  }
}

$projectUrl = 'https://ocmzgamnehwbkuwkjdrr.supabase.co'
$storageUrl = "$projectUrl/storage/v1"
$bucket = 'nexfix-desktop-updates'
$expectedActiveKey = [string]$env:EXPECTED_ACTIVE_INSTALLER_PATH
$chunkBytes = 40 * 1024 * 1024
$maxRetainedReleases = 2

$supabaseApiKey = [string]$env:SUPABASE_SERVICE_ROLE_KEY
$headers = @{
  apikey = $supabaseApiKey
  'Content-Type' = 'application/json'
  'User-Agent' = 'Nexfix-GitHub-Action/2.0'
}
# Opaque sb_secret_* API keys are not JWT bearer tokens. Preserve Authorization
# only for legacy service_role JWT keys.
if ($supabaseApiKey.StartsWith('eyJ', [StringComparison]::Ordinal)) {
  $headers.Authorization = "Bearer $supabaseApiKey"
}

$publishedRows = @(Invoke-RestMethod -Uri "$projectUrl/rest/v1/desktop_releases?platform=eq.win32&channel=eq.latest&select=version,installer_path,installer_size,is_active,published_at&order=published_at.desc" -Headers $headers)
$activeRows = @($publishedRows | Where-Object { [bool]$_.is_active })
if ($activeRows.Count -ne 1) {
  throw "Expected exactly one active private Windows release; found $($activeRows.Count). No Supabase objects were changed."
}

$activeVersion = [string]$activeRows[0].version
$activeKey = [string]$activeRows[0].installer_path

function ConvertTo-InstallerSize($value, [string]$label) {
  # PostgREST normally returns a scalar numeric value. Defensively unwrap a
  # single-item array (some PowerShell response shapes enumerate JSON values),
  # but reject ambiguous multi-value metadata instead of guessing.
  while ($value -is [System.Array]) {
    if ($value.Count -ne 1) {
      throw "$label must contain exactly one numeric value; received $($value.Count). No Supabase objects were changed."
    }
    $value = $value[0]
  }
  if ($null -eq $value) {
    throw "$label is missing. No Supabase objects were changed."
  }
  $parsed = [int64]0
  $raw = [string]$value
  $style = [Globalization.NumberStyles]::Integer
  $culture = [Globalization.CultureInfo]::InvariantCulture
  if (-not [int64]::TryParse($raw, $style, $culture, [ref]$parsed) -or $parsed -le 0) {
    throw "$label must be a positive 64-bit integer; received '$raw'. No Supabase objects were changed."
  }
  return $parsed
}

$activeSize = ConvertTo-InstallerSize $activeRows[0].installer_size 'Active release installer_size'
if ($activeVersion -notmatch '^\d+\.\d+\.\d+$' -or $activeKey -notmatch '^win32/latest/Nexfix-POS-\d+\.\d+\.\d+-x64-installer\.exe$' -or $activeSize -le 0) {
  throw 'Active release metadata is invalid. No Supabase objects were changed.'
}
if ($expectedActiveKey -and $activeKey -ne $expectedActiveKey) {
  throw "Published installer does not match the active release pointer. Active: $activeKey; expected: $expectedActiveKey. No Supabase objects were changed."
}

function Get-ReleaseChunkObjects {
  $pageSize = 1000
  $cursor = $null
  $objects = [System.Collections.Generic.List[object]]::new()
  do {
    $options = @{ prefix = 'win32/latest/'; limit = $pageSize; with_delimiter = $false }
    if (-not [string]::IsNullOrWhiteSpace($cursor)) { $options.cursor = $cursor }
    $body = $options | ConvertTo-Json -Compress
    $page = Invoke-RestMethod -Uri "$storageUrl/object/list-v2/$bucket" -Method Post -Headers $headers -Body $body
    foreach ($object in @($page.objects)) {
      if ($null -eq $object.id) { continue }
      $name = [string]$object.name
      if (-not $name.StartsWith('win32/latest/', [StringComparison]::Ordinal)) {
        $name = "win32/latest/$name"
      }
      if ($name -like 'win32/latest/Nexfix-POS-*.part*') {
        $objects.Add([pscustomobject]@{
          Name = $name
          Size = [int64]$object.metadata.size
        })
      }
    }
    if ([bool]$page.hasNext) {
      $nextCursor = [string]$page.nextCursor
      if ([string]::IsNullOrWhiteSpace($nextCursor) -or $nextCursor -eq $cursor) {
        throw 'Supabase Storage list-v2 returned a missing or repeated cursor. No objects were changed.'
      }
      $cursor = $nextCursor
    } else {
      $cursor = $null
    }
  } while ([bool]$page.hasNext)
  return @($objects)
}

function Test-CompleteChunkGroup($group, [Nullable[int64]]$expectedInstallerSize = $null) {
  $ordered = @($group.Chunks | Sort-Object Part)
  if ($ordered.Count -lt 1) { return $false }
  for ($index = 0; $index -lt $ordered.Count; $index++) {
    if ([int]$ordered[$index].Part -ne ($index + 1)) { return $false }
  }
  if ($null -ne $expectedInstallerSize) {
    $expectedCount = [int][math]::Ceiling([double]$expectedInstallerSize / $chunkBytes)
    if ($ordered.Count -ne $expectedCount) { return $false }
    for ($index = 0; $index -lt $ordered.Count; $index++) {
      $expectedSize = [int64][math]::Min($chunkBytes, $expectedInstallerSize - ($index * $chunkBytes))
      if ([int64]$ordered[$index].Size -ne $expectedSize) { return $false }
    }
    return $true
  }
  for ($index = 0; $index -lt ($ordered.Count - 1); $index++) {
    if ([int64]$ordered[$index].Size -ne $chunkBytes) { return $false }
  }
  $lastSize = [int64]$ordered[$ordered.Count - 1].Size
  return ($lastSize -gt 0 -and $lastSize -le $chunkBytes)
}

function ConvertTo-ChunkGroups($objects) {
  $groups = @{}
  foreach ($object in $objects) {
    $name = [string]$object.Name
    if ($name -notmatch '^win32/latest/Nexfix-POS-(?<version>\d+\.\d+\.\d+)-x64-installer\.exe\.part(?<part>\d{4})$') {
      throw "Unexpected object under the Nexfix installer chunk prefix: $name. No Supabase objects were changed."
    }
    $version = [string]$Matches.version
    $part = [int]$Matches.part
    if (-not $groups.ContainsKey($name.Substring(0, $name.LastIndexOf('.part')))) {
      $groups[$name.Substring(0, $name.LastIndexOf('.part'))] = [pscustomobject]@{
        Key = $name.Substring(0, $name.LastIndexOf('.part'))
        Version = [version]$version
        Chunks = [System.Collections.Generic.List[object]]::new()
      }
    }
    $groups[$name.Substring(0, $name.LastIndexOf('.part'))].Chunks.Add([pscustomobject]@{
      Name = $name
      Part = $part
      Size = [int64]$object.Size
    })
  }
  return @($groups.Values | Sort-Object Version -Descending)
}

$objects = @(Get-ReleaseChunkObjects)
$groups = @(ConvertTo-ChunkGroups $objects)
$activeGroup = @($groups | Where-Object { $_.Key -eq $activeKey })
if ($activeGroup.Count -ne 1) {
  throw "Active Supabase release chunks are missing or ambiguous: $activeKey. No Supabase objects were changed."
}
if (-not (Test-CompleteChunkGroup $activeGroup[0] $activeSize)) {
  throw "Active Supabase release chunks are incomplete or have incorrect sizes: $activeKey. No Supabase objects were changed."
}

# Retain only a previously published inactive release whose complete chunk
# set matches the installer_size recorded at publish time. This excludes partial
# uploads and orphaned chunk groups that never became a usable updater release.
$completePrevious = @()
$previousRows = @($publishedRows | Where-Object { -not [bool]$_.is_active -and [string]$_.installer_path -ne $activeKey })
foreach ($previous in $previousRows) {
  $candidate = @($groups | Where-Object { $_.Key -eq [string]$previous.installer_path })
  if ($candidate.Count -ne 1) { continue }
  if ($completePrevious.Count -lt ($maxRetainedReleases - 1) -and (Test-CompleteChunkGroup $candidate[0] (ConvertTo-InstallerSize $previous.installer_size "Previous release $($previous.version) installer_size"))) {
    $completePrevious += @($candidate)
  }
  if ($completePrevious.Count -ge ($maxRetainedReleases - 1)) { break }
}
$retainedGroups = @($activeGroup[0]) + @($completePrevious)
$retainedKeys = @($retainedGroups | ForEach-Object { [string]$_.Key } | Sort-Object)
$removePaths = @(
  $groups |
    Where-Object { $retainedKeys -notcontains $_.Key } |
    ForEach-Object { $_.Chunks | ForEach-Object { [string]$_.Name } }
)

Write-Host "Active Supabase release protected: $activeVersion / $activeKey"
Write-Host "Complete previous release(s) retained: $($completePrevious.Count)"
Write-Host "Total release chunk objects listed: $($objects.Count)"
Write-Host "Superseded/incomplete chunk objects to remove: $($removePaths.Count)"
Write-Host "Retained release keys: $($retainedKeys -join ', ')"
if (-not $Apply) {
  Write-Host 'Preview only. Pass -Apply after verifying this exact retention plan.'
  $removePaths | ForEach-Object { Write-Host "Would remove: $_" }
  return
}

# Supabase Storage API remove is limited to 1,000 objects per request.
for ($offset = 0; $offset -lt $removePaths.Count; $offset += 1000) {
  $batch = @($removePaths | Select-Object -Skip $offset -First 1000)
  if ($batch.Count -eq 0) { continue }
  $deleteBody = @{ prefixes = @($batch) } | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri "$storageUrl/object/$bucket" -Method Delete -Headers $headers -Body $deleteBody | Out-Null
  Write-Host "Requested deletion of Supabase chunk batch: $($batch.Count) object(s)."
}

$remainingObjects = @(Get-ReleaseChunkObjects)
$remainingGroups = @(ConvertTo-ChunkGroups $remainingObjects)
$remainingKeys = @($remainingGroups | ForEach-Object { [string]$_.Key } | Sort-Object)
$differences = @(Compare-Object -ReferenceObject $retainedKeys -DifferenceObject $remainingKeys -CaseSensitive)
if ($differences.Count -gt 0) {
  throw "Supabase retention verification failed. Expected: $($retainedKeys -join ', '); found: $($remainingKeys -join ', ')"
}
# Verify every retained version after deletion, not only the active release.
# This confirms the rollback copy still has the exact complete chunk set and sizes
# recorded when that version was published.
foreach ($retainedKey in $retainedKeys) {
  $retainedRows = @($publishedRows | Where-Object { [string]$_.installer_path -eq $retainedKey })
  $retainedGroup = @($remainingGroups | Where-Object { $_.Key -eq $retainedKey })
  if ($retainedRows.Count -ne 1 -or $retainedGroup.Count -ne 1) {
    throw "Retained Supabase release has missing or ambiguous metadata/chunks: $retainedKey"
  }
  if (-not (Test-CompleteChunkGroup $retainedGroup[0] (ConvertTo-InstallerSize $retainedRows[0].installer_size "Retained release $retainedKey installer_size"))) {
    throw "Retained Supabase release chunks disappeared or changed during retention cleanup: $retainedKey"
  }
}
Write-Host "Supabase retention verified: active release $activeVersion remains with $($remainingObjects.Count) chunk object(s); at most two release versions are retained."
