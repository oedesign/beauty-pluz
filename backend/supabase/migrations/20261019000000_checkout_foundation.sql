alter table public.orders
  add column if not exists checkout_session_id text,
  add column if not exists payment_intent_id text,
  add column if not exists currency text not null default 'GBP',
  add column if not exists checkout_expires_at timestamptz,
  add column if not exists paid_at timestamptz,
  add column if not exists payment_failure_reason text,
  add column if not exists updated_at timestamptz not null default now();

alter table public.orders
  drop constraint if exists orders_currency_check,
  add constraint orders_currency_check check (currency = 'GBP');

create or replace function public.set_order_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

revoke all on function public.set_order_updated_at() from public, anon, authenticated;

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at
before update on public.orders
for each row execute function public.set_order_updated_at();

create table if not exists public.checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  stripe_checkout_session_id text not null unique,
  stripe_payment_intent_id text,
  status text not null check (status in ('created', 'pending', 'paid', 'expired', 'cancelled', 'failed', 'requires_action')),
  amount_total bigint not null check (amount_total >= 0),
  currency text not null default 'GBP' check (currency = 'GBP'),
  customer_email text,
  customer_name text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb,
  last_event_id text
);

create index if not exists checkout_sessions_order_idx
  on public.checkout_sessions (order_id, created_at desc);
create index if not exists checkout_sessions_status_idx
  on public.checkout_sessions (status, created_at desc);

alter table public.checkout_sessions enable row level security;
revoke all on public.checkout_sessions from public, anon, authenticated;

create or replace function public.set_checkout_session_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

revoke all on function public.set_checkout_session_updated_at() from public, anon, authenticated;

drop trigger if exists checkout_sessions_set_updated_at on public.checkout_sessions;
create trigger checkout_sessions_set_updated_at
before update on public.checkout_sessions
for each row execute function public.set_checkout_session_updated_at();

create table if not exists public.payment_events (
  id bigint generated always as identity primary key,
  event_id text not null unique,
  provider text not null default 'stripe' check (provider = 'stripe'),
  event_type text not null,
  order_id uuid references public.orders (id) on delete set null,
  checkout_session_id text,
  event_status text not null default 'queued' check (event_status in ('queued', 'processing', 'succeeded', 'failed')),
  error_message text,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists payment_events_checkout_session_idx
  on public.payment_events (checkout_session_id, created_at desc);
create index if not exists payment_events_order_idx
  on public.payment_events (order_id, created_at desc);

alter table public.payment_events enable row level security;
revoke all on public.payment_events from public, anon, authenticated;

create table if not exists public.stock_reservations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  product_id text not null references public.products (id) on delete restrict,
  quantity integer not null check (quantity > 0),
  checkout_session_id text,
  status text not null check (status in ('held', 'confirmed', 'released', 'expired', 'cancelled')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  released_at timestamptz,
  release_reason text
);

create unique index if not exists stock_reservations_order_product_active_idx
  on public.stock_reservations (order_id, product_id)
  where status in ('held', 'confirmed');

create index if not exists stock_reservations_product_status_idx
  on public.stock_reservations (product_id, status, expires_at);
create index if not exists stock_reservations_order_status_idx
  on public.stock_reservations (order_id, status, expires_at);

alter table public.stock_reservations enable row level security;
revoke all on public.stock_reservations from public, anon, authenticated;

create or replace function public.set_stock_reservation_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

revoke all on function public.set_stock_reservation_updated_at() from public, anon, authenticated;

drop trigger if exists stock_reservations_set_updated_at on public.stock_reservations;
create trigger stock_reservations_set_updated_at
before update on public.stock_reservations
for each row execute function public.set_stock_reservation_updated_at();

create or replace function public.get_product_available_stock(p_product_id text)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  on_hand integer;
  reserved_quantity integer;
begin
  if p_product_id is null or length(trim(p_product_id)) = 0 then
    raise exception using errcode = '22023', message = 'Product id is required';
  end if;

  select stock_quantity
    into on_hand
  from public.products
  where id = p_product_id;

  if on_hand is null then
    return null;
  end if;

  select coalesce(sum(quantity), 0)
    into reserved_quantity
  from public.stock_reservations
  where product_id = p_product_id
    and status = 'held';

  return on_hand - reserved_quantity;
end;
$function$;

revoke all on function public.get_product_available_stock(text) from public, anon, authenticated;

create or replace function public.reserve_stock_for_order(
  p_order_id uuid,
  p_product_id text,
  p_quantity integer,
  p_checkout_session_id text,
  p_expires_at timestamptz
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  product_stock integer;
  reserved_total integer;
  active_reservation record;
  reserved_quantity integer;
  resolved_expiry timestamptz;
begin
  if p_order_id is null then
    raise exception using errcode = '22023', message = 'Order id is required';
  end if;

  if p_product_id is null or length(trim(p_product_id)) = 0 then
    raise exception using errcode = '22023', message = 'Product id is required';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception using errcode = '22023', message = 'Reservation quantity must be greater than zero';
  end if;

  if not exists (select 1 from public.orders where id = p_order_id) then
    raise exception using errcode = 'P0002', message = 'Order not found';
  end if;

  select stock_quantity
    into product_stock
  from public.products
  where id = p_product_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Product not found';
  end if;

  if product_stock is not null then
    select coalesce(sum(quantity), 0)
      into reserved_total
    from public.stock_reservations
    where product_id = p_product_id
      and status = 'held'
    for update;

    if product_stock - reserved_total < p_quantity then
      raise exception using errcode = '22023', message = 'Insufficient stock available';
    end if;
  end if;

  select *
    into active_reservation
  from public.stock_reservations
  where order_id = p_order_id
    and product_id = p_product_id
    and status = 'held'
  for update;

  resolved_expiry := coalesce(p_expires_at, now() + interval '15 minutes');

  if active_reservation.id is not null then
    update public.stock_reservations
    set quantity = p_quantity,
        checkout_session_id = p_checkout_session_id,
        expires_at = resolved_expiry,
        updated_at = now()
    where id = active_reservation.id
    returning quantity into reserved_quantity;

    return reserved_quantity;
  end if;

  insert into public.stock_reservations
    (order_id, product_id, quantity, checkout_session_id, status, expires_at)
  values
    (p_order_id, p_product_id, p_quantity, p_checkout_session_id, 'held', resolved_expiry)
  returning quantity into reserved_quantity;

  return reserved_quantity;
end;
$function$;

revoke all on function public.reserve_stock_for_order(uuid, text, integer, text, timestamptz) from public, anon, authenticated;

create or replace function public.confirm_stock_reservation(p_order_id uuid, p_product_id text)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  reservation_record record;
  product_stock integer;
  reserved_quantity integer;
begin
  if p_order_id is null then
    raise exception using errcode = '22023', message = 'Order id is required';
  end if;

  if p_product_id is null or length(trim(p_product_id)) = 0 then
    raise exception using errcode = '22023', message = 'Product id is required';
  end if;

  select *
    into reservation_record
  from public.stock_reservations
  where order_id = p_order_id
    and product_id = p_product_id
    and status = 'held'
  for update;

  if not found then
    return 0;
  end if;

  reserved_quantity := reservation_record.quantity;

  select stock_quantity
    into product_stock
  from public.products
  where id = p_product_id
  for update;

  if product_stock is not null then
    update public.products
    set stock_quantity = stock_quantity - reserved_quantity
    where id = p_product_id;
  end if;

  update public.stock_reservations
  set status = 'confirmed',
      confirmed_at = now(),
      updated_at = now()
  where id = reservation_record.id;

  return reserved_quantity;
end;
$function$;

revoke all on function public.confirm_stock_reservation(uuid, text) from public, anon, authenticated;

create or replace function public.release_unpaid_stock_reservation(
  p_order_id uuid,
  p_product_id text,
  p_reason text default 'expired'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  reservation_record record;
  release_quantity integer;
begin
  if p_order_id is null then
    raise exception using errcode = '22023', message = 'Order id is required';
  end if;

  if p_product_id is null or length(trim(p_product_id)) = 0 then
    raise exception using errcode = '22023', message = 'Product id is required';
  end if;

  select *
    into reservation_record
  from public.stock_reservations
  where order_id = p_order_id
    and product_id = p_product_id
    and status = 'held'
  for update;

  if not found then
    return 0;
  end if;

  if exists (
    select 1
    from public.orders
    where id = p_order_id
      and payment_status = 'paid'
  ) then
    raise exception using errcode = '22023', message = 'Cannot release a reservation for a paid order';
  end if;

  release_quantity := reservation_record.quantity;

  update public.stock_reservations
  set status = 'released',
      released_at = now(),
      release_reason = coalesce(p_reason, 'expired'),
      updated_at = now()
  where id = reservation_record.id;

  return release_quantity;
end;
$function$;

revoke all on function public.release_unpaid_stock_reservation(uuid, text, text) from public, anon, authenticated;

create or replace function public.get_pending_checkout_session(p_order_id uuid)
returns table (
  id uuid,
  stripe_checkout_session_id text,
  status text,
  amount_total bigint,
  currency text,
  expires_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $function$
  select id, stripe_checkout_session_id, status, amount_total, currency, expires_at, created_at
  from public.checkout_sessions
  where order_id = p_order_id
  order by created_at desc
  limit 1;
$function$;

revoke all on function public.get_pending_checkout_session(uuid) from public, anon, authenticated;

create or replace function public.mark_checkout_session_paid(p_order_id uuid, p_checkout_session_id text, p_payment_intent_id text, p_amount_total bigint, p_currency text)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update public.checkout_sessions
  set status = 'paid',
      stripe_payment_intent_id = p_payment_intent_id,
      amount_total = p_amount_total,
      currency = p_currency,
      updated_at = now()
  where order_id = p_order_id
    and stripe_checkout_session_id = p_checkout_session_id;

  update public.orders
  set payment_status = 'paid',
      payment_provider = 'stripe',
      payment_reference = coalesce(payment_reference, p_payment_intent_id),
      checkout_session_id = p_checkout_session_id,
      payment_intent_id = p_payment_intent_id,
      currency = p_currency,
      paid_at = now(),
      updated_at = now()
  where id = p_order_id;
end;
$function$;

revoke all on function public.mark_checkout_session_paid(uuid, text, text, bigint, text) from public, anon, authenticated;

create index if not exists checkout_sessions_order_session_idx
  on public.checkout_sessions (order_id, stripe_checkout_session_id);

create or replace function public.set_event_status(p_event_id text, p_status text, p_error_message text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update public.payment_events
  set event_status = p_status,
      error_message = p_error_message,
      processed_at = case when p_status in ('succeeded', 'failed') then now() else processed_at end,
      updated_at = now()
  where event_id = p_event_id;
end;
$function$;

revoke all on function public.set_event_status(text, text, text) from public, anon, authenticated;

-- Ensure the event table stays provider-agnostic but Stripe-only for now.
create index if not exists payment_events_event_status_idx
  on public.payment_events (event_status, processed_at);
