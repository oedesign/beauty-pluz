begin;

insert into public.checkout_settings (
  id,
  delivery_amount_pence,
  rate_limit_max_requests,
  rate_limit_window_seconds,
  reservation_lifetime_seconds
)
values (true, 460, 5, 60, 1800)
on conflict (id) do update
set reservation_lifetime_seconds = excluded.reservation_lifetime_seconds;

insert into public.products (
  id, name, category, price, stock_quantity, is_available, is_published
)
values
  ('bp-integrity-' || replace(gen_random_uuid()::text, '-', ''), 'Integrity tracked', 'testing', 10.00, 20, true, true),
  ('bp-integrity-' || replace(gen_random_uuid()::text, '-', ''), 'Integrity other tracked', 'testing', 4.00, 20, true, true),
  ('bp-integrity-' || replace(gen_random_uuid()::text, '-', ''), 'Integrity untracked', 'testing', 2.00, null, true, true);

create function pg_temp.reject_integrity_reservation()
returns trigger
language plpgsql
as $function$
begin
  raise exception using errcode = 'P0001', message = 'Injected reservation insert failure';
end;
$function$;

create trigger checkout_integrity_test_reject_reservation
before insert on public.order_inventory_reservations
for each row
execute function pg_temp.reject_integrity_reservation();

do $test$
declare
  tracked_product_id text;
  other_product_id text;
  untracked_product_id text;
  access_hash bytea := extensions.digest(convert_to('inventory-integrity-test-token', 'UTF8'), 'sha256');
  tracked_order_id uuid;
  untracked_order_id uuid;
  missing_reservation_order_id uuid;
  wrong_quantity_order_id uuid;
  wrong_product_order_id uuid;
  duplicate_item_order_id uuid;
  expired_order_id uuid;
  rejected boolean := false;
  result text;
  initial_stock integer;
begin
  select id into tracked_product_id from public.products where name = 'Integrity tracked';
  select id into other_product_id from public.products where name = 'Integrity other tracked';
  select id into untracked_product_id from public.products where name = 'Integrity untracked';
  initial_stock := (select stock_quantity from public.products where id = tracked_product_id);

  begin
    perform public.create_checkout_order(
      '00000000-0000-4000-8000-000000000901',
      'Integrity Test Customer',
      '+441234567890',
      '1 Integrity Test Street',
      'GB',
      'TEST123',
      access_hash,
      jsonb_build_array(jsonb_build_object('id', tracked_product_id, 'quantity', 1))
    );
  exception when sqlstate 'P0001' then
    rejected := true;
  end;
  drop trigger checkout_integrity_test_reject_reservation on public.order_inventory_reservations;

  if not rejected
     or (select stock_quantity from public.products where id = tracked_product_id) <> initial_stock
     or exists (
       select 1 from public.orders
       where checkout_idempotency_key = '00000000-0000-4000-8000-000000000901'
     )
     or exists (
       select 1 from public.order_inventory_reservations reservations
       join public.orders orders on orders.id = reservations.order_id
       where orders.checkout_idempotency_key = '00000000-0000-4000-8000-000000000901'
     ) then
    raise exception 'Failed reservation insertion did not roll back checkout and stock deduction';
  end if;

  tracked_order_id := public.create_checkout_order(
    gen_random_uuid(),
    'Integrity Test Customer',
    '+441234567890',
    '1 Integrity Test Street',
    'GB',
    'TEST123',
    access_hash,
    jsonb_build_array(jsonb_build_object('id', tracked_product_id, 'quantity', 1))
  );
  if (select stock_quantity from public.products where id = tracked_product_id) <> initial_stock - 1
     or (select count(*) from public.order_inventory_reservations
         where order_id = tracked_order_id and product_id = tracked_product_id
           and quantity = 1 and status = 'reserved') <> 1
     or (select inventory_tracked from public.order_items
         where order_id = tracked_order_id and product_id = tracked_product_id) is distinct from true then
    raise exception 'Tracked checkout did not atomically deduct stock and create its snapshot and reservation';
  end if;

  perform public.claim_sumup_checkout(tracked_order_id, access_hash, 'TESTMERCHANT');
  perform public.save_sumup_checkout(
    tracked_order_id,
    'integrity-tracked-checkout',
    'https://checkout.sumup.com/pay/integrity-tracked-checkout',
    'TESTMERCHANT'
  );
  result := public.record_sumup_checkout_verification(
    tracked_order_id,
    'integrity-tracked-checkout',
    tracked_order_id::text,
    'TESTMERCHANT',
    'PAID',
    'SUCCESSFUL',
    1460,
    'GBP',
    'INTEGRITY-TXN-TRACKED'
  );
  if result <> 'paid'
     or (select stock_quantity from public.products where id = tracked_product_id) <> initial_stock - 1
     or (select count(*) from public.order_inventory_reservations
         where order_id = tracked_order_id and status = 'consumed') <> 1 then
    raise exception 'Successful payment did not consume the reservation without a second stock deduction';
  end if;
  result := public.record_sumup_checkout_verification(
    tracked_order_id,
    'integrity-tracked-checkout',
    tracked_order_id::text,
    'TESTMERCHANT',
    'PAID',
    'SUCCESSFUL',
    1460,
    'GBP',
    'INTEGRITY-TXN-TRACKED'
  );
  if result <> 'paid'
     or (select stock_quantity from public.products where id = tracked_product_id) <> initial_stock - 1
     or (select count(*) from public.order_inventory_reservations
         where order_id = tracked_order_id and status = 'consumed') <> 1 then
    raise exception 'Repeated successful verification was not idempotent';
  end if;

  untracked_order_id := public.create_checkout_order(
    gen_random_uuid(),
    'Integrity Test Customer',
    '+441234567890',
    '1 Integrity Test Street',
    'GB',
    'TEST123',
    access_hash,
    jsonb_build_array(jsonb_build_object('id', untracked_product_id, 'quantity', 1))
  );
  if (select stock_quantity from public.products where id = untracked_product_id) is not null
     or (select inventory_tracked from public.order_items
         where order_id = untracked_order_id and product_id = untracked_product_id) is distinct from false
     or exists (
       select 1 from public.order_inventory_reservations
       where order_id = untracked_order_id
     ) then
    raise exception 'Untracked product checkout incorrectly reserved inventory';
  end if;
  perform public.claim_sumup_checkout(untracked_order_id, access_hash, 'TESTMERCHANT');
  perform public.save_sumup_checkout(
    untracked_order_id,
    'integrity-untracked-checkout',
    'https://checkout.sumup.com/pay/integrity-untracked-checkout',
    'TESTMERCHANT'
  );
  result := public.record_sumup_checkout_verification(
    untracked_order_id,
    'integrity-untracked-checkout',
    untracked_order_id::text,
    'TESTMERCHANT',
    'PAID',
    'SUCCESSFUL',
    660,
    'GBP',
    'INTEGRITY-TXN-UNTRACKED'
  );
  if result <> 'paid'
     or (select payment_status from public.orders where id = untracked_order_id) <> 'paid'
     or exists (
       select 1 from public.order_inventory_reservations
       where order_id = untracked_order_id
     ) then
    raise exception 'Untracked order was not compatible with successful payment verification';
  end if;

  missing_reservation_order_id := public.create_checkout_order(
    gen_random_uuid(),
    'Integrity Test Customer',
    '+441234567890',
    '1 Integrity Test Street',
    'GB',
    'TEST123',
    access_hash,
    jsonb_build_array(jsonb_build_object('id', tracked_product_id, 'quantity', 1))
  );
  perform public.claim_sumup_checkout(missing_reservation_order_id, access_hash, 'TESTMERCHANT');
  perform public.save_sumup_checkout(
    missing_reservation_order_id,
    'integrity-missing-checkout',
    'https://checkout.sumup.com/pay/integrity-missing-checkout',
    'TESTMERCHANT'
  );
  delete from public.order_inventory_reservations
  where order_id = missing_reservation_order_id;
  rejected := false;
  begin
    perform public.record_sumup_checkout_verification(
      missing_reservation_order_id,
      'integrity-missing-checkout',
      missing_reservation_order_id::text,
      'TESTMERCHANT',
      'PAID',
      'SUCCESSFUL',
      1460,
      'GBP',
      'INTEGRITY-TXN-MISSING'
    );
  exception when sqlstate 'P0001' then
    rejected := true;
  end;
  if not rejected
     or (select payment_status from public.orders where id = missing_reservation_order_id) <> 'pending'
     or (select payment_state from public.sumup_checkout_sessions where order_id = missing_reservation_order_id) <> 'pending' then
    raise exception 'A tracked order with a missing reservation was marked paid';
  end if;

  wrong_quantity_order_id := public.create_checkout_order(
    gen_random_uuid(),
    'Integrity Test Customer',
    '+441234567890',
    '1 Integrity Test Street',
    'GB',
    'TEST123',
    access_hash,
    jsonb_build_array(jsonb_build_object('id', tracked_product_id, 'quantity', 1))
  );
  perform public.claim_sumup_checkout(wrong_quantity_order_id, access_hash, 'TESTMERCHANT');
  perform public.save_sumup_checkout(
    wrong_quantity_order_id,
    'integrity-wrong-quantity-checkout',
    'https://checkout.sumup.com/pay/integrity-wrong-quantity-checkout',
    'TESTMERCHANT'
  );
  update public.order_inventory_reservations
  set quantity = 2
  where order_id = wrong_quantity_order_id;
  rejected := false;
  begin
    perform public.record_sumup_checkout_verification(
      wrong_quantity_order_id,
      'integrity-wrong-quantity-checkout',
      wrong_quantity_order_id::text,
      'TESTMERCHANT',
      'PAID',
      'SUCCESSFUL',
      1460,
      'GBP',
      'INTEGRITY-TXN-WRONG-QUANTITY'
    );
  exception when sqlstate 'P0001' then
    rejected := true;
  end;
  if not rejected
     or (select payment_status from public.orders where id = wrong_quantity_order_id) <> 'pending' then
    raise exception 'A tracked order with a mismatched reservation quantity was marked paid';
  end if;

  wrong_product_order_id := public.create_checkout_order(
    gen_random_uuid(),
    'Integrity Test Customer',
    '+441234567890',
    '1 Integrity Test Street',
    'GB',
    'TEST123',
    access_hash,
    jsonb_build_array(jsonb_build_object('id', tracked_product_id, 'quantity', 1))
  );
  perform public.claim_sumup_checkout(wrong_product_order_id, access_hash, 'TESTMERCHANT');
  perform public.save_sumup_checkout(
    wrong_product_order_id,
    'integrity-wrong-product-checkout',
    'https://checkout.sumup.com/pay/integrity-wrong-product-checkout',
    'TESTMERCHANT'
  );
  update public.order_inventory_reservations
  set product_id = other_product_id
  where order_id = wrong_product_order_id;
  rejected := false;
  begin
    perform public.record_sumup_checkout_verification(
      wrong_product_order_id,
      'integrity-wrong-product-checkout',
      wrong_product_order_id::text,
      'TESTMERCHANT',
      'PAID',
      'SUCCESSFUL',
      1460,
      'GBP',
      'INTEGRITY-TXN-WRONG-PRODUCT'
    );
  exception when sqlstate 'P0001' then
    rejected := true;
  end;
  if not rejected
     or (select payment_status from public.orders where id = wrong_product_order_id) <> 'pending' then
    raise exception 'A tracked order with a mismatched reservation product was marked paid';
  end if;

  duplicate_item_order_id := public.create_checkout_order(
    gen_random_uuid(),
    'Integrity Test Customer',
    '+441234567890',
    '1 Integrity Test Street',
    'GB',
    'TEST123',
    access_hash,
    jsonb_build_array(jsonb_build_object('id', tracked_product_id, 'quantity', 1))
  );
  perform public.claim_sumup_checkout(duplicate_item_order_id, access_hash, 'TESTMERCHANT');
  perform public.save_sumup_checkout(
    duplicate_item_order_id,
    'integrity-duplicate-item-checkout',
    'https://checkout.sumup.com/pay/integrity-duplicate-item-checkout',
    'TESTMERCHANT'
  );
  insert into public.order_items (
    order_id, product_id, product_name, unit_price, quantity, inventory_tracked
  )
  select order_id, product_id, product_name, unit_price, quantity, inventory_tracked
  from public.order_items
  where order_id = duplicate_item_order_id;
  rejected := false;
  begin
    perform public.record_sumup_checkout_verification(
      duplicate_item_order_id,
      'integrity-duplicate-item-checkout',
      duplicate_item_order_id::text,
      'TESTMERCHANT',
      'PAID',
      'SUCCESSFUL',
      1460,
      'GBP',
      'INTEGRITY-TXN-DUPLICATE-ITEM'
    );
  exception when sqlstate 'P0001' then
    rejected := true;
  end;
  if not rejected
     or (select payment_status from public.orders where id = duplicate_item_order_id) <> 'pending' then
    raise exception 'A tracked order with duplicate product lines was marked paid';
  end if;

  expired_order_id := public.create_checkout_order(
    gen_random_uuid(),
    'Integrity Test Customer',
    '+441234567890',
    '1 Integrity Test Street',
    'GB',
    'TEST123',
    access_hash,
    jsonb_build_array(jsonb_build_object('id', tracked_product_id, 'quantity', 1))
  );
  perform public.claim_sumup_checkout(expired_order_id, access_hash, 'TESTMERCHANT');
  perform public.save_sumup_checkout(
    expired_order_id,
    'integrity-expired-checkout',
    'https://checkout.sumup.com/pay/integrity-expired-checkout',
    'TESTMERCHANT'
  );
  update public.orders
  set checkout_reservation_expires_at = clock_timestamp() - interval '1 second'
  where id = expired_order_id;
  update public.order_inventory_reservations
  set expires_at = clock_timestamp() - interval '1 second'
  where order_id = expired_order_id;
  result := public.record_sumup_checkout_verification(
    expired_order_id,
    'integrity-expired-checkout',
    expired_order_id::text,
    'TESTMERCHANT',
    'EXPIRED',
    null,
    1460,
    'GBP',
    null
  );
  if result <> 'expired'
     or (select payment_status from public.orders where id = expired_order_id) <> 'expired'
     or (select count(*) from public.order_inventory_reservations
         where order_id = expired_order_id and status = 'released') <> 1
     or (select stock_quantity from public.products where id = tracked_product_id) <> initial_stock - 5 then
    raise exception 'Expired checkout did not release its reserved stock exactly once';
  end if;
end;
$test$;

rollback;
