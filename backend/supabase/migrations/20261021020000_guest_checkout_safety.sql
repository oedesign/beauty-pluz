begin;

create table if not exists public.guest_checkout_capabilities (
  order_id uuid primary key references public.orders (id) on delete cascade,
  handoff_hash text not null check (handoff_hash ~ '^[0-9a-f]{64}$'),
  status_hash text not null check (status_hash ~ '^[0-9a-f]{64}$'),
  recovery_hash text not null check (recovery_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.guest_checkout_capabilities enable row level security;
revoke all on public.guest_checkout_capabilities from public, anon, authenticated;
create unique index if not exists guest_checkout_capabilities_handoff_hash_idx
  on public.guest_checkout_capabilities (handoff_hash);
create unique index if not exists guest_checkout_capabilities_status_hash_idx
  on public.guest_checkout_capabilities (status_hash);
create unique index if not exists guest_checkout_capabilities_recovery_hash_idx
  on public.guest_checkout_capabilities (recovery_hash);

create table if not exists public.guest_checkout_rate_limits (
  bucket_hash text primary key check (bucket_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default now()
);

alter table public.guest_checkout_rate_limits enable row level security;
revoke all on public.guest_checkout_rate_limits from public, anon, authenticated;
create index if not exists guest_checkout_rate_limits_updated_idx
  on public.guest_checkout_rate_limits (updated_at);

create or replace function public.register_guest_checkout_capabilities(
  p_order_id uuid,
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
  insert into public.guest_checkout_capabilities
    (order_id, handoff_hash, status_hash, recovery_hash, expires_at, revoked_at, updated_at)
  values
    (p_order_id, p_handoff_hash, p_status_hash, p_recovery_hash, p_expires_at, null, now())
  on conflict (order_id) do update
  set handoff_hash = excluded.handoff_hash,
      status_hash = excluded.status_hash,
      recovery_hash = excluded.recovery_hash,
      expires_at = excluded.expires_at,
      updated_at = now()
  where public.guest_checkout_capabilities.revoked_at is null;
  if not found then
    raise exception using errcode = '42501', message = 'Guest capabilities are revoked';
  end if;
end;
$function$;

create or replace function public.exchange_guest_checkout_handoff(p_handoff_hash text)
returns table (order_id uuid)
language sql
security definer
set search_path = ''
as $function$
  select capability.order_id
  from public.guest_checkout_capabilities as capability
  where p_handoff_hash ~ '^[0-9a-f]{64}$'
    and capability.handoff_hash = p_handoff_hash
    and capability.expires_at > now()
    and capability.revoked_at is null
$function$;

create or replace function public.get_guest_checkout_status(p_status_hash text)
returns table (
  order_reference text,
  payment_status text
)
language sql
security definer
set search_path = ''
as $function$
  select right(replace(order_record.id::text, '-', ''), 8),
         order_record.payment_status
  from public.guest_checkout_capabilities as capability
  join public.orders as order_record on order_record.id = capability.order_id
  where p_status_hash ~ '^[0-9a-f]{64}$'
    and capability.status_hash = p_status_hash
    and capability.expires_at > now()
    and capability.revoked_at is null
$function$;

create or replace function public.consume_guest_checkout_rate_limit(
  p_bucket_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  bucket public.guest_checkout_rate_limits%rowtype;
  window_interval interval;
begin
  if p_bucket_hash !~ '^[0-9a-f]{64}$'
     or p_limit < 1 or p_limit > 1000
     or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception using errcode = '22023', message = 'Invalid rate-limit request';
  end if;

  window_interval := make_interval(secs => p_window_seconds);
  delete from public.guest_checkout_rate_limits
  where updated_at < now() - interval '2 days';

  insert into public.guest_checkout_rate_limits
    (bucket_hash, window_started_at, request_count, updated_at)
  values (p_bucket_hash, now(), 1, now())
  on conflict (bucket_hash) do update
    set window_started_at = case
          when public.guest_checkout_rate_limits.window_started_at <= now() - window_interval
            then now()
          else public.guest_checkout_rate_limits.window_started_at
        end,
        request_count = case
          when public.guest_checkout_rate_limits.window_started_at <= now() - window_interval
            then 1
          else public.guest_checkout_rate_limits.request_count + 1
        end,
        updated_at = now()
  returning * into bucket;

  if bucket.request_count <= p_limit then
    return query select true, 0;
  else
    return query select false,
      greatest(1, ceil(extract(epoch from
        (bucket.window_started_at + window_interval - now())))::integer);
  end if;
end;
$function$;

create or replace function public.recover_guest_checkout_attempt(
  p_recovery_hash text,
  p_attempt_key text,
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
  saved_items jsonb;
  delivery_fee_pence bigint;
  original_payment_status text;
  original_failure_reason text;
begin
  if p_recovery_hash !~ '^[0-9a-f]{64}$'
     or p_attempt_key is null
     or length(p_attempt_key) < 16
     or length(p_attempt_key) > 200
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

  select * into existing_attempt
  from public.checkout_sessions
  where attempt_key = p_attempt_key
  for update;
  if found then
    if existing_attempt.order_id <> order_record.id then
      raise exception using errcode = '22023', message = 'Checkout key does not match order';
    end if;
    select * into result_record
    from public.create_checkout_attempt(
      p_attempt_key, order_record.id, order_record.customer_name, order_record.customer_email,
      order_record.customer_phone, order_record.shipping_address, saved_items,
      delivery_fee_pence, p_hold_expires_at
    );
    return query select result_record.order_id, result_record.attempt_id,
      result_record.amount_total, result_record.currency, result_record.reused;
    return;
  end if;

  if latest_attempt.status in ('creating', 'created', 'pending', 'requires_action') then
    if latest_attempt.status = 'creating'
       or latest_attempt.stripe_checkout_session_id is null
       or latest_attempt.expires_at is null
       or latest_attempt.expires_at > now() then
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

  select * into result_record
  from public.create_checkout_attempt(
    p_attempt_key, order_record.id, order_record.customer_name, order_record.customer_email,
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

revoke all on function public.register_guest_checkout_capabilities(uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.exchange_guest_checkout_handoff(text) from public, anon, authenticated;
revoke all on function public.get_guest_checkout_status(text) from public, anon, authenticated;
revoke all on function public.consume_guest_checkout_rate_limit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.recover_guest_checkout_attempt(text, text, timestamptz) from public, anon, authenticated;

grant execute on function public.register_guest_checkout_capabilities(uuid, text, text, text, timestamptz) to service_role;
grant execute on function public.exchange_guest_checkout_handoff(text) to service_role;
grant execute on function public.get_guest_checkout_status(text) to service_role;
grant execute on function public.consume_guest_checkout_rate_limit(text, integer, integer) to service_role;
grant execute on function public.recover_guest_checkout_attempt(text, text, timestamptz) to service_role;

commit;
