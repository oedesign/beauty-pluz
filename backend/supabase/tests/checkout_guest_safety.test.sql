begin;

insert into public.products
  (id, name, category, price, stock_quantity, is_available, is_published)
values
  ('bp-guest-safety-fixture', 'Guest checkout safety fixture', 'testing', 12.00, 8, true, true)
on conflict (id) do update
set price = excluded.price,
    stock_quantity = excluded.stock_quantity,
    is_available = excluded.is_available,
    is_published = excluded.is_published;

set local role service_role;

do $test$
declare
  initial record;
  interrupted record;
  interrupted_recovered record;
  recovered record;
  recovered_again record;
  recovered_later record;
  status_record record;
  rate_record record;
  late_payment_result text;
  late_failure_result text;
  paid_result text;
  recovery_attempt_key text;
  stock_before_late_event integer;
  paid_recovery_denied boolean := false;
begin
  select * into initial
  from public.create_checkout_attempt(
    'guest-safety-initial-key-00001', null,
    'Guest Safety Customer', 'guest-safety@example.invalid',
    '+441234567890', '1 Test Street',
    '[{"product_id":"bp-guest-safety-fixture","quantity":1}]'::jsonb,
    400, now() + interval '20 minutes'
  );
  perform public.register_guest_checkout_capabilities(
    initial.order_id,
    initial.attempt_id,
    repeat('1', 64), repeat('2', 64), repeat('3', 64),
    now() + interval '7 days'
  );

  select * into status_record
  from public.get_guest_checkout_status(repeat('2', 64));
  if status_record.order_reference <> right(replace(initial.order_id::text, '-', ''), 8)
     or status_record.payment_status <> 'pending' then
    raise exception 'Guest status did not return only the approved minimal fields';
  end if;
  if (select count(*) from public.exchange_guest_checkout_handoff(repeat('1', 64))) <> 1 then
    raise exception 'Valid guest handoff was not exchanged';
  end if;
  if (select count(*) from public.exchange_guest_checkout_handoff(repeat('1', 64))) <> 0 then
    raise exception 'Guest handoff was reusable after exchange';
  end if;
  perform public.register_guest_checkout_capabilities(
    initial.order_id,
    initial.attempt_id,
    repeat('1', 64), repeat('2', 64), repeat('3', 64),
    now() + interval '7 days'
  );
  if (select count(*) from public.exchange_guest_checkout_handoff(repeat('1', 64))) <> 0 then
    raise exception 'Retrying the same attempt reactivated its consumed handoff';
  end if;

  select * into rate_record
  from public.consume_guest_checkout_rate_limit(repeat('4', 64), 2, 60);
  if not rate_record.allowed then raise exception 'First rate-limit request was rejected'; end if;
  perform public.consume_guest_checkout_rate_limit(repeat('4', 64), 2, 60);
  select * into rate_record
  from public.consume_guest_checkout_rate_limit(repeat('4', 64), 2, 60);
  if rate_record.allowed or rate_record.retry_after_seconds < 1 then
    raise exception 'Rate-limit exhaustion did not return a retry interval';
  end if;

  perform public.attach_stripe_checkout_session(
    'guest-safety-initial-key-00001',
    'cs_test_guest_safety_expired_01',
    now() + interval '20 minutes'
  );
  update public.checkout_sessions
  set expires_at = now() - interval '1 second'
  where attempt_key = 'guest-safety-initial-key-00001';
  update public.stock_reservations
  set expires_at = now() - interval '1 second'
  where order_id = initial.order_id and status = 'held';

  select * into recovered
  from public.recover_guest_checkout_attempt(
    repeat('3', 64),
    now() + interval '20 minutes'
  );
  select * into recovered_again
  from public.recover_guest_checkout_attempt(
    repeat('3', 64),
    now() + interval '20 minutes'
  );
  if recovered.order_id <> initial.order_id
     or recovered.attempt_id <> recovered_again.attempt_id
     or not recovered_again.reused then
    raise exception 'Recovery retry did not reuse the same order and attempt';
  end if;
  update public.checkout_sessions
  set status = 'expired', expires_at = now() - interval '1 second'
  where id = recovered.attempt_id;
  update public.stock_reservations
  set status = 'expired', released_at = now(),
      release_reason = 'expired', expires_at = now() - interval '1 second'
  where order_id = initial.order_id and status = 'held';
  select * into recovered_later
  from public.recover_guest_checkout_attempt(
    repeat('3', 64), now() + interval '20 minutes'
  );
  if recovered_later.attempt_id = recovered.attempt_id then
    raise exception 'A later explicit recovery did not allocate a fresh attempt';
  end if;
  select attempt_key into recovery_attempt_key
  from public.checkout_sessions where id = recovered_later.attempt_id;

  perform public.attach_stripe_checkout_session(
    recovery_attempt_key,
    'cs_test_guest_safety_replacement_01',
    now() + interval '20 minutes'
  );
  select stock_quantity into stock_before_late_event
  from public.products where id = 'bp-guest-safety-fixture';
  late_failure_result := public.process_stripe_checkout_event(
    'evt_guest_safety_late_failure_01', 'checkout.session.async_payment_failed',
    'guest-safety-initial-key-00001', 'cs_test_guest_safety_expired_01',
    'pi_guest_safety_late_failure_01', recovered_later.amount_total, 'GBP', 'failed'
  );
  if late_failure_result <> 'failed'
     or (select payment_status from public.orders where id = initial.order_id) <> 'pending'
     or not exists (
       select 1 from public.stock_reservations
       where order_id = initial.order_id
         and checkout_session_id = 'cs_test_guest_safety_replacement_01'
         and status = 'held'
     ) then
    raise exception 'A late failure event changed the replacement attempt or its reservation';
  end if;

  late_payment_result := public.process_stripe_checkout_event(
    'evt_guest_safety_late_payment_01', 'checkout.session.completed',
    'guest-safety-initial-key-00001', 'cs_test_guest_safety_expired_01',
    'pi_guest_safety_late_01', recovered_later.amount_total, 'GBP', 'paid'
  );
  if late_payment_result <> 'reconciliation_required'
     or (select payment_status from public.orders where id = initial.order_id) <> 'pending'
     or (select stock_quantity from public.products
         where id = 'bp-guest-safety-fixture') <> stock_before_late_event
     or not exists (
       select 1 from public.stock_reservations
       where order_id = initial.order_id
         and checkout_session_id = 'cs_test_guest_safety_replacement_01'
         and status = 'held'
     ) then
    raise exception 'A late payment changed the replacement order or its inventory';
  end if;
  paid_result := public.process_stripe_checkout_event(
    'evt_guest_safety_paid_01', 'checkout.session.completed',
    recovery_attempt_key, 'cs_test_guest_safety_replacement_01',
    'pi_guest_safety_paid_01', recovered_later.amount_total, 'GBP', 'paid'
  );
  if paid_result <> 'paid' then
    raise exception 'Verified recovery payment was not accepted';
  end if;
  begin
    perform * from public.recover_guest_checkout_attempt(
      repeat('3', 64),
      now() + interval '20 minutes'
    );
  exception when insufficient_privilege then
    paid_recovery_denied := true;
  end;
  if not paid_recovery_denied then
    raise exception 'A paid order was allowed to enter checkout recovery';
  end if;

  select * into interrupted
  from public.create_checkout_attempt(
    'guest-safety-interrupted-key-0001', null,
    'Interrupted Customer', 'interrupted@example.invalid',
    null, '2 Test Street',
    '[{"product_id":"bp-guest-safety-fixture","quantity":1}]'::jsonb,
    400, now() + interval '20 minutes'
  );
  perform public.register_guest_checkout_capabilities(
    interrupted.order_id,
    interrupted.attempt_id,
    repeat('5', 64), repeat('6', 64), repeat('7', 64),
    now() + interval '7 days'
  );
  update public.checkout_sessions
  set expires_at = now() - interval '1 second'
  where id = interrupted.attempt_id;
  select * into interrupted_recovered
  from public.recover_guest_checkout_attempt(
    repeat('7', 64), now() + interval '20 minutes'
  );
  if interrupted_recovered.order_id <> interrupted.order_id
     or interrupted_recovered.attempt_id = interrupted.attempt_id then
    raise exception 'An expired interrupted attempt could not be safely replaced';
  end if;

  update public.guest_checkout_capabilities
  set expires_at = now() - interval '1 second'
  where order_id = initial.order_id;
  if (select count(*) from public.get_guest_checkout_status(repeat('2', 64))) <> 0
     or (select count(*) from public.exchange_guest_checkout_handoff(repeat('1', 64))) <> 0 then
    raise exception 'Expired guest capabilities remained usable';
  end if;

  update public.guest_checkout_capabilities
  set expires_at = now() + interval '1 day'
  where order_id = initial.order_id;
  if not public.revoke_guest_checkout_capabilities(initial.order_id) then
    raise exception 'Trusted capability revocation did not update the order';
  end if;
  if (select count(*) from public.get_guest_checkout_status(repeat('2', 64))) <> 0
     or (select count(*) from public.exchange_guest_checkout_handoff(repeat('1', 64))) <> 0 then
    raise exception 'Revoked guest capabilities remained usable';
  end if;
  begin
    perform public.register_guest_checkout_capabilities(
      initial.order_id, initial.attempt_id,
      repeat('1', 64), repeat('2', 64), repeat('3', 64),
      now() + interval '7 days'
    );
    raise exception 'Checkout capability registration reactivated revoked credentials';
  exception when insufficient_privilege then
    null;
  end;

  perform set_config('test.guest_safety_order_id', initial.order_id::text, true);
end;
$test$;

reset role;
set local role anon;

do $test$
declare
  registration_denied boolean := false;
  handoff_denied boolean := false;
  status_denied boolean := false;
  recovery_denied boolean := false;
  revocation_denied boolean := false;
  rate_limit_denied boolean := false;
  table_denied boolean := false;
begin
  begin
    perform public.register_guest_checkout_capabilities(
      current_setting('test.guest_safety_order_id')::uuid,
      gen_random_uuid(), repeat('1', 64), repeat('2', 64), repeat('3', 64),
      now() + interval '7 days'
    );
  exception when insufficient_privilege then registration_denied := true;
  end;
  begin
    perform * from public.exchange_guest_checkout_handoff(repeat('1', 64));
  exception when insufficient_privilege then handoff_denied := true;
  end;
  begin
    perform * from public.get_guest_checkout_status(repeat('2', 64));
  exception when insufficient_privilege then status_denied := true;
  end;
  begin
    perform * from public.consume_guest_checkout_rate_limit(repeat('4', 64), 2, 60);
  exception when insufficient_privilege then rate_limit_denied := true;
  end;
  begin
    perform * from public.recover_guest_checkout_attempt(
      repeat('3', 64), now() + interval '20 minutes'
    );
  exception when insufficient_privilege then recovery_denied := true;
  end;
  begin
    perform public.revoke_guest_checkout_capabilities(
      current_setting('test.guest_safety_order_id')::uuid
    );
  exception when insufficient_privilege then revocation_denied := true;
  end;
  begin
    perform count(*) from public.guest_checkout_capabilities;
  exception when insufficient_privilege then table_denied := true;
  end;
  if not registration_denied or not handoff_denied or not status_denied
     or not rate_limit_denied or not recovery_denied or not revocation_denied
     or not table_denied then
    raise exception 'Anonymous RPC or capability-table access was not denied';
  end if;
end;
$test$;

reset role;
rollback;
