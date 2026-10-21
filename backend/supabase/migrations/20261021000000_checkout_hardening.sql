alter table public.checkout_sessions
  alter column stripe_checkout_session_id drop not null,
  add column if not exists attempt_key text,
  add column if not exists request_fingerprint text;

alter table public.checkout_sessions
  drop constraint if exists checkout_sessions_status_check,
  add constraint checkout_sessions_status_check
    check (status in ('creating', 'created', 'pending', 'paid', 'expired', 'cancelled', 'failed', 'requires_action'));

create unique index if not exists checkout_sessions_attempt_key_idx
  on public.checkout_sessions (attempt_key)
  where attempt_key is not null;
create unique index if not exists checkout_sessions_payment_intent_idx
  on public.checkout_sessions (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;
create unique index if not exists orders_checkout_session_id_idx
  on public.orders (checkout_session_id)
  where checkout_session_id is not null;
create unique index if not exists orders_payment_intent_id_idx
  on public.orders (payment_intent_id)
  where payment_intent_id is not null;
create unique index if not exists checkout_sessions_one_active_attempt_per_order_idx
  on public.checkout_sessions (order_id)
  where status in ('creating', 'created', 'pending', 'requires_action');

alter table public.payment_events
  add column if not exists payment_intent_id text,
  add column if not exists amount_total bigint,
  add column if not exists currency text;

alter table public.payment_events
  drop constraint if exists payment_events_amount_total_check,
  add constraint payment_events_amount_total_check
    check (amount_total is null or amount_total >= 0),
  drop constraint if exists payment_events_currency_check,
  add constraint payment_events_currency_check
    check (currency is null or length(currency) = 3);

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

  select stock_quantity into on_hand
  from public.products
  where id = p_product_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Product not found';
  end if;

  if on_hand is null then
    return null;
  end if;

  select coalesce(sum(quantity), 0)::integer into reserved_quantity
  from public.stock_reservations
  where product_id = p_product_id
    and status = 'held'
    and expires_at > now();

  return on_hand - reserved_quantity;
end;
$function$;

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
  product_is_available boolean;
  product_is_published boolean;
  reserved_total integer;
  active_reservation public.stock_reservations%rowtype;
  previous_reservation_id uuid;
  resolved_expiry timestamptz;
begin
  if p_order_id is null or p_product_id is null or length(trim(p_product_id)) = 0 then
    raise exception using errcode = '22023', message = 'Order and product ids are required';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception using errcode = '22023', message = 'Reservation quantity must be greater than zero';
  end if;

  perform 1 from public.orders where id = p_order_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Order not found';
  end if;
  if exists (
    select 1 from public.orders
    where id = p_order_id and payment_status = 'paid'
  ) then
    raise exception using errcode = '22023', message = 'Cannot reserve stock for a paid order';
  end if;

  select stock_quantity, is_available, is_published
    into product_stock, product_is_available, product_is_published
  from public.products
  where id = p_product_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Product not found';
  end if;
  if not product_is_available or not product_is_published then
    raise exception using errcode = '22023', message = 'Product is unavailable';
  end if;

  resolved_expiry := coalesce(p_expires_at, now() + interval '20 minutes');
  if resolved_expiry <= now() or resolved_expiry > now() + interval '1 hour' then
    raise exception using errcode = '22023', message = 'Reservation expiry must be within the next hour';
  end if;

  update public.stock_reservations
  set status = 'expired',
      released_at = now(),
      release_reason = 'expired',
      updated_at = now()
  where order_id = p_order_id
    and product_id = p_product_id
    and status = 'held'
    and expires_at <= now();

  select * into active_reservation
  from public.stock_reservations
  where order_id = p_order_id
    and product_id = p_product_id
    and status = 'held'
  for update;

  select coalesce(sum(quantity), 0)::integer into reserved_total
  from public.stock_reservations
  where product_id = p_product_id
    and status = 'held'
    and expires_at > now()
    and (active_reservation.id is null or id <> active_reservation.id);

  if product_stock is not null and product_stock - reserved_total < p_quantity then
    raise exception using errcode = '22023', message = 'Insufficient stock available';
  end if;

  if active_reservation.id is not null then
    update public.stock_reservations
    set quantity = p_quantity,
        checkout_session_id = p_checkout_session_id,
        expires_at = resolved_expiry,
        updated_at = now()
    where id = active_reservation.id;
    return p_quantity;
  end if;

  select id into previous_reservation_id
  from public.stock_reservations
  where order_id = p_order_id and product_id = p_product_id
  order by created_at desc
  limit 1
  for update;

  if previous_reservation_id is not null then
    update public.stock_reservations
    set quantity = p_quantity,
        checkout_session_id = p_checkout_session_id,
        status = 'held',
        expires_at = resolved_expiry,
        confirmed_at = null,
        released_at = null,
        release_reason = null,
        updated_at = now()
    where id = previous_reservation_id;
  else
    insert into public.stock_reservations
      (order_id, product_id, quantity, checkout_session_id, status, expires_at)
    values
      (p_order_id, p_product_id, p_quantity, p_checkout_session_id, 'held', resolved_expiry);
  end if;

  return p_quantity;
end;
$function$;

create or replace function public.set_product_stock_quantity(
  target_product_id text,
  next_quantity integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  updated_quantity integer;
  active_reserved integer;
begin
  perform public.require_beautypluz_admin();

  if next_quantity is not null and next_quantity < 0 then
    raise exception using errcode = '22023', message = 'Inventory quantity cannot be negative';
  end if;

  perform 1 from public.products where id = target_product_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Product not found';
  end if;

  if next_quantity is not null then
    select coalesce(sum(quantity), 0)::integer into active_reserved
    from public.stock_reservations
    where product_id = target_product_id
      and status = 'held'
      and expires_at > now();
    if next_quantity < active_reserved then
      raise exception using errcode = '22023', message = 'Inventory cannot be reduced below active reservations';
    end if;
  end if;

  update public.products
  set stock_quantity = next_quantity
  where id = target_product_id
  returning stock_quantity into updated_quantity;
  return updated_quantity;
end;
$function$;

revoke all on function public.set_product_stock_quantity(text, integer) from public, anon;
grant execute on function public.set_product_stock_quantity(text, integer) to authenticated;

create or replace function public.create_checkout_attempt(
  p_attempt_key text,
  p_order_id uuid,
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_shipping_address text,
  p_items jsonb,
  p_delivery_fee_pence bigint,
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
  normalized_items jsonb;
  fingerprint text;
  existing_attempt public.checkout_sessions%rowtype;
  order_record public.orders%rowtype;
  line record;
  unit_price numeric(10,2);
  subtotal_amount numeric(10,2);
  order_amount bigint;
  created_order_id uuid;
  created_attempt_id uuid;
  item_count integer;
  matched_count integer;
begin
  if p_attempt_key is null or length(trim(p_attempt_key)) < 16 or length(p_attempt_key) > 200 then
    raise exception using errcode = '22023', message = 'A valid checkout idempotency key is required';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Checkout items must be an array';
  end if;
  if jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 50 then
    raise exception using errcode = '22023', message = 'Checkout must contain between 1 and 50 products';
  end if;
  if p_delivery_fee_pence is null or p_delivery_fee_pence < 0 or p_delivery_fee_pence > 10000000 then
    raise exception using errcode = '22023', message = 'Invalid delivery fee';
  end if;
  if p_hold_expires_at is null
     or p_hold_expires_at <= now()
     or p_hold_expires_at > now() + interval '1 hour' then
    raise exception using errcode = '22023', message = 'Checkout hold expiry must be within the next hour';
  end if;
  if p_customer_name is null or length(trim(p_customer_name)) not between 1 and 180
     or p_customer_email is null or length(trim(p_customer_email)) not between 3 and 254
     or (p_customer_phone is not null and length(p_customer_phone) > 40)
     or (p_shipping_address is not null and length(p_shipping_address) > 1000) then
    raise exception using errcode = '22023', message = 'Invalid customer details';
  end if;

  select jsonb_agg(
    jsonb_build_object('product_id', item.product_id, 'quantity', item.quantity)
    order by item.product_id
  )
  into normalized_items
  from jsonb_to_recordset(p_items) as item(product_id text, quantity integer);

  select count(*) into item_count
  from jsonb_to_recordset(p_items) as item(product_id text, quantity integer);

  if item_count <> jsonb_array_length(p_items)
     or exists (
       select 1 from jsonb_to_recordset(p_items) as item(product_id text, quantity integer)
       where item.product_id is null or length(trim(item.product_id)) = 0
          or item.quantity is null or item.quantity <= 0 or item.quantity > 100
     )
     or exists (
       select 1
       from jsonb_to_recordset(p_items) as item(product_id text, quantity integer)
       group by item.product_id
       having count(*) > 1
     ) then
    raise exception using errcode = '22023', message = 'Checkout contains invalid or duplicate product lines';
  end if;

  fingerprint := md5(jsonb_build_object(
    'name', trim(p_customer_name),
    'email', lower(trim(p_customer_email)),
    'phone', p_customer_phone,
    'address', p_shipping_address,
    'delivery_fee_pence', p_delivery_fee_pence,
    'items', normalized_items
  )::text);

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_attempt_key, 0));

  select * into existing_attempt
  from public.checkout_sessions
  where attempt_key = p_attempt_key
  for update;

  if found then
    if existing_attempt.request_fingerprint is distinct from fingerprint then
      raise exception using errcode = '22023', message = 'Idempotency key was reused with different checkout data';
    end if;
    return query select existing_attempt.order_id, existing_attempt.id,
      existing_attempt.amount_total, existing_attempt.currency, true;
    return;
  end if;

  if p_order_id is null then
    created_order_id := gen_random_uuid();
    for line in
      select product.id, product.name, product.image_url,
             coalesce(product.sale_price, product.price)::numeric(10,2) as current_price,
             item.quantity
      from jsonb_to_recordset(p_items) as item(product_id text, quantity integer)
      join public.products as product on product.id = item.product_id
      order by product.id
      for update of product
    loop
      if not exists (
        select 1 from public.products
        where id = line.id and is_published and is_available
      ) then
        raise exception using errcode = '22023', message = 'A checkout product is unavailable';
      end if;
    end loop;

    select count(*) into matched_count
    from jsonb_to_recordset(p_items) as item(product_id text, quantity integer)
    join public.products as product on product.id = item.product_id;
    if matched_count <> item_count then
      raise exception using errcode = 'P0002', message = 'A checkout product was not found';
    end if;

    select coalesce(sum(coalesce(product.sale_price, product.price) * item.quantity), 0)::numeric(10,2)
      into subtotal_amount
    from jsonb_to_recordset(p_items) as item(product_id text, quantity integer)
    join public.products as product on product.id = item.product_id;

    order_amount := round(subtotal_amount * 100)::bigint + p_delivery_fee_pence;
    if order_amount <= 0 then
      raise exception using errcode = '22023', message = 'Checkout total must be greater than zero';
    end if;

    insert into public.orders
      (id, customer_name, customer_email, customer_phone, shipping_address,
       subtotal, delivery_fee, total, fulfillment_status, payment_status, currency)
    values
      (created_order_id, trim(p_customer_name), lower(trim(p_customer_email)),
       nullif(trim(p_customer_phone), ''), nullif(trim(p_shipping_address), ''),
       subtotal_amount, (p_delivery_fee_pence::numeric / 100)::numeric(10,2),
       (order_amount::numeric / 100)::numeric(10,2), 'pending', 'pending', 'GBP');

    insert into public.order_items
      (order_id, product_id, product_name, unit_price, image_url, quantity)
    select created_order_id, product.id, product.name,
           coalesce(product.sale_price, product.price), product.image_url, item.quantity
    from jsonb_to_recordset(p_items) as item(product_id text, quantity integer)
    join public.products as product on product.id = item.product_id
    order by product.id;
  else
    select * into order_record
    from public.orders
    where id = p_order_id
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'Order not found';
    end if;
    if order_record.payment_status not in ('pending', 'failed')
       or order_record.fulfillment_status = 'cancelled' then
      raise exception using errcode = '22023', message = 'Order cannot accept another checkout attempt';
    end if;
    if order_record.customer_email is distinct from lower(trim(p_customer_email))
       or order_record.customer_name is distinct from trim(p_customer_name)
       or order_record.customer_phone is distinct from nullif(trim(p_customer_phone), '')
       or order_record.shipping_address is distinct from nullif(trim(p_shipping_address), '')
       or order_record.delivery_fee is distinct from (p_delivery_fee_pence::numeric / 100)::numeric(10,2) then
      raise exception using errcode = '22023', message = 'Retry details do not match the existing order';
    end if;

    update public.checkout_sessions
    set status = 'expired',
        updated_at = now()
    where checkout_sessions.order_id = p_order_id
      and status in ('creating', 'created', 'pending', 'requires_action')
      and expires_at <= now();
    update public.stock_reservations
    set status = 'expired',
        released_at = now(),
        release_reason = 'expired',
        updated_at = now()
    where stock_reservations.order_id = p_order_id
      and status = 'held'
      and expires_at <= now();

    if exists (
      select 1 from public.checkout_sessions
      where checkout_sessions.order_id = p_order_id
        and status in ('creating', 'created', 'pending', 'requires_action')
    ) then
      raise exception using errcode = '22023', message = 'An active checkout attempt already exists for this order';
    end if;

    select count(*) into matched_count
    from public.order_items as saved
    join jsonb_to_recordset(p_items) as item(product_id text, quantity integer)
      on saved.product_id = item.product_id and saved.quantity = item.quantity
    where saved.order_id = p_order_id;
    if matched_count <> item_count
       or (select count(*) from public.order_items where order_items.order_id = p_order_id) <> item_count then
      raise exception using errcode = '22023', message = 'Retry basket does not match the existing order';
    end if;

    created_order_id := p_order_id;
    subtotal_amount := order_record.subtotal;
    order_amount := round(order_record.total * 100)::bigint;
    update public.orders
    set payment_status = 'pending',
        payment_failure_reason = null
    where id = p_order_id;
  end if;

  for line in
    select item.product_id, item.quantity
    from jsonb_to_recordset(p_items) as item(product_id text, quantity integer)
    order by item.product_id
  loop
    perform public.reserve_stock_for_order(
      created_order_id, line.product_id, line.quantity, null, p_hold_expires_at
    );
  end loop;

  insert into public.checkout_sessions
    (order_id, stripe_checkout_session_id, status, amount_total, currency,
     customer_email, customer_name, expires_at, attempt_key, request_fingerprint, metadata)
  values
    (created_order_id, null, 'creating', order_amount, 'GBP',
     lower(trim(p_customer_email)), trim(p_customer_name), p_hold_expires_at,
     p_attempt_key, fingerprint,
     jsonb_build_object('order_id', created_order_id, 'attempt_key', p_attempt_key))
  returning id into created_attempt_id;

  return query select created_order_id, created_attempt_id, order_amount, 'GBP'::text, false;
end;
$function$;

create or replace function public.attach_stripe_checkout_session(
  p_attempt_key text,
  p_stripe_session_id text,
  p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_record public.checkout_sessions%rowtype;
  order_id_to_lock uuid;
begin
  select order_id into order_id_to_lock
  from public.checkout_sessions
  where attempt_key = p_attempt_key;
  if not found then
    raise exception using errcode = 'P0002', message = 'Checkout attempt not found';
  end if;
  perform 1 from public.orders where id = order_id_to_lock for update;

  select * into attempt_record
  from public.checkout_sessions
  where attempt_key = p_attempt_key
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Checkout attempt not found';
  end if;
  if p_stripe_session_id is null or p_stripe_session_id not like 'cs_%'
     or p_expires_at is null or p_expires_at <= now()
     or p_expires_at > now() + interval '1 hour' then
    raise exception using errcode = '22023', message = 'Invalid Stripe Checkout Session reference';
  end if;
  if attempt_record.stripe_checkout_session_id is not null then
    if attempt_record.stripe_checkout_session_id <> p_stripe_session_id then
      raise exception using errcode = '22023', message = 'Checkout attempt is already bound to another Stripe session';
    end if;
    return;
  end if;
  if attempt_record.status <> 'creating' then
    raise exception using errcode = '22023', message = 'Checkout attempt is not awaiting a Stripe session';
  end if;

  update public.checkout_sessions
  set stripe_checkout_session_id = p_stripe_session_id,
      status = 'created',
      expires_at = p_expires_at,
      updated_at = now()
  where id = attempt_record.id;
  update public.stock_reservations
  set checkout_session_id = p_stripe_session_id,
      expires_at = p_expires_at,
      updated_at = now()
  where order_id = attempt_record.order_id and status = 'held';
  update public.orders
  set checkout_session_id = p_stripe_session_id,
      checkout_expires_at = p_expires_at
  where id = attempt_record.order_id;
end;
$function$;

create or replace function public.process_stripe_checkout_event(
  p_event_id text,
  p_event_type text,
  p_attempt_key text,
  p_stripe_session_id text,
  p_payment_intent_id text,
  p_amount_total bigint,
  p_currency text,
  p_action text
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt_record public.checkout_sessions%rowtype;
  order_record public.orders%rowtype;
  line record;
  inserted_event_id bigint;
  active_reservations integer;
  saved_items integer;
  result text;
begin
  if p_event_id is null or length(p_event_id) < 8
     or p_event_type is null or p_attempt_key is null
     or p_stripe_session_id is null or p_stripe_session_id not like 'cs_%'
     or p_currency is null or length(trim(p_currency)) <> 3
     or p_action is null
     or p_action not in ('paid', 'failed', 'expired')
     or p_amount_total is null or p_amount_total < 0 then
    raise exception using errcode = '22023', message = 'Invalid verified Stripe event fields';
  end if;
  p_currency := upper(coalesce(trim(p_currency), ''));

  select * into attempt_record
  from public.checkout_sessions
  where attempt_key = p_attempt_key;

  if not found then
    insert into public.payment_events
      (event_id, event_type, event_status, error_message, payload,
       checkout_session_id, payment_intent_id, amount_total, currency)
    values
      (p_event_id, p_event_type, 'failed', 'No matching checkout attempt',
       jsonb_build_object('session_id', p_stripe_session_id,
         'payment_intent_id', p_payment_intent_id,
         'amount_total', p_amount_total, 'currency', p_currency),
       p_stripe_session_id, p_payment_intent_id, p_amount_total, p_currency)
    on conflict (event_id) do nothing
    returning id into inserted_event_id;
    if inserted_event_id is null then
      return 'duplicate';
    end if;
    return 'unmatched';
  end if;

  select * into order_record
  from public.orders
  where id = attempt_record.order_id
  for update;
  select * into attempt_record
  from public.checkout_sessions
  where id = attempt_record.id
  for update;

  insert into public.payment_events
    (event_id, event_type, order_id, checkout_session_id, payment_intent_id,
     amount_total, currency, event_status, payload)
  values
    (p_event_id, p_event_type, attempt_record.order_id, p_stripe_session_id,
     p_payment_intent_id, p_amount_total, p_currency, 'processing',
     jsonb_build_object('session_id', p_stripe_session_id,
       'payment_intent_id', p_payment_intent_id,
       'amount_total', p_amount_total, 'currency', p_currency))
  on conflict (event_id) do nothing
  returning id into inserted_event_id;
  if inserted_event_id is null then
    return 'duplicate';
  end if;

  if attempt_record.stripe_checkout_session_id is not null
     and attempt_record.stripe_checkout_session_id <> p_stripe_session_id then
    update public.payment_events
    set event_status = 'failed', error_message = 'Stripe session does not match checkout attempt',
        processed_at = now()
    where id = inserted_event_id;
    return 'mismatch';
  end if;
  if p_amount_total <> attempt_record.amount_total or upper(coalesce(p_currency, '')) <> attempt_record.currency then
    update public.payment_events
    set event_status = 'failed', error_message = 'Stripe amount or currency does not match checkout attempt',
        processed_at = now()
    where id = inserted_event_id;
    return 'mismatch';
  end if;

  if attempt_record.stripe_checkout_session_id is null then
    if attempt_record.status <> 'creating' then
      update public.payment_events
      set event_status = 'failed', error_message = 'Checkout attempt cannot be bound to a Stripe session',
          processed_at = now()
      where id = inserted_event_id;
      return 'mismatch';
    end if;
    update public.checkout_sessions
    set stripe_checkout_session_id = p_stripe_session_id,
        status = 'created',
        updated_at = now()
    where id = attempt_record.id;
    update public.stock_reservations
    set checkout_session_id = p_stripe_session_id,
        updated_at = now()
    where order_id = attempt_record.order_id and status = 'held';
  end if;

  if p_action = 'paid' then
    if p_payment_intent_id is null or length(trim(p_payment_intent_id)) = 0 then
      update public.payment_events
      set event_status = 'failed', error_message = 'Verified payment has no PaymentIntent reference',
          processed_at = now()
      where id = inserted_event_id;
      return 'mismatch';
    end if;

    if order_record.payment_status = 'paid' then
      if order_record.payment_intent_id = p_payment_intent_id
         and order_record.checkout_session_id = p_stripe_session_id then
        update public.checkout_sessions
        set status = 'paid', stripe_payment_intent_id = p_payment_intent_id, updated_at = now()
        where id = attempt_record.id;
        update public.payment_events
        set event_status = 'succeeded', processed_at = now()
        where id = inserted_event_id;
        return 'already_paid';
      end if;
      update public.checkout_sessions
      set status = 'paid', stripe_payment_intent_id = p_payment_intent_id, updated_at = now()
      where id = attempt_record.id;
      update public.payment_events
      set event_status = 'failed',
          error_message = 'Additional successful payment requires refund reconciliation',
          processed_at = now()
      where id = inserted_event_id;
      return 'reconciliation_required';
    end if;

    if order_record.payment_status not in ('pending', 'failed')
       or order_record.fulfillment_status = 'cancelled' then
      update public.payment_events
      set event_status = 'failed', error_message = 'Order is not eligible for payment confirmation',
          processed_at = now()
      where id = inserted_event_id;
      return 'reconciliation_required';
    end if;

    for line in
      select product.id, product.stock_quantity, saved.quantity
      from public.order_items as saved
      join public.products as product on product.id = saved.product_id
      where saved.order_id = attempt_record.order_id
      order by product.id
      for update of product
    loop
      perform 1 from public.stock_reservations as reservation
      where reservation.order_id = attempt_record.order_id
        and reservation.product_id = line.id
        and reservation.checkout_session_id = p_stripe_session_id
        and reservation.status = 'held'
        and reservation.expires_at > now()
      for update;
      if not found then
        update public.payment_events
        set event_status = 'failed',
            error_message = 'Verified payment arrived after its stock reservation expired or was released',
            processed_at = now()
        where id = inserted_event_id;
        return 'reconciliation_required';
      end if;
      if line.stock_quantity is not null and line.stock_quantity < line.quantity then
        update public.payment_events
        set event_status = 'failed',
            error_message = 'On-hand stock no longer covers the verified payment',
            processed_at = now()
        where id = inserted_event_id;
        return 'reconciliation_required';
      end if;
    end loop;

    select count(*) into saved_items
    from public.order_items
    where order_id = attempt_record.order_id;
    select count(*) into active_reservations
    from public.stock_reservations
    where order_id = attempt_record.order_id
      and checkout_session_id = p_stripe_session_id
      and status = 'held'
      and expires_at > now();
    if saved_items = 0 or active_reservations <> saved_items then
      update public.payment_events
      set event_status = 'failed',
          error_message = 'Order reservations are incomplete',
          processed_at = now()
      where id = inserted_event_id;
      return 'reconciliation_required';
    end if;

    update public.products as product
    set stock_quantity = product.stock_quantity - saved.quantity
    from public.order_items as saved
    where saved.order_id = attempt_record.order_id
      and saved.product_id = product.id
      and product.stock_quantity is not null;
    update public.stock_reservations
    set status = 'confirmed', confirmed_at = now(), updated_at = now()
    where order_id = attempt_record.order_id and status = 'held';
    update public.checkout_sessions
    set status = 'paid', stripe_payment_intent_id = p_payment_intent_id, updated_at = now()
    where id = attempt_record.id;
    update public.orders
    set payment_status = 'paid', payment_provider = 'stripe',
        payment_reference = p_payment_intent_id,
        payment_intent_id = p_payment_intent_id,
        checkout_session_id = p_stripe_session_id,
        currency = 'GBP', paid_at = now(), payment_failure_reason = null
    where id = attempt_record.order_id;
    update public.payment_events
    set event_status = 'succeeded', processed_at = now()
    where id = inserted_event_id;
    return 'paid';
  end if;

  if order_record.payment_status = 'paid' then
    update public.checkout_sessions
    set status = case when status = 'paid' then status else p_action end,
        updated_at = now()
    where id = attempt_record.id;
    update public.payment_events
    set event_status = 'succeeded', processed_at = now()
    where id = inserted_event_id;
    return 'already_paid';
  end if;

  update public.checkout_sessions
  set status = p_action, updated_at = now()
  where id = attempt_record.id and status <> 'paid';

  if not exists (
    select 1 from public.checkout_sessions
    where order_id = attempt_record.order_id
      and status in ('creating', 'created', 'pending', 'requires_action')
      and expires_at > now()
  ) then
    for line in
      select product.id
      from public.order_items as saved
      join public.products as product on product.id = saved.product_id
      where saved.order_id = attempt_record.order_id
      order by product.id
      for update of product
    loop
      update public.stock_reservations
      set status = case when p_action = 'expired' then 'expired' else 'released' end,
          released_at = now(),
          release_reason = p_action,
          updated_at = now()
      where order_id = attempt_record.order_id
        and product_id = line.id
        and status = 'held';
    end loop;
    update public.orders
    set payment_status = 'failed',
        payment_failure_reason = p_action
    where id = attempt_record.order_id
      and payment_status <> 'paid';
  end if;

  update public.payment_events
  set event_status = 'succeeded', processed_at = now()
  where id = inserted_event_id;
  return p_action;
end;
$function$;

drop function if exists public.mark_checkout_session_paid(uuid, text, text, bigint, text);
drop function if exists public.set_event_status(text, text, text);

revoke all on function public.confirm_stock_reservation(uuid, text) from public, anon, authenticated;
revoke all on function public.release_unpaid_stock_reservation(uuid, text, text) from public, anon, authenticated;
revoke all on function public.get_pending_checkout_session(uuid) from public, anon, authenticated;
revoke all on function public.get_product_available_stock(text) from public, anon, authenticated;
revoke all on function public.reserve_stock_for_order(uuid, text, integer, text, timestamptz) from public, anon, authenticated;
revoke all on function public.create_checkout_attempt(text, uuid, text, text, text, text, jsonb, bigint, timestamptz) from public, anon, authenticated;
revoke all on function public.attach_stripe_checkout_session(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.process_stripe_checkout_event(text, text, text, text, text, bigint, text, text) from public, anon, authenticated;

grant execute on function public.reserve_stock_for_order(uuid, text, integer, text, timestamptz) to service_role;
grant execute on function public.get_product_available_stock(text) to service_role;
grant execute on function public.create_checkout_attempt(text, uuid, text, text, text, text, jsonb, bigint, timestamptz) to service_role;
grant execute on function public.attach_stripe_checkout_session(text, text, timestamptz) to service_role;
grant execute on function public.process_stripe_checkout_event(text, text, text, text, text, bigint, text, text) to service_role;
