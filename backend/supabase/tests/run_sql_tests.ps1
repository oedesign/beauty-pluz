param(
  [ValidateSet(
    "checkout_foundation",
    "checkout_payment_lifecycle",
    "orders_inventory"
  )]
  [string[]]$Test = @(
    "checkout_foundation",
    "checkout_payment_lifecycle",
    "orders_inventory"
  )
)

$ErrorActionPreference = "Stop"
$container = "supabase_db_backend"
$running = & docker inspect --format '{{.State.Running}}' $container 2>$null
if ($LASTEXITCODE -ne 0 -or $running -ne "true") {
  throw "The local Supabase database container is not running."
}

foreach ($name in $Test) {
  $path = Join-Path $PSScriptRoot "$name.test.sql"
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "SQL test script not found: $name"
  }

  $sql = Get-Content -Raw -LiteralPath $path
  if ($sql -notmatch '(?is)^\s*begin\s*;.*\brollback\s*;\s*$') {
    throw "SQL test script must run inside a transaction and end with ROLLBACK: $name"
  }

  $output = $sql | & docker exec -i $container psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Output $output
    throw "SQL regression test failed: $name"
  }

  Write-Output "PASS: $name (assertions executed; transaction rolled back)"
}
