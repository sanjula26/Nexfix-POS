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

Write-Host 'Supabase metadata JSON parser and installer-size helper runtime tests passed (2 JSON rows, 3 valid sizes, 5 rejected cases).'
