$ErrorActionPreference = "Stop"

$projectId = "supabase"
$container = "supabase_db_$projectId"
$dockerPath = (Get-Command docker -ErrorAction Stop).Source
$running = & $dockerPath inspect --format "{{.State.Running}}" $container 2>$null
if ($LASTEXITCODE -ne 0 -or $running -ne "true") {
  throw "The local Supabase database container '$container' is not running. Start only the local stack with 'supabase start --workdir backend/supabase'."
}

$productId = "bp-concurrency-" + [guid]::NewGuid().ToString("N")
$keyA = "checkout-concurrency-a-" + [guid]::NewGuid().ToString("N")
$keyB = "checkout-concurrency-b-" + [guid]::NewGuid().ToString("N")
$emailA = "concurrency-a-" + [guid]::NewGuid().ToString("N") + "@example.invalid"
$emailB = "concurrency-b-" + [guid]::NewGuid().ToString("N") + "@example.invalid"

function Invoke-LocalSql([string] $Sql) {
  $output = & $dockerPath exec $container psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -At -c $Sql 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw ($output -join "`n")
  }
  return ($output -join "`n").Trim()
}

try {
  Invoke-LocalSql "insert into public.products (id, name, category, price, stock_quantity, is_available, is_published) values ('$productId', 'Concurrent checkout fixture', 'testing', 1.00, 1, true, true);"

  $itemsJson = "jsonb_build_array(jsonb_build_object('product_id', '$productId', 'quantity', 1))"
  $sqlA = "set role service_role; select order_id from public.create_checkout_attempt('$keyA', null, 'Concurrent A', '$emailA', null, null, $itemsJson, 0, now() + interval '15 minutes');"
  $sqlB = "set role service_role; select order_id from public.create_checkout_attempt('$keyB', null, 'Concurrent B', '$emailB', null, null, $itemsJson, 0, now() + interval '15 minutes');"

  $jobs = @(
    Start-Job -ArgumentList $dockerPath, $container, $sqlA -ScriptBlock {
      param($DockerPath, $Container, $Sql)
      $output = & $DockerPath exec $Container psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -At -c $Sql 2>&1
      [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n") }
    }
    Start-Job -ArgumentList $dockerPath, $container, $sqlB -ScriptBlock {
      param($DockerPath, $Container, $Sql)
      $output = & $DockerPath exec $Container psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -At -c $Sql 2>&1
      [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n") }
    }
  )
  $jobs | Wait-Job | Out-Null
  $results = @($jobs | Receive-Job)
  $jobs | Remove-Job

  $successCount = @($results | Where-Object { $_.ExitCode -eq 0 }).Count
  $insufficientCount = @($results | Where-Object { $_.ExitCode -ne 0 -and $_.Output -match "Insufficient stock available" }).Count
  if (($successCount -ne 1) -or ($insufficientCount -ne 1)) {
    throw "Expected one reservation success and one insufficient-stock rejection. Results: $($results | ConvertTo-Json -Compress)"
  }

  $state = Invoke-LocalSql "select (select count(*) from public.orders where customer_email in ('$emailA', '$emailB')) || ':' || (select coalesce(sum(quantity), 0) from public.stock_reservations where product_id = '$productId' and status = 'held') || ':' || (select stock_quantity from public.products where id = '$productId');"
  if ($state -ne "1:1:1") {
    throw "Concurrent reservation left unexpected database state '$state'; expected one order, one held unit, and one on-hand unit."
  }

  Write-Output "PASS: concurrent checkouts produced exactly one order and one active reservation for the final unit."
}
finally {
  Invoke-LocalSql "delete from public.orders where customer_email in ('$emailA', '$emailB'); delete from public.products where id = '$productId';" | Out-Null
}
