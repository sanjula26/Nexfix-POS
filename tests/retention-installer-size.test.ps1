$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot '../scripts/retain-private-supabase-chunks.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path $scriptPath).Path,
  [ref]$tokens,
  [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) {
  throw "Cannot test installer-size helper because the source script has parse errors: $($parseErrors[0].Message)"
}

$functionAst = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'ConvertTo-InstallerSize'
}, $true)
if ($null -eq $functionAst) {
  throw 'ConvertTo-InstallerSize function was not found in the Supabase retention script.'
}

# Also extract and execute the pure JSON parser independently. This fixture
# mirrors the PostgREST array-of-rows shape and confirms bigint values stay scalar.
$jsonFunctionAst = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'ConvertFrom-ReleaseMetadataJson'
}, $true)
if ($null -eq $jsonFunctionAst) {
  throw 'ConvertFrom-ReleaseMetadataJson function was not found in the Supabase retention script.'
}
. ([scriptblock]::Create($jsonFunctionAst.Extent.Text))

$fixture = '[{"version":"3.0.1898","installer_path":"win32/latest/Nexfix-POS-3.0.1898-x64-installer.exe","installer_size":123942561,"is_active":true,"published_at":"2026-11-21T00:00:00Z"},{"version":"3.0.1891","installer_path":"win32/latest/Nexfix-POS-3.0.1891-x64-installer.exe","installer_size":123942221,"is_active":false,"published_at":"2026-11-20T00:00:00Z"}]'
$rows = ConvertFrom-ReleaseMetadataJson -Json $fixture
if ($rows -isnot [System.Array] -or $rows.Count -ne 2) {
  throw "Release metadata JSON root array was not preserved; received type '$($rows.GetType().FullName)' with count '$($rows.Count)'."
}
if ($rows[0].installer_size -is [System.Array] -or [int64]$rows[0].installer_size -ne 123942561) {
  throw 'Active installer_size did not remain the expected scalar bigint value after JSON parsing.'
}
if ($rows[1].installer_size -is [System.Array] -or [int64]$rows[1].installer_size -ne 123942221) {
  throw 'Rollback installer_size did not remain the expected scalar bigint value after JSON parsing.'
}

# The R2 cleanup script must use the same raw JSON parser. Exercise that
# independently so its Supabase metadata path cannot regress to Invoke-RestMethod.
$r2ScriptPath = Join-Path $PSScriptRoot '../scripts/retain-private-r2-installers.ps1'
$r2Tokens = $null
$r2ParseErrors = $null
$r2Ast = [System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path $r2ScriptPath).Path,
  [ref]$r2Tokens,
  [ref]$r2ParseErrors
)
if ($r2ParseErrors.Count -gt 0) {
  throw "Cannot test R2 metadata parser because the source script has parse errors: $($r2ParseErrors[0].Message)"
}
$r2JsonFunctionAst = $r2Ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'ConvertFrom-ReleaseMetadataJson'
}, $true)
if ($null -eq $r2JsonFunctionAst) {
  throw 'ConvertFrom-ReleaseMetadataJson function was not found in the R2 retention script.'
}
. ([scriptblock]::Create($r2JsonFunctionAst.Extent.Text))
$r2Rows = ConvertFrom-ReleaseMetadataJson -Json $fixture
if ($r2Rows -isnot [System.Array] -or $r2Rows.Count -ne 2) {
  throw 'R2 metadata parser did not preserve the two-row JSON root array.'
}
if ($r2Rows[0].installer_path -ne 'win32/latest/Nexfix-POS-3.0.1898-x64-installer.exe' -or
    $r2Rows[0].installer_size -is [System.Array] -or [int64]$r2Rows[0].installer_size -ne 123942561) {
  throw 'R2 active release path/size did not remain scalar after raw JSON parsing.'
}
if ($r2Rows[1].installer_path -ne 'win32/latest/Nexfix-POS-3.0.1891-x64-installer.exe' -or
    $r2Rows[1].installer_size -is [System.Array] -or [int64]$r2Rows[1].installer_size -ne 123942221) {
  throw 'R2 rollback release path/size did not remain scalar after raw JSON parsing.'
}

# Load only the pure conversion helper. Do not dot-source the retention script:
# that script performs authenticated API reads and can delete objects with -Apply.
. ([scriptblock]::Create($functionAst.Extent.Text))

function Assert-InstallerSize {
  param([object]$Actual, [int64]$Expected, [string]$Case)
  if ($Actual -isnot [int64] -or $Actual -ne $Expected) {
    throw "$Case failed: expected Int64 $Expected; received '$Actual' ($($Actual.GetType().FullName))."
  }
}

Assert-InstallerSize (ConvertTo-InstallerSize -InputValue ([int64]123942561) -Label 'scalar') 123942561 'Int64 scalar'
Assert-InstallerSize (ConvertTo-InstallerSize -InputValue '123942221' -Label 'numeric string') 123942221 'Numeric string'
Assert-InstallerSize (ConvertTo-InstallerSize -InputValue ([object[]]@([int64]123)) -Label 'single item array') 123 'Single-item array'

$rejectedCases = @(
  @{ Name = 'multi-item array'; Value = [object[]]@(123, 456) },
  @{ Name = 'zero'; Value = 0 },
  @{ Name = 'negative'; Value = -1 },
  @{ Name = 'non-numeric'; Value = 'not-a-number' },
  @{ Name = 'null'; Value = $null }
)
foreach ($case in $rejectedCases) {
  $rejected = $false
  try {
    $null = ConvertTo-InstallerSize -InputValue $case.Value -Label $case.Name
  } catch {
    $rejected = $true
  }
  if (-not $rejected) {
    throw "Unsafe input was not rejected: $($case.Name)"
  }
}

Write-Host 'Supabase and R2 metadata JSON parser runtime tests passed (2 JSON rows, scalar paths/sizes, 3 valid sizes, 5 rejected cases).'
