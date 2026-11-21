param(
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $false)][string[]]$Arguments = @()
  )

  Write-Host ([Environment]::NewLine + '> ' + $Command + ' ' + ($Arguments -join ' ')) -ForegroundColor Cyan
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw ('Command failed with exit code {0}: {1} {2}' -f $LASTEXITCODE, $Command, ($Arguments -join ' '))
  }
}

if (-not $IsWindows -and $env:OS -ne 'Windows_NT') {
  throw 'This test build script must run on Windows.'
}

$nodeVersion = (& node --version).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Node.js 22 is required. Install Node.js 22 LTS and reopen PowerShell.' }
$nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($nodeMajor -ne 22) {
  throw "Expected Node.js 22 to match CI. Found $nodeVersion."
}
if (-not (Get-Command magick -ErrorAction SilentlyContinue)) {
  throw 'ImageMagick is required to generate the Windows icon. Install ImageMagick, ensure magick.exe is on PATH, then rerun.'
}

$package = Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$env:VITE_APP_VERSION = [string]$package.version
$env:VITE_SUPABASE_URL = 'https://ocmzgamnehwbkuwkjdrr.supabase.co'
$env:VITE_SUPABASE_ANON_KEY = 'sb_publishable_9DYtQ1kfcKClSb47Ghh-cQ_FRDz2tK-'
$env:VITE_PUBLIC_APP_URL = 'https://sanjula26.github.io/Nexfix-POS/'
$env:VITE_SEED_DEMO = 'false'

Write-Warning 'This test build connects to the live NexFix Supabase project. Cloud stock edits, sales, GRNs, and other cloud actions can affect real shop data.'
Write-Warning 'For the stock regression, use a designated test product and a controlled quantity. Do not use real sales, GRNs, or backup/restore actions during this test.'
$liveConfirmation = Read-Host 'Type LIVE-CLOUD-TEST to confirm you understand this build uses the live cloud project'
if ($liveConfirmation -cne 'LIVE-CLOUD-TEST') {
  throw 'Build cancelled. No installer was created.'
}

if ([string]::IsNullOrWhiteSpace($env:VITE_GOOGLE_BACKUP_API_KEY)) {
  $env:VITE_GOOGLE_BACKUP_API_KEY = ''
  Write-Warning 'Google Drive backup transport is not configured in this test build. POS and cloud-stock tests can proceed, but do not use Google Drive backup/restore for acceptance testing until the matching Apps Script transport value is configured locally.'
} else {
  Write-Host 'Using the locally configured Google Drive transport value; its value will not be printed.'
}

$shortCommit = (& git rev-parse --short HEAD 2>$null)
if ($LASTEXITCODE -ne 0) { $shortCommit = 'unknown' }
Write-Host "Building Nexfix POS test installer from $shortCommit" -ForegroundColor Green

Invoke-CheckedCommand -Command 'npm' -Arguments @('ci', '--no-audit', '--no-fund')
Invoke-CheckedCommand -Command 'npm' -Arguments @('run', 'typecheck')
Invoke-CheckedCommand -Command 'npm' -Arguments @('run', 'lint')
Invoke-CheckedCommand -Command 'npm' -Arguments @('run', 'verify:boundaries')
if (-not $SkipTests) {
  Invoke-CheckedCommand -Command 'npm' -Arguments @('test')
}

$iconSource = Join-Path $repoRoot 'assets/nexfix-pos-icon.svg'
if (-not (Test-Path $iconSource)) { throw "Missing Windows icon source: $iconSource" }

$svgText = Get-Content $iconSource -Raw
$match = [regex]::Match($svgText, 'data:image/(?<type>jpeg|jpg|png);base64,(?<data>[^"]+)')
if (-not $match.Success) { throw 'Windows icon source does not contain embedded PNG/JPEG artwork.' }

$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("nexfix-test-build-" + [guid]::NewGuid().ToString('N'))
$buildDir = Join-Path $repoRoot 'build'
$iconPath = Join-Path $buildDir 'icon.ico'
$hadExistingIcon = Test-Path $iconPath
$existingIconBackup = Join-Path $tempDir 'existing-icon.ico'
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

try {
  if ($hadExistingIcon) { Copy-Item $iconPath $existingIconBackup -Force }

  $extension = if ($match.Groups['type'].Value -eq 'png') { 'png' } else { 'jpg' }
  $embeddedImage = Join-Path $tempDir "icon-source.$extension"
  $pngPath = Join-Path $tempDir 'icon.png'
  $generatedIcon = Join-Path $tempDir 'icon.ico'
  [IO.File]::WriteAllBytes($embeddedImage, [Convert]::FromBase64String($match.Groups['data'].Value))

  Invoke-CheckedCommand -Command 'magick' -Arguments @($embeddedImage, '-auto-orient', '-background', 'white', '-alpha', 'remove', '-alpha', 'off', '-resize', '1024x1024', '-gravity', 'center', '-extent', '1024x1024', $pngPath)
  Invoke-CheckedCommand -Command 'magick' -Arguments @($pngPath, '-define', 'icon:auto-resize=16,24,32,48,64,128,256', $generatedIcon)

  if (-not (Test-Path $generatedIcon)) { throw 'ImageMagick did not create the Windows icon.' }
  $varianceText = (& magick identify -format '%[fx:standard_deviation]' $pngPath).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Could not validate generated Windows icon artwork.' }
  $variance = [double]::Parse($varianceText, [Globalization.CultureInfo]::InvariantCulture)
  if ($variance -lt 0.01) { throw "Generated Windows icon appears blank or flat (standard deviation $variance)." }

  Copy-Item $generatedIcon $iconPath -Force
  Invoke-CheckedCommand -Command 'npm' -Arguments @('run', 'desktop:build')

  $releaseDir = Join-Path $repoRoot 'release'
  if (-not (Test-Path $releaseDir)) { throw 'Electron Builder did not create the release directory.' }
  $exeFiles = @(Get-ChildItem -Path $releaseDir -File -Filter '*.exe')
  $installers = @($exeFiles | Where-Object { $_.Name -match '-installer\.exe$' })
  $portables = @($exeFiles | Where-Object { $_.Name -match '-portable\.exe$' })
  $blockmaps = @(Get-ChildItem -Path $releaseDir -File -Filter '*.blockmap')
  if ($installers.Count -ne 1) { throw "Expected exactly one installer EXE; found $($installers.Count)." }
  if ($portables.Count -ne 1) { throw "Expected exactly one portable EXE; found $($portables.Count)." }
  if ($blockmaps.Count -lt 1) { throw 'Expected the NSIS installer blockmap.' }

  $hashLines = foreach ($file in @($installers + $portables | Sort-Object Name)) {
    $hash = (Get-FileHash -Algorithm SHA256 -Path $file.FullName).Hash.ToLowerInvariant()
    "$hash  $($file.Name)"
  }
  $hashPath = Join-Path $releaseDir 'SHA256SUMS.txt'
  $hashLines | Set-Content -Path $hashPath -Encoding ascii

  Write-Host ([Environment]::NewLine + 'Test build complete. Files are local to this PC:') -ForegroundColor Green
  $installers + $portables | ForEach-Object { Write-Host $_.FullName }
  Write-Host "Checksums: $hashPath"
  Write-Warning 'This build is unsigned unless a Windows code-signing certificate is configured. Windows may display a SmartScreen warning; do not bypass security controls if you cannot verify the publisher.'
  Write-Warning 'This script only builds local files. It does not publish, upload, or change remote release storage.'
}
finally {
  if ($hadExistingIcon -and (Test-Path $existingIconBackup)) {
    Copy-Item $existingIconBackup $iconPath -Force
  } elseif (-not $hadExistingIcon -and (Test-Path $iconPath)) {
    Remove-Item $iconPath -Force
  }
  if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
}
