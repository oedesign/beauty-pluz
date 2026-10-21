begin;

insert into auth.users
  (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000931', 'authenticated', 'authenticated', 'checkout-admin-test@example.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now())
on conflict (id) do nothing;

insert into public.beautypluz_admins (user_id)
values ('00000000-0000-0000-0000-000000000931')
on conflict (user_id) do nothing;

insert into public.products
  (id, name, category, price, sale_price, stock_quantity, is_available, is_published)
values
  ('bp-checkout-stock-1', 'Checkout stock product one', 'testing', 14.50, null, 1, true, true),
  ('bp-checkout-stock-2', 'Checkout stock product two', 'testing', 10.00, 8.50, 5, true, true),
  ('bp-checkout-stock-a', 'Checkout rollback product available', 'testing', 3.00, null, 2, true, true),
  ('bp-checkout-stock-z', 'Checkout rollback product unavailable', 'testing', 4.00, null, 0, true, true)
on conflict (id) do update
set price = excluded.price,
    sale_price = excluded.sale_price,
    stock_quantity = excluded.stock_quantity,
    is_available = excluded.is_available,
    is_published = excluded.is_published;

set local role service_role;

do $test$
declare
  attempt record;
  repeated_attempt record;
begin
  select * into attempt
  from public.create_checkout_attempt(
    'checkout-foundation-test-key-0001', null,
    'Checkout Test Customer', 'checkout-test@example.invalid',
    '+441234567890', '1 Test Street',
    '[{"product_id":"bp-checkout-stock-1","quantity":1},{"product_id":"bp-checkout-stock-2","quantity":2}]'::jsonb,
    0, now() + interval '20 minutes'
  );

  if attempt.amount_total <> 3150 or attempt.currency <> 'GBP' or attempt.reused then
    raise exception 'Basket total, currency, or initial-attempt result was incorrect';
  end if;

  select * into repeated_attempt
  from public.create_checkout_attempt(
    'checkout-foundation-test-key-0001', null,
    'Checkout Test Customer', 'checkout-test@example.invalid',
    '+441234567890', '1 Test Street',
    '[{"product_id":"bp-checkout-stock-2","quantity":2},{"product_id":"bp-checkout-stock-1","quantity":1}]'::jsonb,
    0, now() + interval '20 minutes'
  );

  if repeated_attempt.order_id <> attempt.order_id
     or repeated_attempt.attempt_id <> attempt.attempt_id
     or not repeated_attempt.reused then
    raise exception 'Repeated idempotency key created a different order or checkout attempt';
  end if;

  perform set_config('test.checkout_order_id', attempt.order_id::text, true);
  perform set_config('test.checkout_attempt_id', attempt.attempt_id::text, true);

  begin
    perform * from public.create_checkout_attempt(
      'checkout-foundation-test-key-0001', null,
      'Different Customer', 'different@example.invalid',
      null, null,
      '[{"product_id":"bp-checkout-stock-1","quantity":1}]'::jsonb,
      0, now() + interval '20 minutes'
    );
    raise exception 'Reusing an idempotency key with different data was accepted';
  exception
    when sqlstate '22023' then null;
  end;
end;
$test$;

reset role;

do $test$
declare
  checkout_order uuid := current_setting('test.checkout_order_id')::uuid;
  checkout_attempt uuid := current_setting('test.checkout_attempt_id')::uuid;
begin
  if (select count(*) from public.order_items where order_id = checkout_order) <> 2
     or (select count(*) from public.stock_reservations where order_id = checkout_order and status = 'held') <> 2 then
    raise exception 'Basket order lines and reservations were not created together';
  end if;
  if (select unit_price from public.order_items where order_id = checkout_order and product_id = 'bp-checkout-stock-2') <> 8.50 then
    raise exception 'Sale price was not stored in the immutable order snapshot';
  end if;
  if (select status from public.checkout_sessions where id = checkout_attempt) <> 'creating'
     or (select stripe_checkout_session_id from public.checkout_sessions where id = checkout_attempt) is not null then
    raise exception 'Checkout attempt was not durably stored before the Stripe request';
  end if;
end;
$test$;

set local role service_role;

do $test$
declare
  rejected boolean := false;
begin
  begin
    perform * from public.create_checkout_attempt(
      'checkout-foundation-test-key-rollback', null,
      'Rollback Customer', 'rollback@example.invalid',
      null, null,
      '[{"product_id":"bp-checkout-stock-a","quantity":1},{"product_id":"bp-checkout-stock-z","quantity":1}]'::jsonb,
      0, now() + interval '20 minutes'
    );
  exception
    when sqlstate '22023' then
      rejected := true;
  end;

  if not rejected then
    raise exception 'Insufficient stock was not rejected for the complete basket';
  end if;
  perform set_config('test.rollback_checked', 'true', true);
end;
$test$;

reset role;

update public.stock_reservations
set expires_at = now() - interval '1 second'
where order_id = current_setting('test.checkout_order_id')::uuid
  and product_id = 'bp-checkout-stock-2'
  and status = 'held';

set local role service_role;

do $test$
declare
  checkout_order uuid := current_setting('test.checkout_order_id')::uuid;
  available integer;
  denied boolean := false;
begin
  available := public.get_product_available_stock('bp-checkout-stock-2');
  if available <> 5 then
    raise exception 'Expired holds were still counted against available stock';
  end if;

  begin
    perform public.reserve_stock_for_order(
      checkout_order, 'bp-checkout-stock-2', 2, null, now() + interval '20 minutes'
    );
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'Service role could invoke the low-level reservation helper directly';
  end if;

  denied := false;
  begin
    perform public.confirm_stock_reservation(
      checkout_order, 'bp-checkout-stock-1'
    );
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'Service role could invoke legacy stock confirmation outside payment processing';
  end if;

  denied := false;
  begin
    perform public.release_unpaid_stock_reservation(
      checkout_order, 'bp-checkout-stock-1', 'expired'
    );
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then
    raise exception 'Service role could invoke legacy reservation release outside the atomic event operation';
  end if;
end;
$test$;

reset role;

do $test$
begin
  if exists (
    select 1 from public.checkout_sessions
    where attempt_key = 'checkout-foundation-test-key-rollback'
  ) or exists (
    select 1 from public.orders
    where customer_email = 'rollback@example.invalid'
  ) or exists (
    select 1 from public.stock_reservations
    where product_id = 'bp-checkout-stock-a' and status = 'held'
  ) then
    raise exception 'Failed multi-product checkout left a partial order or reservation';
  end if;
end;
$test$;

set local role service_role;

do $test$
declare
  result text;
begin
  perform public.attach_stripe_checkout_session(
    'checkout-foundation-test-key-0001',
    'cs_test_checkout_foundation_0001',
    now() + interval '20 minutes'
  );

  result := public.process_stripe_checkout_event(
    'evt_checkout_amount_mismatch_1', 'checkout.session.completed',
    'checkout-foundation-test-key-0001', 'cs_test_checkout_foundation_0001',
    'pi_test_checkout_foundation_0001', 3149, 'GBP', 'paid'
  );
  if result <> 'mismatch' then
    raise exception 'Checkout amount mismatch was not rejected';
  end if;

  result := public.process_stripe_checkout_event(
    'evt_checkout_currency_mismatch_1', 'checkout.session.completed',
    'checkout-foundation-test-key-0001', 'cs_test_checkout_foundation_0001',
    'pi_test_checkout_foundation_0001', 3150, 'USD', 'paid'
  );
  if result <> 'mismatch' then
    raise exception 'Checkout currency mismatch was not rejected';
  end if;

  result := public.process_stripe_checkout_event(
    'evt_checkout_session_mismatch_1', 'checkout.session.completed',
    'checkout-foundation-test-key-0001', 'cs_test_wrong_session',
    'pi_test_checkout_foundation_0001', 3150, 'GBP', 'paid'
  );
  if result <> 'mismatch' then
    raise exception 'Checkout session mismatch was not rejected';
  end if;

  result := public.process_stripe_checkout_event(
    'evt_checkout_paid_0001', 'checkout.session.completed',
    'checkout-foundation-test-key-0001', 'cs_test_checkout_foundation_0001',
    'pi_test_checkout_foundation_0001', 3150, 'GBP', 'paid'
  );
  if result <> 'paid' then
    raise exception 'Verified matching payment was not accepted';
  end if;

  result := public.process_stripe_checkout_event(
    'evt_checkout_paid_0001', 'checkout.session.completed',
    'checkout-foundation-test-key-0001', 'cs_test_checkout_foundation_0001',
    'pi_test_checkout_foundation_0001', 3150, 'GBP', 'paid'
  );
  if result <> 'duplicate' then
    raise exception 'Duplicate Stripe event was not idempotent';
  end if;

  result := public.process_stripe_checkout_event(
    'evt_checkout_late_expiry_1', 'checkout.session.expired',
    'checkout-foundation-test-key-0001', 'cs_test_checkout_foundation_0001',
    null, 3150, 'GBP', 'expired'
  );
  if result <> 'already_paid' then
    raise exception 'Late expiration event did not preserve paid order state';
  end if;
end;
$test$;

reset role;

do $test$
declare
  checkout_order uuid := current_setting('test.checkout_order_id')::uuid;
begin
  if (select payment_status from public.orders where id = checkout_order) <> 'paid'
     or (select payment_reference from public.orders where id = checkout_order) <> 'pi_test_checkout_foundation_0001'
     or (select stock_quantity from public.products where id = 'bp-checkout-stock-1') <> 0
     or (select stock_quantity from public.products where id = 'bp-checkout-stock-2') <> 3
     or (select count(*) from public.stock_reservations where order_id = checkout_order and status = 'confirmed') <> 2 then
    raise exception 'Payment confirmation did not atomically update order and inventory exactly once';
  end if;
  if (select status from public.checkout_sessions where order_id = checkout_order) <> 'paid' then
    raise exception 'Late expiry downgraded the paid Checkout Session';
  end if;
end;
$test$;

set local role service_role;

do $test$
declare
  first_attempt record;
  retry_attempt record;
  result text;
begin
  select * into first_attempt
  from public.create_checkout_attempt(
    'checkout-foundation-expiry-key-0001', null,
    'Expiry Customer', 'expiry@example.invalid',
    null, null, '[{"product_id":"bp-checkout-stock-2","quantity":1}]'::jsonb,
    0, now() + interval '20 minutes'
  );
  perform public.attach_stripe_checkout_session(
    'checkout-foundation-expiry-key-0001',
    'cs_test_checkout_expiry_0001',
    now() + interval '20 minutes'
  );
  result := public.process_stripe_checkout_event(
    'evt_checkout_expiry_0001', 'checkout.session.expired',
    'checkout-foundation-expiry-key-0001', 'cs_test_checkout_expiry_0001',
    null, 850, 'GBP', 'expired'
  );
  if result <> 'expired' then
    raise exception 'Expired session did not transition to expired';
  end if;

  result := public.process_stripe_checkout_event(
    'evt_checkout_late_payment_1', 'checkout.session.completed',
    'checkout-foundation-expiry-key-0001', 'cs_test_checkout_expiry_0001',
    'pi_test_late_payment', 850, 'GBP', 'paid'
  );
  if result <> 'reconciliation_required' then
    raise exception 'Late payment without a held reservation was not escalated';
  end if;

  select * into retry_attempt
  from public.create_checkout_attempt(
    'checkout-foundation-expiry-retry-0001', first_attempt.order_id,
    'Expiry Customer', 'expiry@example.invalid',
    null, null, '[{"product_id":"bp-checkout-stock-2","quantity":1}]'::jsonb,
    0, now() + interval '20 minutes'
  );
  if retry_attempt.order_id <> first_attempt.order_id or retry_attempt.reused then
    raise exception 'Sequential retry did not reuse the unpaid order';
  end if;
  perform set_config('test.expiry_order_id', first_attempt.order_id::text, true);
end;
$test$;

reset role;

do $test$
declare
  expiry_order uuid := current_setting('test.expiry_order_id')::uuid;
begin
  if (select payment_status from public.orders where id = expiry_order) <> 'pending'
     or (select count(*) from public.checkout_sessions where order_id = expiry_order) <> 2
     or (select count(*) from public.stock_reservations where order_id = expiry_order and status = 'held') <> 1 then
    raise exception 'Expired reservation was not released or a subsequent attempt did not reserve safely';
  end if;

  if (select event_status from public.payment_events where event_id = 'evt_checkout_amount_mismatch_1') <> 'failed'
     or (select event_status from public.payment_events where event_id = 'evt_checkout_paid_0001') <> 'succeeded'
     or (select event_status from public.payment_events where event_id = 'evt_checkout_late_payment_1') <> 'failed' then
    raise exception 'Webhook event records did not retain mismatch, success, and reconciliation outcomes';
  end if;
end;
$test$;

set local role anon;

do $test$
declare
  denied boolean := false;
begin
  begin
    perform public.process_stripe_checkout_event(
      'evt_unauthorized_anon_0001', 'checkout.session.completed',
      'checkout-foundation-test-key-0001', 'cs_test_checkout_foundation_0001',
      'pi_forged', 3150, 'GBP', 'paid'
    );
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then
    raise exception 'Anonymous role invoked privileged payment processing';
  end if;
end;
$test$;

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000931', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $test$
declare
  denied boolean := false;
  stock_reduction_denied boolean := false;
begin
  begin
    perform public.create_checkout_attempt(
      'checkout-authenticated-forbidden-key', null,
      'Customer', 'customer@example.invalid', null, null,
      '[{"product_id":"bp-checkout-stock-2","quantity":1}]'::jsonb,
      0, now() + interval '20 minutes'
    );
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then
    raise exception 'Authenticated role invoked privileged checkout creation';
  end if;

  denied := false;
  begin
    update public.orders
    set payment_status = 'paid'
    where id = current_setting('test.checkout_order_id')::uuid;
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then
    raise exception 'Authenticated role changed trusted order payment state';
  end if;

  begin
    perform public.set_product_stock_quantity('bp-checkout-stock-2', 0);
  exception when invalid_parameter_value then stock_reduction_denied := true;
  end;
  if not stock_reduction_denied then
    raise exception 'Admin inventory update reduced on-hand stock below a held reservation';
  end if;
end;
$test$;

reset role;
rollback;
