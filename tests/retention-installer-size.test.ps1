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

Write-Host 'Supabase installer-size helper runtime tests passed (3 valid cases, 5 rejected cases).'
