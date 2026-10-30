begin;

do $test$
declare
  product_id text := 'bp-payment-' || replace(gen_random_uuid()::text, '-', '');
  access_hash bytea := extensions.digest(convert_to('payment-lifecycle-test-access-token', 'UTF8'), 'sha256');
  success_order_id uuid;
  failed_order_id uuid;
  cancelled_order_id uuid;
  uncreated_order_id uuid;
  checkout_result text;
  released_count integer;
  rejected boolean;
begin
  insert into public.products (
    id, name, category, price, sale_price, stock_quantity, is_available, is_published
  )
  values (
    product_id, product_id, 'testing', 10.00, 7.50, 20, true, true
  );

  success_order_id := public.create_checkout_order(
    gen_random_uuid(),
    'Payment Test Customer',
    '+441234567890',
    '1 Payment Test Street',
    'ZZ',
    'PAYMENTTEST1',
    access_hash,
    jsonb_build_array(jsonb_build_object('id', product_id, 'quantity', 1))
  );
  perform public.claim_sumup_checkout(success_order_id, access_hash, 'TESTMERCHANT');
  perform public.save_sumup_checkout(
    success_order_id,
    'test-sumup-checkout-success',
    'https://checkout.sumup.com/pay/test-sumup-checkout-success',
    'TESTMERCHANT'
  );

  rejected := false;
  begin
    perform public.get_sumup_checkout_for_verification(
      success_order_id,
      extensions.digest(convert_to('wrong-access-token', 'UTF8'), 'sha256')
    );
  exception when sqlstate 'P0002' then
    rejected := true;
  end;
  if not rejected then
    raise exception 'Payment status was exposed to a request with the wrong checkout access token';
  end if;

  update public.orders
  set checkout_reservation_expires_at = clock_timestamp() - interval '1 second'
  where id = success_order_id;
  update public.order_inventory_reservations
  set expires_at = clock_timestamp() - interval '1 second'
  where order_id = success_order_id;

  if public.release_expired_checkout_reservations(100) <> 0 then
    raise exception 'An expired pending payment released its inventory before provider verification';
  end if;

  checkout_result := public.record_sumup_checkout_verification(
    success_order_id,
    'test-sumup-checkout-success',
    success_order_id::text,
    'TESTMERCHANT',
    'PAID',
    'SUCCESSFUL',
    1210,
    'GBP',
    'TEST-TXN-SUCCESS'
  );
  if checkout_result <> 'paid'
     or (select payment_status from public.orders where id = success_order_id) <> 'paid'
     or (select payment_reference from public.orders where id = success_order_id) <> 'TEST-TXN-SUCCESS'
     or (select total_minor from public.orders where id = success_order_id) <> 1210
     or (select count(*) from public.order_inventory_reservations
         where order_id = success_order_id and status = 'consumed' and consumed_at is not null) <> 1
     or (select stock_quantity from public.products where id = product_id) <> 19 then
    raise exception 'Verified successful payment did not consume the reservation and preserve stock';
  end if;

  checkout_result := public.record_sumup_checkout_verification(
    success_order_id,
    'test-sumup-checkout-success',
    success_order_id::text,
    'TESTMERCHANT',
    'PAID',
    'SUCCESSFUL',
    1210,
    'GBP',
    'TEST-TXN-SUCCESS'
  );
  if checkout_result <> 'paid'
     or public.release_expired_checkout_reservations(100) <> 0
     or (select stock_quantity from public.products where id = product_id) <> 19 then
    raise exception 'Duplicate successful verification changed payment or stock state';
  end if;

  failed_order_id := public.create_checkout_order(
    gen_random_uuid(),
    'Payment Test Customer',
    '+441234567890',
    '1 Payment Test Street',
    'ZZ',
    'PAYMENTTEST1',
    access_hash,
    jsonb_build_array(jsonb_build_object('id', product_id, 'quantity', 1))
  );
  perform public.claim_sumup_checkout(failed_order_id, access_hash, 'TESTMERCHANT');
  perform public.save_sumup_checkout(
    failed_order_id,
    'test-sumup-checkout-failed',
    'https://checkout.sumup.com/pay/test-sumup-checkout-failed',
    'TESTMERCHANT'
  );

  rejected := false;
  begin
    perform public.record_sumup_checkout_verification(
      failed_order_id,
      'test-sumup-checkout-failed',
      failed_order_id::text,
      'TESTMERCHANT',
      'PAID',
      'SUCCESSFUL',
      1024,
      'GBP',
      'TEST-TXN-WRONG-AMOUNT'
    );
  exception when sqlstate 'P0001' then
    rejected := true;
  end;
  if not rejected
     or (select payment_status from public.orders where id = failed_order_id) <> 'pending'
     or (select count(*) from public.order_inventory_reservations
         where order_id = failed_order_id and status = 'reserved') <> 1 then
    raise exception 'A rejected payment verification changed the order or reservation state';
  end if;

  checkout_result := public.record_sumup_checkout_verification(
    failed_order_id,
    'test-sumup-checkout-failed',
    failed_order_id::text,
    'TESTMERCHANT',
    'FAILED',
    'FAILED',
    1210,
    'GBP',
    null
  );
  if checkout_result <> 'pending'
     or (select payment_status from public.orders where id = failed_order_id) <> 'pending'
     or (select count(*) from public.order_inventory_reservations
         where order_id = failed_order_id and status = 'reserved') <> 1
     or (select stock_quantity from public.products where id = product_id) <> 18 then
    raise exception 'A failed processing attempt released a retryable checkout reservation';
  end if;

  checkout_result := public.record_sumup_checkout_verification(
    failed_order_id,
    'test-sumup-checkout-failed',
    failed_order_id::text,
    'TESTMERCHANT',
    'PAID',
    'SUCCESSFUL',
    1210,
    'GBP',
    'TEST-TXN-RETRY'
  );
  if checkout_result <> 'paid'
     or (select payment_status from public.orders where id = failed_order_id) <> 'paid'
     or (select count(*) from public.order_inventory_reservations
         where order_id = failed_order_id and status = 'consumed') <> 1
     or (select stock_quantity from public.products where id = product_id) <> 18 then
    raise exception 'A retry succeeding after a failed attempt did not consume its reservation';
  end if;

  cancelled_order_id := public.create_checkout_order(
    gen_random_uuid(),
    'Payment Test Customer',
    '+441234567890',
    '1 Payment Test Street',
    'ZZ',
    'PAYMENTTEST1',
    access_hash,
    jsonb_build_array(jsonb_build_object('id', product_id, 'quantity', 1))
  );
  perform public.claim_sumup_checkout(cancelled_order_id, access_hash, 'TESTMERCHANT');
  perform public.save_sumup_checkout(
    cancelled_order_id,
    'test-sumup-checkout-cancelled',
    'https://checkout.sumup.com/pay/test-sumup-checkout-cancelled',
    'TESTMERCHANT'
  );
  checkout_result := public.record_sumup_checkout_verification(
    cancelled_order_id,
    'test-sumup-checkout-cancelled',
    cancelled_order_id::text,
    'TESTMERCHANT',
    'PENDING',
    'CANCELLED',
    1210,
    'GBP',
    null
  );
  if checkout_result <> 'pending'
     or (select payment_status from public.orders where id = cancelled_order_id) <> 'pending'
     or (select count(*) from public.order_inventory_reservations
         where order_id = cancelled_order_id and status = 'reserved') <> 1
     or (select stock_quantity from public.products where id = product_id) <> 17 then
    raise exception 'A cancelled transaction attempt released a still-open checkout reservation';
  end if;

  checkout_result := public.record_sumup_checkout_verification(
    cancelled_order_id,
    'test-sumup-checkout-cancelled',
    cancelled_order_id::text,
    'TESTMERCHANT',
    'EXPIRED',
    'CANCELLED',
    1210,
    'GBP',
    null
  );
  if checkout_result <> 'expired'
     or (select payment_status from public.orders where id = cancelled_order_id) <> 'expired'
     or (select count(*) from public.order_inventory_reservations
         where order_id = cancelled_order_id and status = 'released') <> 1
     or (select stock_quantity from public.products where id = product_id) <> 18 then
    raise exception 'Expired checkout after a cancelled attempt did not release its reservation';
  end if;

  uncreated_order_id := public.create_checkout_order(
    gen_random_uuid(),
    'Payment Test Customer',
    '+441234567890',
    '1 Payment Test Street',
    'ZZ',
    'PAYMENTTEST1',
    access_hash,
    jsonb_build_array(jsonb_build_object('id', product_id, 'quantity', 1))
  );
  perform public.claim_sumup_checkout(uncreated_order_id, access_hash, 'TESTMERCHANT');
  perform public.save_sumup_checkout(
    uncreated_order_id,
    'test-sumup-checkout-expired',
    'https://checkout.sumup.com/pay/test-sumup-checkout-expired',
    'TESTMERCHANT'
  );
  checkout_result := public.record_sumup_checkout_verification(
    uncreated_order_id,
    'test-sumup-checkout-expired',
    uncreated_order_id::text,
    'TESTMERCHANT',
    'EXPIRED',
    null,
    1210,
    'GBP',
    null
  );
  if checkout_result <> 'expired'
     or (select payment_status from public.orders where id = uncreated_order_id) <> 'expired'
     or (select count(*) from public.order_inventory_reservations
         where order_id = uncreated_order_id and status = 'released') <> 1
     or (select stock_quantity from public.products where id = product_id) <> 18 then
    raise exception 'Expired provider checkout did not release its reservation exactly once';
  end if;

  uncreated_order_id := public.create_checkout_order(
    gen_random_uuid(),
    'Payment Test Customer',
    '+441234567890',
    '1 Payment Test Street',
    'ZZ',
    'PAYMENTTEST1',
    access_hash,
    jsonb_build_array(jsonb_build_object('id', product_id, 'quantity', 1))
  );
  perform public.claim_sumup_checkout(uncreated_order_id, access_hash, 'TESTMERCHANT');
  update public.orders
  set checkout_reservation_expires_at = clock_timestamp() - interval '1 second'
  where id = uncreated_order_id;
  update public.order_inventory_reservations
  set expires_at = clock_timestamp() - interval '1 second'
  where order_id = uncreated_order_id;
  update public.sumup_checkout_sessions
  set creation_lease_until = clock_timestamp() - interval '1 second'
  where order_id = uncreated_order_id;

  if not public.expire_uncreated_sumup_checkout(uncreated_order_id) then
    raise exception 'Expired uncreated payment could not be finalized';
  end if;
  if (select payment_status from public.orders where id = uncreated_order_id) <> 'expired'
     or (select count(*) from public.order_inventory_reservations
         where order_id = uncreated_order_id and status = 'released') <> 1
     or (select stock_quantity from public.products where id = product_id) <> 18 then
    raise exception 'Expired uncreated payment did not release its reservation safely';
  end if;
  if public.expire_uncreated_sumup_checkout(uncreated_order_id) then
    raise exception 'Repeated expiration changed a terminal payment attempt';
  end if;

  released_count := public.release_expired_checkout_reservations(100);
  if released_count <> 0
     or (select stock_quantity from public.products where id = product_id) <> 18 then
    raise exception 'Repeated reservation release restored stock more than once';
  end if;
end;
$test$;

reset role;
set local role anon;

do $test$
declare
  denied boolean := false;
begin
  begin
    perform public.claim_sumup_checkout(
      gen_random_uuid(),
      extensions.digest(convert_to('unauthorized-token', 'UTF8'), 'sha256'),
      'TESTMERCHANT'
    );
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'Anonymous clients invoked the privileged SumUp checkout claim RPC';
  end if;

  denied := false;
  begin
    perform public.record_sumup_checkout_verification(
      gen_random_uuid(), 'checkout', 'reference', 'merchant',
      'PAID', 'SUCCESSFUL', 1, 'GBP', 'transaction'
    );
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'Anonymous clients invoked the privileged payment verification RPC';
  end if;

  denied := false;
  begin
    perform count(*) from public.checkout_delivery_zones;
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'Anonymous clients read private delivery-zone configuration';
  end if;

  denied := false;
  begin
    perform count(*) from public.sumup_checkout_sessions;
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'Anonymous clients read private payment-session details';
  end if;
end;
$test$;

reset role;
rollback;
