begin;

insert into public.checkout_settings (
  id,
  delivery_amount_pence,
  rate_limit_max_requests,
  rate_limit_window_seconds,
  reservation_lifetime_seconds
)
values (true, 275, 5, 60, 1800)
on conflict (id) do update
set delivery_amount_pence = excluded.delivery_amount_pence,
    rate_limit_max_requests = excluded.rate_limit_max_requests,
    rate_limit_window_seconds = excluded.rate_limit_window_seconds,
    reservation_lifetime_seconds = excluded.reservation_lifetime_seconds;

insert into public.products (
  id, name, category, price, sale_price, stock_quantity, is_available, is_published
)
values
  ('bp-checkout-tracked', 'Tracked checkout test product', 'testing', 10.00, 7.50, 5, true, true),
  ('bp-checkout-tracked-two', 'Second tracked checkout test product', 'testing', 4.00, null, 10, true, true),
  ('bp-checkout-untracked', 'Untracked checkout test product', 'testing', 3.25, null, null, true, true),
  ('bp-checkout-unavailable', 'Unavailable checkout test product', 'testing', 4.00, null, 5, false, true)
on conflict (id) do update
set price = excluded.price,
    sale_price = excluded.sale_price,
    stock_quantity = excluded.stock_quantity,
    is_available = excluded.is_available,
    is_published = excluded.is_published;

insert into public.checkout_delivery_zones (
  zone_code, display_name, coverage_description, delivery_amount_minor, currency, is_active
)
values ('TEST-ZONE', 'Test delivery zone', 'Synthetic test fixture only', 275, 'GBP', true)
on conflict (zone_code) do update
set delivery_amount_minor = excluded.delivery_amount_minor,
    is_active = excluded.is_active;

insert into public.checkout_delivery_destinations (country_code, postal_code, zone_code)
values ('ZZ', 'BPTEST123', 'TEST-ZONE')
on conflict (country_code, postal_code) do update set zone_code = excluded.zone_code;

set local role service_role;

do $test$
declare
  first_order uuid;
  retry_order uuid;
  unknown_destination_order uuid;
  rejected boolean;
  request_number integer;
begin
  for request_number in 1..5 loop
    if not public.consume_checkout_request_limit(
      extensions.digest(convert_to('checkout-foundation-rate-test', 'UTF8'), 'sha256')
    ) then
      raise exception 'A request within the configured rate limit was rejected';
    end if;
  end loop;

  if public.consume_checkout_request_limit(
    extensions.digest(convert_to('checkout-foundation-rate-test', 'UTF8'), 'sha256')
  ) then
    raise exception 'A request beyond the configured rate limit was accepted';
  end if;

  if public.consume_checkout_request_limit(
    extensions.digest(convert_to('checkout-foundation-rate-test', 'UTF8'), 'sha256')
  ) then
    raise exception 'A repeated request beyond the rate limit was accepted';
  end if;

  first_order := public.create_checkout_order(
    '00000000-0000-4000-8000-000000000601',
    ' Test Customer ',
    '+44 (0) 1234567890',
    ' 1 Checkout Test Street ',
    'ZZ',
    'BP TEST-123',
    decode(repeat('01', 32), 'hex'),
    '[
      {"id":"bp-checkout-tracked","quantity":2,"price":0.01,"deliveryFee":0,"deliveryFeeMinor":0,"total":0},
      {"id":"bp-checkout-tracked-two","quantity":2,"price":0.01,"deliveryFee":0,"deliveryFeeMinor":0,"total":0},
      {"id":"bp-checkout-untracked","quantity":3,"price":0.01,"deliveryFee":0,"deliveryFeeMinor":0,"total":0}
    ]'::jsonb
  );

  retry_order := public.create_checkout_order(
    '00000000-0000-4000-8000-000000000601',
    'Test Customer',
    '+44 (0) 1234567890',
    '1 Checkout Test Street',
    'ZZ',
    'BPTEST123',
    decode(repeat('01', 32), 'hex'),
    '[
      {"id":"bp-checkout-tracked","quantity":2,"price":9000,"deliveryFee":9999,"deliveryFeeMinor":9999,"total":9999},
      {"id":"bp-checkout-tracked-two","quantity":2,"price":9999,"deliveryFee":9999,"deliveryFeeMinor":9999,"total":9999},
      {"id":"bp-checkout-untracked","quantity":3,"price":9999,"deliveryFee":9999,"deliveryFeeMinor":9999,"total":9999}
    ]'::jsonb
  );
  if retry_order <> first_order then
    raise exception 'An idempotent retry did not return the original order ID';
  end if;

  rejected := false;
  begin
    perform public.create_checkout_order(
      '00000000-0000-4000-8000-000000000601',
      'Different Customer',
      '+44 (0) 1234567890',
      '1 Checkout Test Street',
      'ZZ',
      'BPTEST123',
      decode(repeat('01', 32), 'hex'),
      '[
        {"id":"bp-checkout-tracked","quantity":2},
        {"id":"bp-checkout-tracked-two","quantity":2},
        {"id":"bp-checkout-untracked","quantity":3}
      ]'::jsonb
    );
  exception when sqlstate 'P0001' then
    rejected := true;
  end;
  if not rejected then
    raise exception 'Reusing an idempotency key with a different customer was accepted';
  end if;

  rejected := false;
  begin
    perform public.create_checkout_order(
      '00000000-0000-4000-8000-000000000601',
      'Test Customer',
      '+44 (0) 1234567890',
      '1 Checkout Test Street',
      'ZZ',
      'BPTEST123',
      decode(repeat('01', 32), 'hex'),
      '[
        {"id":"bp-checkout-tracked","quantity":1},
        {"id":"bp-checkout-tracked-two","quantity":2},
        {"id":"bp-checkout-untracked","quantity":3}
      ]'::jsonb
    );
  exception when sqlstate 'P0001' then
    rejected := true;
  end;
  if not rejected then
    raise exception 'Reusing an idempotency key with a different cart quantity was accepted';
  end if;

  rejected := false;
  begin
    perform public.create_checkout_order(
      '00000000-0000-4000-8000-000000000601',
      'Test Customer',
      '+44 (0) 1234567890',
      '1 Checkout Test Street',
      'ZZ',
      'BPTEST123',
      decode(repeat('02', 32), 'hex'),
      '[
        {"id":"bp-checkout-tracked","quantity":2},
        {"id":"bp-checkout-tracked-two","quantity":2},
        {"id":"bp-checkout-untracked","quantity":3}
      ]'::jsonb
    );
  exception when sqlstate 'P0001' then
    rejected := true;
  end;
  if not rejected then
    raise exception 'An idempotent retry with a different checkout access token was accepted';
  end if;

  rejected := false;
  begin
    perform public.create_checkout_order(
      '00000000-0000-4000-8000-000000000602',
      '   ',
      'not a phone',
      '',
      'ZZ',
      'BPTEST123',
      decode(repeat('01', 32), 'hex'),
      '[]'::jsonb
    );
  exception when sqlstate '22023' then
    rejected := true;
  end;
  if not rejected then
    raise exception 'Malformed customer or cart data was accepted';
  end if;

  rejected := false;
  begin
    perform public.create_checkout_order(
      '00000000-0000-4000-8000-000000000603',
      'Test Customer',
      '+441234567890',
      '1 Checkout Test Street',
      'ZZ',
      'BPTEST123',
      decode(repeat('01', 32), 'hex'),
      '[{"id":"bp-checkout-tracked","quantity":1.5}]'::jsonb
    );
  exception when sqlstate '22023' then
    rejected := true;
  end;
  if not rejected then
    raise exception 'A fractional product quantity was accepted';
  end if;

  rejected := false;
  begin
    perform public.create_checkout_order(
      '00000000-0000-4000-8000-000000000604',
      'Test Customer',
      '+441234567890',
      '1 Checkout Test Street',
      'ZZ',
      'BPTEST123',
      decode(repeat('01', 32), 'hex'),
      '[{"id":"bp-checkout-unavailable","quantity":1}]'::jsonb
    );
  exception when sqlstate 'P0002' then
    rejected := true;
  end;
  if not rejected then
    raise exception 'An unavailable product was accepted';
  end if;

  rejected := false;
  begin
    perform public.create_checkout_order(
      '00000000-0000-4000-8000-000000000605',
      'Test Customer',
      '+441234567890',
      '1 Checkout Test Street',
      'ZZ',
      'BPTEST123',
      decode(repeat('01', 32), 'hex'),
      '[{"id":"bp-checkout-tracked","quantity":4}]'::jsonb
    );
  exception when sqlstate 'P0002' then
    rejected := true;
  end;
  if not rejected then
    raise exception 'An order exceeding tracked stock was accepted';
  end if;

  unknown_destination_order := public.create_checkout_order(
    '00000000-0000-4000-8000-000000000608',
    'Test Customer',
    '+441234567890',
    '1 Checkout Test Street',
    'ZZ',
    'UNKNOWN123',
    decode(repeat('01', 32), 'hex'),
    '[{"id":"bp-checkout-untracked","quantity":1}]'::jsonb
  );
  if unknown_destination_order is null then
    raise exception 'A valid delivery destination did not create an order';
  end if;

end;
$test$;

reset role;

do $test$
declare
  v_order_id uuid;
  unknown_destination_order uuid;
  order_row public.orders%rowtype;
  tracked_item_price numeric(10, 2);
  second_tracked_item_price numeric(10, 2);
  untracked_item_price numeric(10, 2);
  rejected boolean;
begin
  select id into v_order_id
  from public.orders
  where checkout_idempotency_key = '00000000-0000-4000-8000-000000000601';

  select * into order_row
  from public.orders
  where id = v_order_id;

  select unit_price into tracked_item_price
  from public.order_items
  where order_items.order_id = v_order_id and product_id = 'bp-checkout-tracked';

  select unit_price into second_tracked_item_price
  from public.order_items
  where order_items.order_id = v_order_id and product_id = 'bp-checkout-tracked-two';

  select unit_price into untracked_item_price
  from public.order_items
  where order_items.order_id = v_order_id and product_id = 'bp-checkout-untracked';

  if v_order_id is null
     or order_row.subtotal is distinct from 32.75
     or order_row.delivery_fee is distinct from 4.60
     or order_row.total is distinct from 37.35
     or order_row.subtotal_minor is distinct from 3275
     or order_row.delivery_fee_minor is distinct from 460
     or order_row.total_minor is distinct from 3735
     or order_row.currency is distinct from 'GBP'
     or order_row.delivery_zone_code is not null
     or order_row.delivery_country_code is distinct from 'ZZ'
     or order_row.delivery_postal_code is distinct from 'BPTEST123'
     or order_row.fulfillment_status is distinct from 'pending'
     or order_row.payment_status is distinct from 'unverified'
     or order_row.payment_provider is not null
     or order_row.payment_reference is not null
     or tracked_item_price is distinct from 7.50
     or second_tracked_item_price is distinct from 4.00
     or untracked_item_price is distinct from 3.25 then
    raise exception 'Checkout did not use authoritative prices or calculate the fixed delivery fee';
  end if;

  select id into unknown_destination_order
  from public.orders
  where checkout_idempotency_key = '00000000-0000-4000-8000-000000000608';

  if unknown_destination_order is null
     or (select delivery_fee_minor from public.orders where id = unknown_destination_order) <> 460
     or (select total_minor from public.orders where id = unknown_destination_order) <> 785 then
    raise exception 'A valid unmapped destination did not receive exactly one fixed delivery fee';
  end if;

  if (select stock_quantity from public.products where id = 'bp-checkout-tracked') is distinct from 3
     or (select stock_quantity from public.products where id = 'bp-checkout-tracked-two') is distinct from 8
     or (select stock_quantity from public.products where id = 'bp-checkout-untracked') is not null
     or (select count(*) from public.order_inventory_reservations where order_id = v_order_id) <> 2
     or (select count(*) from public.orders where checkout_idempotency_key = '00000000-0000-4000-8000-000000000601') <> 1 then
    raise exception 'Tracked/untracked inventory or retry behavior was incorrect';
  end if;

  if public.release_expired_checkout_reservations(100) <> 0 then
    raise exception 'An unexpired reservation was released';
  end if;

  rejected := false;
  begin
    perform public.release_expired_checkout_reservations(0);
  exception when sqlstate '22023' then
    rejected := true;
  end;
  if not rejected then
    raise exception 'An invalid reservation release batch size was accepted';
  end if;

  update public.order_inventory_reservations
  set expires_at = clock_timestamp() - interval '1 second'
  where order_id = v_order_id;
  update public.orders
  set checkout_reservation_expires_at = clock_timestamp() - interval '1 second'
  where id = v_order_id;

  rejected := false;
  begin
    perform public.create_checkout_order(
      '00000000-0000-4000-8000-000000000601',
      'Test Customer',
      '+44 (0) 1234567890',
      '1 Checkout Test Street',
      'ZZ',
      'BPTEST123',
      decode(repeat('01', 32), 'hex'),
      '[
        {"id":"bp-checkout-tracked","quantity":2},
        {"id":"bp-checkout-tracked-two","quantity":2},
        {"id":"bp-checkout-untracked","quantity":3}
      ]'::jsonb
    );
  exception when sqlstate 'P0001' then
    rejected := true;
  end;
  if not rejected then
    raise exception 'An expired checkout was returned as active';
  end if;

  if public.release_expired_checkout_reservations(100) <> 2 then
    raise exception 'Eligible expired reservations were not released';
  end if;
  if (select stock_quantity from public.products where id = 'bp-checkout-tracked') is distinct from 5
     or (select stock_quantity from public.products where id = 'bp-checkout-tracked-two') is distinct from 10
     or (select count(*) from public.order_inventory_reservations
         where order_id = v_order_id and status = 'released' and released_at is not null) <> 2 then
    raise exception 'Reservation release did not restore exactly the held tracked stock';
  end if;

  if public.release_expired_checkout_reservations(100) <> 0
     or (select stock_quantity from public.products where id = 'bp-checkout-tracked') is distinct from 5
     or (select stock_quantity from public.products where id = 'bp-checkout-tracked-two') is distinct from 10 then
    raise exception 'A repeated release restored stock more than once';
  end if;

  delete from public.checkout_settings where id;
end;
$test$;

set local role service_role;

do $test$
declare
  rejected boolean := false;
begin
  begin
    perform public.consume_checkout_request_limit(
      extensions.digest(convert_to('checkout-foundation-unconfigured-limit', 'UTF8'), 'sha256')
    );
  exception when sqlstate '55000' then
    rejected := true;
  end;
  if not rejected then
    raise exception 'Checkout rate limiting succeeded without configured request limits';
  end if;

  rejected := false;
  begin
    perform public.create_checkout_order(
      '00000000-0000-4000-8000-000000000606',
      'Test Customer',
      '+441234567890',
      '1 Checkout Test Street',
      'ZZ',
      'BPTEST123',
      decode(repeat('01', 32), 'hex'),
      '[{"id":"bp-checkout-untracked","quantity":1}]'::jsonb
    );
  exception when sqlstate '55000' then
    rejected := true;
  end;
  if not rejected then
    raise exception 'Checkout succeeded without configured delivery pricing';
  end if;
end;
$test$;

reset role;
set local role anon;

do $test$
declare
  denied boolean := false;
  delivery_amount bigint;
begin
  begin
    insert into public.orders (customer_name, payment_status)
    values ('Unauthorized checkout test', 'unverified');
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'Anonymous clients directly created an order';
  end if;

  denied := false;
  begin
    perform public.create_checkout_order(
      '00000000-0000-4000-8000-000000000607',
      'Test Customer',
      '+441234567890',
      '1 Checkout Test Street',
      'ZZ',
      'BPTEST123',
      decode(repeat('01', 32), 'hex'),
      '[{"id":"bp-checkout-untracked","quantity":1}]'::jsonb
    );
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'Anonymous clients invoked the privileged checkout RPC';
  end if;

  denied := false;
  begin
    perform public.consume_checkout_request_limit(
      extensions.digest(convert_to('checkout-foundation-rate-test', 'UTF8'), 'sha256')
    );
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'Anonymous clients invoked the privileged rate-limit RPC';
  end if;

  denied := false;
  begin
    perform public.release_expired_checkout_reservations(100);
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'Anonymous clients invoked the privileged reservation release RPC';
  end if;

  denied := false;
  begin
    select delivery_amount_pence into delivery_amount
    from public.checkout_settings;
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'Anonymous clients read private checkout settings';
  end if;

  denied := false;
  begin
    insert into public.checkout_settings (id, delivery_amount_pence)
    values (true, 0);
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'Anonymous clients changed private checkout settings';
  end if;

  denied := false;
  begin
    update public.checkout_settings
    set delivery_amount_pence = 0
    where id = true;
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'Anonymous clients updated private checkout settings';
  end if;
end;
$test$;

reset role;
set local role authenticated;

do $test$
declare
  denied boolean := false;
begin
  begin
    update public.orders
    set payment_status = 'paid'
    where checkout_idempotency_key = '00000000-0000-4000-8000-000000000601';
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'Authenticated clients directly changed payment status';
  end if;

  denied := false;
  begin
    perform public.release_expired_checkout_reservations(100);
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'Authenticated clients invoked the privileged reservation release RPC';
  end if;
end;
$test$;

reset role;

rollback;
