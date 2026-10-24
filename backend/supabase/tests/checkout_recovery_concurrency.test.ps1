$ErrorActionPreference = "Stop"

$projectId = "supabase"
$container = "supabase_db_$projectId"
$dockerPath = (Get-Command docker -ErrorAction Stop).Source
$running = & $dockerPath inspect --format "{{.State.Running}}" $container 2>$null
if ($LASTEXITCODE -ne 0 -or $running -ne "true") {
  throw "The local Supabase database container '$container' is not running. Start only the local stack with 'supabase start --workdir backend/supabase'."
}

$productId = "bp-recovery-" + [guid]::NewGuid().ToString("N")
$initialKey = "recovery-initial-" + [guid]::NewGuid().ToString("N")
$email = "recovery-" + [guid]::NewGuid().ToString("N") + "@example.invalid"
$capabilityHash = "3" * 64

function Invoke-LocalSql([string] $Sql) {
  $output = & $dockerPath exec $container psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -At -c $Sql 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw ($output -join "`n")
  }
  return ($output -join "`n").Trim()
}

try {
  Invoke-LocalSql "insert into public.products (id, name, category, price, stock_quantity, is_available, is_published) values ('$productId', 'Recovery concurrency fixture', 'testing', 2.00, 5, true, true);" | Out-Null
  $items = "jsonb_build_array(jsonb_build_object('product_id', '$productId', 'quantity', 1))"
  $prepare = "set role service_role; with created as (select * from public.create_checkout_attempt('$initialKey', null, 'Recovery concurrency customer', '$email', null, '1 Test Street', $items, 0, now() + interval '20 minutes')) select public.register_guest_checkout_capabilities(created.order_id, created.attempt_id, repeat('1',64), repeat('2',64), '$capabilityHash', now() + interval '7 days') from created; select public.attach_stripe_checkout_session('$initialKey', 'cs_test_recovery_concurrency', now() + interval '20 minutes'); update public.checkout_sessions set expires_at = now() - interval '1 second' where attempt_key = '$initialKey'; update public.stock_reservations set expires_at = now() - interval '1 second' where order_id = (select order_id from public.checkout_sessions where attempt_key = '$initialKey') and status = 'held';"
  Invoke-LocalSql $prepare | Out-Null

  $recoverySql = "set role service_role; select attempt_id::text from public.recover_guest_checkout_attempt('$capabilityHash', now() + interval '20 minutes');"
  $jobs = @(
    Start-Job -ArgumentList $dockerPath, $container, $recoverySql -ScriptBlock {
      param($DockerPath, $Container, $Sql)
      $output = & $DockerPath exec $Container psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -At -c $Sql 2>&1
      [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n").Trim() }
    }
    Start-Job -ArgumentList $dockerPath, $container, $recoverySql -ScriptBlock {
      param($DockerPath, $Container, $Sql)
      $output = & $DockerPath exec $Container psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -At -c $Sql 2>&1
      [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n").Trim() }
    }
  )
  $jobs | Wait-Job | Out-Null
  $results = @($jobs | Receive-Job)
  $jobs | Remove-Job
  if (@($results | Where-Object { $_.ExitCode -eq 0 }).Count -ne 2) {
    throw "Concurrent recovery failed: $($results | ConvertTo-Json -Compress)"
  }
  $attemptIds = @($results | ForEach-Object { $_.Output } | Sort-Object -Unique)
  if ($attemptIds.Count -ne 1) {
    throw "Concurrent requests created different attempts: $($results | ConvertTo-Json -Compress)"
  }

  $attemptCount = Invoke-LocalSql "select count(*) from public.checkout_sessions where id = '$($attemptIds[0])';"
  if ($attemptCount -ne "1") {
    throw "Expected one checkout attempt for concurrent recovery key, found '$attemptCount'."
  }

  $handoffSql = "set role service_role; select count(*) from public.exchange_guest_checkout_handoff(repeat('1',64));"
  $handoffJobs = @(
    Start-Job -ArgumentList $dockerPath, $container, $handoffSql -ScriptBlock {
      param($DockerPath, $Container, $Sql)
      $output = & $DockerPath exec $Container psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -At -c $Sql 2>&1
      [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n").Trim() }
    }
    Start-Job -ArgumentList $dockerPath, $container, $handoffSql -ScriptBlock {
      param($DockerPath, $Container, $Sql)
      $output = & $DockerPath exec $Container psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -At -c $Sql 2>&1
      [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n").Trim() }
    }
  )
  $handoffJobs | Wait-Job | Out-Null
  $handoffResults = @($handoffJobs | Receive-Job)
  $handoffJobs | Remove-Job
  if (@($handoffResults | Where-Object { $_.ExitCode -eq 0 }).Count -ne 2) {
    throw "Concurrent handoff exchange failed: $($handoffResults | ConvertTo-Json -Compress)"
  }
  if (($handoffResults | Measure-Object -Property Output -Sum).Sum -ne 1) {
    throw "Expected exactly one concurrent handoff exchange to succeed: $($handoffResults | ConvertTo-Json -Compress)"
  }
  Write-Output "PASS: concurrent recovery requests reused one database-backed checkout attempt."
  Write-Output "PASS: concurrent handoff requests consumed the capability exactly once."
}
finally {
  Invoke-LocalSql "delete from public.orders where customer_email = '$email'; delete from public.products where id = '$productId';" | Out-Null
}
