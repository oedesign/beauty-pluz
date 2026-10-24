begin;

alter table public.guest_checkout_capabilities
  add column if not exists checkout_attempt_id uuid
    references public.checkout_sessions (id) on delete cascade,
  add column if not exists handoff_consumed_at timestamptz,
  add column if not exists recovery_attempt_key text;

update public.guest_checkout_capabilities as capability
set checkout_attempt_id = (
  select attempt.id
  from public.checkout_sessions as attempt
  where attempt.order_id = capability.order_id
  order by attempt.created_at desc, attempt.id desc
  limit 1
)
where capability.checkout_attempt_id is null;

drop function if exists public.register_guest_checkout_capabilities(uuid, text, text, text, timestamptz);
drop function if exists public.register_guest_checkout_capabilities(uuid, uuid, text, text, text, timestamptz);

create function public.register_guest_checkout_capabilities(
  p_order_id uuid,
  p_checkout_attempt_id uuid,
  p_handoff_hash text,
  p_status_hash text,
  p_recovery_hash text,
  p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_order_id is null
     or p_checkout_attempt_id is null
     or p_handoff_hash !~ '^[0-9a-f]{64}$'
     or p_status_hash !~ '^[0-9a-f]{64}$'
     or p_recovery_hash !~ '^[0-9a-f]{64}$'
     or p_expires_at <= now()
     or p_expires_at > now() + interval '31 days' then
    raise exception using errcode = '22023', message = 'Invalid guest capability registration';
  end if;

  perform 1 from public.orders where id = p_order_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Order not found';
  end if;
  if not exists (
    select 1 from public.checkout_sessions
    where id = p_checkout_attempt_id and order_id = p_order_id
  ) then
    raise exception using errcode = '22023', message = 'Checkout attempt does not match order';
  end if;

  insert into public.guest_checkout_capabilities
    (order_id, checkout_attempt_id, handoff_hash, status_hash, recovery_hash,
     expires_at, handoff_consumed_at, revoked_at, updated_at)
  values
    (p_order_id, p_checkout_attempt_id, p_handoff_hash, p_status_hash,
     p_recovery_hash, p_expires_at, null, null, now())
  on conflict (order_id) do update
  set checkout_attempt_id = excluded.checkout_attempt_id,
      handoff_hash = excluded.handoff_hash,
      status_hash = excluded.status_hash,
      recovery_hash = excluded.recovery_hash,
      expires_at = excluded.expires_at,
      handoff_consumed_at = case
        when public.guest_checkout_capabilities.checkout_attempt_id = excluded.checkout_attempt_id
          then public.guest_checkout_capabilities.handoff_consumed_at
        else null
      end,
      updated_at = now()
  where public.guest_checkout_capabilities.revoked_at is null;
  if not found then
    raise exception using errcode = '42501', message = 'Guest capabilities are revoked';
  end if;
end;
$function$;

drop function if exists public.exchange_guest_checkout_handoff(text);

create function public.exchange_guest_checkout_handoff(p_handoff_hash text)
returns table (order_id uuid, order_reference text, payment_status text)
language sql
security definer
set search_path = ''
as $function$
  with consumed as (
    update public.guest_checkout_capabilities as capability
    set handoff_consumed_at = now(),
        updated_at = now()
    where p_handoff_hash ~ '^[0-9a-f]{64}$'
      and capability.handoff_hash = p_handoff_hash
      and capability.expires_at > now()
      and capability.revoked_at is null
      and capability.handoff_consumed_at is null
    returning capability.order_id
  )
  select consumed.order_id,
         right(replace(order_record.id::text, '-', ''), 8),
         order_record.payment_status
  from consumed
  join public.orders as order_record on order_record.id = consumed.order_id
$function$;

create or replace function public.revoke_guest_checkout_capabilities(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update public.guest_checkout_capabilities
  set revoked_at = coalesce(revoked_at, now()), updated_at = now()
  where order_id = p_order_id
    and revoked_at is null;
  return found;
end;
$function$;

alter table public.guest_checkout_capabilities
  drop constraint if exists guest_checkout_capabilities_recovery_attempt_key_check,
  add constraint guest_checkout_capabilities_recovery_attempt_key_check
    check (
      recovery_attempt_key is null
      or (length(recovery_attempt_key) >= 16 and length(recovery_attempt_key) <= 200)
    );

drop function if exists public.recover_guest_checkout_attempt(text, text, timestamptz);
drop function if exists public.recover_guest_checkout_attempt(text, timestamptz);

create function public.recover_guest_checkout_attempt(
  p_recovery_hash text,
  p_hold_expires_at timestamptz
)
returns table (
  order_id uuid,
  attempt_id uuid,
  amount_total bigint,
  currency text,
  reused boolean
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  order_record public.orders%rowtype;
  capability public.guest_checkout_capabilities%rowtype;
  latest_attempt public.checkout_sessions%rowtype;
  existing_attempt public.checkout_sessions%rowtype;
  result_record record;
  recovery_key text;
  saved_items jsonb;
  delivery_fee_pence bigint;
  original_payment_status text;
  original_failure_reason text;
begin
  if p_recovery_hash !~ '^[0-9a-f]{64}$'
     or p_hold_expires_at is null
     or p_hold_expires_at <= now()
     or p_hold_expires_at > now() + interval '1 hour' then
    raise exception using errcode = '22023', message = 'Invalid checkout recovery request';
  end if;

  select * into capability
  from public.guest_checkout_capabilities
  where recovery_hash = p_recovery_hash
    and expires_at > now()
    and revoked_at is null
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Checkout recovery is unavailable';
  end if;

  select * into order_record
  from public.orders
  where id = capability.order_id
  for update;
  if not found
     or order_record.payment_status = 'paid'
     or order_record.fulfillment_status = 'cancelled' then
    raise exception using errcode = '42501', message = 'Checkout recovery is unavailable';
  end if;

  select * into latest_attempt
  from public.checkout_sessions
  where checkout_sessions.order_id = order_record.id
  order by checkout_sessions.created_at desc, checkout_sessions.id desc
  limit 1
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Checkout recovery is unavailable';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'product_id', item.product_id,
    'quantity', item.quantity
  ) order by item.product_id), '[]'::jsonb)
  into saved_items
  from public.order_items as item
  where item.order_id = order_record.id;
  if jsonb_array_length(saved_items) < 1 then
    raise exception using errcode = '42501', message = 'Checkout recovery is unavailable';
  end if;

  delivery_fee_pence := round(order_record.delivery_fee * 100)::bigint;
  original_payment_status := order_record.payment_status;
  original_failure_reason := order_record.payment_failure_reason;

  recovery_key := capability.recovery_attempt_key;
  if recovery_key is not null then
    select * into existing_attempt
    from public.checkout_sessions
    where attempt_key = recovery_key
    for update;
    if found then
      if existing_attempt.order_id <> order_record.id then
        raise exception using errcode = '55000', message = 'Checkout recovery is unavailable';
      end if;
      if existing_attempt.status in ('creating', 'created', 'pending', 'requires_action')
         and existing_attempt.expires_at > now() then
        select * into result_record
        from public.create_checkout_attempt(
          recovery_key, order_record.id, order_record.customer_name, order_record.customer_email,
          order_record.customer_phone, order_record.shipping_address, saved_items,
          delivery_fee_pence, p_hold_expires_at
        );
        return query select result_record.order_id, result_record.attempt_id,
          result_record.amount_total, result_record.currency, result_record.reused;
        return;
      end if;
    end if;
    update public.guest_checkout_capabilities as guest_capability
    set recovery_attempt_key = null, updated_at = now()
    where guest_capability.order_id = order_record.id;
    recovery_key := null;
  end if;

  if latest_attempt.status in ('creating', 'created', 'pending', 'requires_action') then
    if latest_attempt.expires_at is null or latest_attempt.expires_at > now() then
      raise exception using errcode = '55000', message = 'Checkout attempt is still active';
    end if;
    update public.checkout_sessions
    set status = 'expired', updated_at = now()
    where id = latest_attempt.id
      and status in ('creating', 'created', 'pending', 'requires_action');
    update public.stock_reservations
    set status = 'expired', released_at = now(),
        release_reason = 'expired', updated_at = now()
    where stock_reservations.order_id = order_record.id
      and stock_reservations.status = 'held';
  elsif latest_attempt.status not in ('expired', 'cancelled', 'failed') then
    raise exception using errcode = '55000', message = 'Checkout attempt cannot be recovered';
  end if;

  recovery_key := 'guest-recovery-' || replace(gen_random_uuid()::text, '-', '');
  update public.guest_checkout_capabilities as guest_capability
  set recovery_attempt_key = recovery_key, updated_at = now()
  where guest_capability.order_id = order_record.id;

  select * into result_record
  from public.create_checkout_attempt(
    recovery_key, order_record.id, order_record.customer_name, order_record.customer_email,
    order_record.customer_phone, order_record.shipping_address, saved_items,
    delivery_fee_pence, p_hold_expires_at
  );

  if original_payment_status = 'failed' then
    update public.orders
    set payment_status = original_payment_status,
        payment_failure_reason = original_failure_reason
    where id = order_record.id;
  end if;

  return query select result_record.order_id, result_record.attempt_id,
    result_record.amount_total, result_record.currency, result_record.reused;
end;
$function$;

revoke all on function public.register_guest_checkout_capabilities(uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.exchange_guest_checkout_handoff(text) from public, anon, authenticated;
revoke all on function public.revoke_guest_checkout_capabilities(uuid) from public, anon, authenticated;
revoke all on function public.recover_guest_checkout_attempt(text, timestamptz) from public, anon, authenticated;
grant execute on function public.register_guest_checkout_capabilities(uuid, uuid, text, text, text, timestamptz) to service_role;
grant execute on function public.exchange_guest_checkout_handoff(text) to service_role;
grant execute on function public.revoke_guest_checkout_capabilities(uuid) to service_role;
grant execute on function public.recover_guest_checkout_attempt(text, timestamptz) to service_role;

commit;
