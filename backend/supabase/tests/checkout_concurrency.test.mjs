import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";

const root = new URL("../../..", import.meta.url).pathname.replace(
  /^\/([A-Z]:)/,
  "$1",
);
const prefix = `bp-concurrency-${randomUUID().replaceAll("-", "")}`;
const trackedProductId = `${prefix}-tracked`;
const untrackedProductId = `${prefix}-untracked`;
const checkoutKey = randomUUID();
const checkoutIdentity = randomBytes(32).toString("hex");
const limiterIdentity = randomBytes(32).toString("hex");

function runSql(sql) {
  return new Promise((resolve, reject) => {
    const process = spawn(
      "docker",
      [
        "exec",
        "-i",
        "supabase_db_backend",
        "psql",
        "-X",
        "-A",
        "-t",
        "-v",
        "VERBOSITY=verbose",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "postgres",
      ],
      { cwd: root, windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    process.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    process.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    process.on(
      "error",
      () => reject(new Error("Could not run a local Supabase SQL test.")),
    );
    process.on("close", (code) => {
      const output = `${stdout}\n${stderr}`;
      const errorCode = output.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1] || null;
      resolve({
        ok: code === 0,
        rateLimited: output.includes("P0001"),
        errorCode,
        stdout,
      });
    });
    process.stdin.end(sql);
  });
}

function rateLimitCall(identity, checkout = false) {
  const checkoutCall = checkout
    ? `perform public.create_checkout_order(
        '${checkoutKey}',
        'Concurrent Test Customer',
        '+441234567890',
        '1 Concurrent Test Street',
        'ZZ',
        'TEST123',
        decode(repeat('01', 32), 'hex'),
        '[{"id":"${trackedProductId}","quantity":2},{"id":"${untrackedProductId}","quantity":1}]'::jsonb
      );`
    : "";
  return `set role service_role;
    do $test$
    begin
      if not public.consume_checkout_request_limit(decode('${identity}', 'hex')) then
        raise exception using errcode = 'P0001', message = 'Test request rate limited';
      end if;
      ${checkoutCall}
    end;
    $test$;
    reset role;`;
}

async function callOrFail(sql) {
  const result = await runSql(sql);
  if (!result.ok) {
    throw new Error(
      `A local checkout concurrency setup/assertion failed${
        result.errorCode ? ` (SQLSTATE ${result.errorCode})` : ""
      }.`,
    );
  }
}

function concurrentResults(identity, count, checkout = false) {
  return Promise.all(
    Array.from(
      { length: count },
      () => runSql(rateLimitCall(identity, checkout)),
    ),
  );
}

async function cleanup() {
  const cleanupResult = await runSql(`delete from public.checkout_request_limits
    where identity_hash in (decode('${checkoutIdentity}', 'hex'), decode('${limiterIdentity}', 'hex'));
    delete from public.order_inventory_reservations
    where order_id in (
      select id from public.orders where checkout_idempotency_key = '${checkoutKey}'
    );
    delete from public.orders where checkout_idempotency_key = '${checkoutKey}';
    delete from public.products
    where id in ('${trackedProductId}', '${untrackedProductId}');`);
  if (!cleanupResult.ok) {
    throw new Error("Could not clean up local checkout concurrency fixtures.");
  }
}

try {
  await callOrFail(`do $test$
    begin
      if not exists (
        select 1 from public.checkout_settings
        where id
          and rate_limit_max_requests = 5
          and rate_limit_window_seconds = 60
          and reservation_lifetime_seconds between 60 and 604800
      ) then
        raise exception 'Test checkout policy is not configured for concurrency coverage';
      end if;
    end;
    $test$;
    insert into public.products (
      id, name, category, price, stock_quantity, is_available, is_published
    )
    values
      ('${trackedProductId}', '${prefix} tracked fixture', 'testing', 1.00, 50, true, true),
      ('${untrackedProductId}', '${prefix} untracked fixture', 'testing', 1.00, null, true, true);`);

  const checkoutResults = await concurrentResults(checkoutIdentity, 5, true);
  if (checkoutResults.some((result) => !result.ok)) {
    throw new Error(
      "Concurrent identical checkout requests did not all succeed within the configured limit.",
    );
  }

  await callOrFail(`do $test$
    declare
      v_order_id uuid;
    begin
      select id into v_order_id
      from public.orders
      where checkout_idempotency_key = '${checkoutKey}';

      if v_order_id is null
         or (select count(*) from public.orders where checkout_idempotency_key = '${checkoutKey}') <> 1
         or (select stock_quantity from public.products where id = '${trackedProductId}') <> 48
         or (select stock_quantity from public.products where id = '${untrackedProductId}') is not null
         or (select count(*) from public.order_inventory_reservations where order_inventory_reservations.order_id = v_order_id) <> 1
         or (select delivery_fee_minor from public.orders where id = v_order_id) <> 460
         or (select total_minor from public.orders where id = v_order_id) <> 760
         or (select payment_status from public.orders where id = v_order_id) <> 'unverified' then
        raise exception 'Concurrent checkout did not create one safe order with a single fixed delivery fee and reservation';
      end if;
    end;
    $test$;`);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await callOrFail(rateLimitCall(limiterIdentity));
  }

  const rateResults = await concurrentResults(limiterIdentity, 8);
  const allowedRequests = rateResults.filter((result) => result.ok).length;
  const rejectedRequests = rateResults.filter((result) =>
    !result.ok && result.rateLimited
  ).length;
  if (allowedRequests !== 1 || rejectedRequests !== 7) {
    throw new Error(
      "Concurrent requests did not obey the configured atomic rate limit.",
    );
  }

  console.log(
    "Passed: five concurrent identical checkouts created one order and reserved stock once.",
  );
  console.log(
    "Passed: concurrent requests at the rate-limit boundary allowed only the remaining request.",
  );
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Local checkout concurrency test failed.",
  );
  process.exitCode = 1;
} finally {
  await cleanup();
}
