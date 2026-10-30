$ErrorActionPreference = "Stop"

$envPath = Join-Path $PSScriptRoot ".env.local"
$expectedEnvironment = "sandbox"

function ConvertFrom-SecureInput {
  param([Security.SecureString]$Value)

  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function ConvertTo-DotEnvValue {
  param([string]$Value)

  return ConvertTo-Json -InputObject $Value -Compress
}

if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
  throw "The local function environment file does not exist."
}

$entries = @{}
$lines = [IO.File]::ReadAllLines($envPath)
foreach ($line in $lines) {
  if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
    $name = $Matches[1]
    $value = $Matches[2].Trim()
    if (
      ($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))
    ) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $entries[$name] = $value
  }
}

$hmacKey = $entries["CHECKOUT_RATE_LIMIT_HMAC_KEY"]
if (
  -not $entries.ContainsKey("CHECKOUT_RATE_LIMIT_HMAC_KEY") -or
  [Text.Encoding]::UTF8.GetByteCount($hmacKey) -lt 32
) {
  throw "A valid local rate-limit HMAC key is not configured."
}

$apiKeySecure = Read-Host "SumUp sandbox API key" -AsSecureString
$merchantCodeSecure = Read-Host "SumUp sandbox merchant code" -AsSecureString
$apiKey = ConvertFrom-SecureInput $apiKeySecure
$merchantCode = ConvertFrom-SecureInput $merchantCodeSecure

try {
  if (
    [string]::IsNullOrWhiteSpace($apiKey) -or
    $apiKey.Contains("`r") -or
    $apiKey.Contains("`n") -or
    [string]::IsNullOrWhiteSpace($merchantCode) -or
    $merchantCode.Contains("`r") -or
    $merchantCode.Contains("`n") -or
    $merchantCode.Trim().Length -gt 40
  ) {
    throw "The entered sandbox configuration is invalid."
  }

  $updatedLines = [Collections.Generic.List[string]]::new()
  foreach ($line in $lines) {
    if (
      $line -notmatch '^\s*(?:export\s+)?(?:SUMUP_ENVIRONMENT|SUMUP_SANDBOX_API_KEY|SUMUP_SANDBOX_MERCHANT_CODE)\s*='
    ) {
      $updatedLines.Add($line)
    }
  }
  $updatedLines.Add("SUMUP_ENVIRONMENT=$expectedEnvironment")
  $updatedLines.Add("SUMUP_SANDBOX_API_KEY=$(ConvertTo-DotEnvValue $apiKey)")
  $updatedLines.Add(
    "SUMUP_SANDBOX_MERCHANT_CODE=$(ConvertTo-DotEnvValue $merchantCode.Trim())"
  )

  [IO.File]::WriteAllLines(
    $envPath,
    $updatedLines,
    [Text.UTF8Encoding]::new($false)
  )
  Write-Output "Local SumUp sandbox settings saved; values were not displayed."
  Write-Output "Trusted ingress remains unverified and fail-closed."
} finally {
  $apiKey = $null
  $merchantCode = $null
  $apiKeySecure.Dispose()
  $merchantCodeSecure.Dispose()
}
