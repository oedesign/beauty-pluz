create extension if not exists pgcrypto with schema extensions;

alter table public.checkout_settings
  add column if not exists rate_limit_max_requests integer
    check (rate_limit_max_requests between 1 and 100),
  add column if not exists rate_limit_window_seconds integer
    check (rate_limit_window_seconds between 1 and 86400),
  add column if not exists reservation_lifetime_seconds integer
    check (reservation_lifetime_seconds between 60 and 604800);

alter table public.orders
  add column if not exists checkout_request_hash bytea
    check (checkout_request_hash is null or octet_length(checkout_request_hash) = 32),
  add column if not exists checkout_reservation_expires_at timestamptz;

alter table public.order_inventory_reservations
  add column if not exists expires_at timestamptz;

create table if not exists public.checkout_request_limits (
  identity_hash bytea primary key check (octet_length(identity_hash) = 32),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0)
);

create index if not exists checkout_request_limits_window_idx
  on public.checkout_request_limits (window_started_at);

alter table public.checkout_request_limits enable row level security;
revoke all on public.checkout_request_limits from public, anon, authenticated, service_role;

create or replace function public.consume_checkout_request_limit(p_identity_hash bytea)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_max_requests integer;
  v_window_seconds integer;
  v_request_count integer;
  v_now timestamptz := clock_timestamp();
begin
  if p_identity_hash is null or octet_length(p_identity_hash) <> 32 then
    raise exception using errcode = '22023', message = 'Invalid rate-limit identity';
  end if;

  select settings.rate_limit_max_requests, settings.rate_limit_window_seconds
  into v_max_requests, v_window_seconds
  from public.checkout_settings as settings
  where settings.id;

  if not found or v_max_requests is null or v_window_seconds is null then
    raise exception using errcode = '55000', message = 'Checkout request limits are not configured';
  end if;

  delete from public.checkout_request_limits as limits
  where limits.window_started_at < v_now - make_interval(secs => v_window_seconds * 2);

  insert into public.checkout_request_limits as limits (
    identity_hash,
    window_started_at,
    request_count
  )
  values (
    p_identity_hash,
    v_now,
    1
  )
  on conflict (identity_hash) do update
  set window_started_at = case
        when limits.window_started_at + make_interval(secs => v_window_seconds) <= v_now
          then v_now
        else limits.window_started_at
      end,
      request_count = case
        when limits.window_started_at + make_interval(secs => v_window_seconds) <= v_now
          then 1
        else least(limits.request_count + 1, v_max_requests + 1)
      end
  returning limits.request_count into v_request_count;

  return v_request_count <= v_max_requests;
end;
$function$;

revoke all on function public.consume_checkout_request_limit(bytea)
  from public, anon, authenticated;
grant execute on function public.consume_checkout_request_limit(bytea)
  to service_role;

create or replace function public.create_checkout_order(
  p_idempotency_key uuid,
  p_customer_name text,
  p_customer_phone text,
  p_shipping_address text,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order_id uuid;
  v_existing_hash bytea;
  v_existing_expiry timestamptz;
  v_request_hash bytea;
  v_delivery_pence bigint;
  v_reservation_lifetime_seconds integer;
  v_subtotal_pence bigint := 0;
  v_total_pence bigint;
  v_requested_count integer;
  v_found_count integer := 0;
  v_quantity integer;
  v_unit_price numeric(10, 2);
  v_line_pence bigint;
  v_product public.products%rowtype;
  v_request_item jsonb;
  v_updated_rows integer;
  v_expires_at timestamptz;
begin
  if p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'A checkout request key is required';
  end if;

  p_customer_name := btrim(p_customer_name);
  p_customer_phone := btrim(p_customer_phone);
  p_shipping_address := btrim(p_shipping_address);

  if p_customer_name is null
     or length(p_customer_name) not between 1 and 120
     or p_customer_name ~ '[[:cntrl:]]'
     or p_customer_phone is null
     or length(p_customer_phone) not between 5 and 40
     or p_customer_phone !~ '^[+0-9() .-]+$'
     or length(regexp_replace(p_customer_phone, '[^0-9]', '', 'g')) not between 5 and 15
     or p_shipping_address is null
     or length(p_shipping_address) not between 5 and 500
     or p_shipping_address ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'Customer or delivery details are invalid';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'The requested cart is invalid';
  end if;

  v_requested_count := jsonb_array_length(p_items);
  if v_requested_count not between 1 and 50 then
    raise exception using errcode = '22023', message = 'The requested cart is invalid';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) as request_item(value)
    where jsonb_typeof(request_item.value) is distinct from 'object'
       or jsonb_typeof(request_item.value->'id') is distinct from 'string'
       or length(request_item.value->>'id') not between 1 and 80
       or btrim(request_item.value->>'id') <> request_item.value->>'id'
       or jsonb_typeof(request_item.value->'quantity') is distinct from 'number'
       or (request_item.value->>'quantity') !~ '^[1-9][0-9]{0,1}$'
  ) then
    raise exception using errcode = '22023', message = 'The requested cart is invalid';
  end if;

  if (
    select count(distinct request_item.value->>'id')
    from jsonb_array_elements(p_items) as request_item(value)
  ) <> v_requested_count then
    raise exception using errcode = '22023', message = 'The requested cart contains duplicate products';
  end if;

  select extensions.digest(
    convert_to(
      jsonb_build_object(
        'customerName', p_customer_name,
        'customerPhone', p_customer_phone,
        'shippingAddress', p_shipping_address,
        'items', (
          select jsonb_agg(
            jsonb_build_object(
              'id', request_item.value->>'id',
              'quantity', (request_item.value->>'quantity')::integer
            )
            order by request_item.value->>'id'
          )
          from jsonb_array_elements(p_items) as request_item(value)
        )
      )::text,
      'UTF8'
    ),
    'sha256'
  )
  into v_request_hash;

  select orders.id, orders.checkout_request_hash, orders.checkout_reservation_expires_at
  into v_order_id, v_existing_hash, v_existing_expiry
  from public.orders as orders
  where orders.checkout_idempotency_key = p_idempotency_key;

  if found then
    if v_existing_hash is distinct from v_request_hash
       or v_existing_expiry is null
       or v_existing_expiry <= clock_timestamp() then
      raise exception using errcode = 'P0001', message = 'Checkout request cannot be reused';
    end if;
    return v_order_id;
  end if;

  perform product.id
  from public.products as product
  join jsonb_array_elements(p_items) as request_item(value)
    on product.id = request_item.value->>'id'
  order by product.id
  for update of product;

  select orders.id, orders.checkout_request_hash, orders.checkout_reservation_expires_at
  into v_order_id, v_existing_hash, v_existing_expiry
  from public.orders as orders
  where orders.checkout_idempotency_key = p_idempotency_key;

  if found then
    if v_existing_hash is distinct from v_request_hash
       or v_existing_expiry is null
       or v_existing_expiry <= clock_timestamp() then
      raise exception using errcode = 'P0001', message = 'Checkout request cannot be reused';
    end if;
    return v_order_id;
  end if;

  select settings.delivery_amount_pence, settings.reservation_lifetime_seconds
  into v_delivery_pence, v_reservation_lifetime_seconds
  from public.checkout_settings as settings
  where settings.id;

  if not found or v_reservation_lifetime_seconds is null then
    raise exception using errcode = '55000', message = 'Checkout policy is not configured';
  end if;

  if v_delivery_pence is null
     or v_delivery_pence < 0
     or v_delivery_pence > 9999999999
     or v_reservation_lifetime_seconds not between 60 and 604800 then
    raise exception using errcode = '55000', message = 'Checkout policy is not configured';
  end if;

  for v_product in
    select product.*
    from public.products as product
    join jsonb_array_elements(p_items) as request_item(value)
      on product.id = request_item.value->>'id'
    order by product.id
    for update of product
  loop
    select (request_item.value->>'quantity')::integer
    into v_quantity
    from jsonb_array_elements(p_items) as request_item(value)
    where request_item.value->>'id' = v_product.id;

    if not v_product.is_published
       or not v_product.is_available
       or (v_product.stock_quantity is not null and v_product.stock_quantity < v_quantity) then
      raise exception using errcode = 'P0002', message = 'One or more products are unavailable';
    end if;

    v_unit_price := coalesce(v_product.sale_price, v_product.price);
    v_line_pence := v_unit_price * 100;
    v_subtotal_pence := v_subtotal_pence + v_line_pence * v_quantity;
    v_found_count := v_found_count + 1;
  end loop;

  if v_found_count <> v_requested_count then
    raise exception using errcode = 'P0002', message = 'One or more products are unavailable';
  end if;

  v_total_pence := v_subtotal_pence + v_delivery_pence;
  if v_total_pence > 9999999999 then
    raise exception using errcode = '22003', message = 'The checkout total is outside the supported range';
  end if;
  v_expires_at := clock_timestamp() + make_interval(secs => v_reservation_lifetime_seconds);

  begin
    insert into public.orders (
      checkout_idempotency_key,
      checkout_request_hash,
      checkout_reservation_expires_at,
      customer_name,
      customer_phone,
      shipping_address,
      subtotal,
      delivery_fee,
      total,
      fulfillment_status,
      payment_status
    )
    values (
      p_idempotency_key,
      v_request_hash,
      v_expires_at,
      p_customer_name,
      p_customer_phone,
      p_shipping_address,
      v_subtotal_pence::numeric / 100,
      v_delivery_pence::numeric / 100,
      v_total_pence::numeric / 100,
      'pending',
      'unverified'
    )
    returning id into v_order_id;
  exception when unique_violation then
    select orders.id, orders.checkout_request_hash, orders.checkout_reservation_expires_at
    into v_order_id, v_existing_hash, v_existing_expiry
    from public.orders as orders
    where orders.checkout_idempotency_key = p_idempotency_key;

    if found
       and v_existing_hash is not distinct from v_request_hash
       and v_existing_expiry > clock_timestamp() then
      return v_order_id;
    end if;
    raise exception using errcode = 'P0001', message = 'Checkout request cannot be reused';
  end;

  for v_request_item in
    select request_item.value
    from jsonb_array_elements(p_items) as request_item(value)
    order by request_item.value->>'id'
  loop
    select product.*
    into v_product
    from public.products as product
    where product.id = v_request_item->>'id';

    v_quantity := (v_request_item->>'quantity')::integer;
    v_unit_price := coalesce(v_product.sale_price, v_product.price);

    insert into public.order_items (
      order_id,
      product_id,
      product_name,
      unit_price,
      image_url,
      quantity
    )
    values (
      v_order_id,
      v_product.id,
      v_product.name,
      v_unit_price,
      v_product.image_url,
      v_quantity
    );

    if v_product.stock_quantity is not null then
      update public.products
      set stock_quantity = stock_quantity - v_quantity
      where id = v_product.id
        and stock_quantity >= v_quantity;

      get diagnostics v_updated_rows = row_count;
      if v_updated_rows <> 1 then
        raise exception using errcode = 'P0002', message = 'One or more products are unavailable';
      end if;

      insert into public.order_inventory_reservations (
        order_id,
        product_id,
        quantity,
        expires_at
      )
      values (
        v_order_id,
        v_product.id,
        v_quantity,
        v_expires_at
      );
    end if;
  end loop;

  return v_order_id;
end;
$function$;

revoke all on function public.create_checkout_order(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_checkout_order(uuid, text, text, text, jsonb)
  to service_role;

create or replace function public.release_expired_checkout_reservations(p_batch_size integer default 100)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reservation record;
  v_stock_quantity integer;
  v_updated_rows integer;
  v_released_count integer := 0;
begin
  if p_batch_size is null or p_batch_size not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Invalid reservation release batch size';
  end if;

  for v_reservation in
    select reservations.order_id, reservations.product_id, reservations.quantity
    from public.order_inventory_reservations as reservations
    where reservations.status = 'reserved'
      and reservations.expires_at is not null
      and reservations.expires_at <= clock_timestamp()
    order by reservations.expires_at, reservations.order_id, reservations.product_id
    for update of reservations skip locked
    limit p_batch_size
  loop
    update public.products as products
    set stock_quantity = products.stock_quantity + v_reservation.quantity
    where products.id = v_reservation.product_id
      and products.stock_quantity is not null
      and products.stock_quantity <= 2147483647 - v_reservation.quantity;

    get diagnostics v_updated_rows = row_count;
    if v_updated_rows = 0 then
      select products.stock_quantity
      into v_stock_quantity
      from public.products as products
      where products.id = v_reservation.product_id;

      if not found then
        raise exception using errcode = 'P0002', message = 'Reserved product is unavailable';
      end if;

      if v_stock_quantity is not null then
        raise exception using errcode = '22003', message = 'Reserved stock exceeds the supported range';
      end if;
    end if;

    update public.order_inventory_reservations as reservations
    set status = 'released',
        released_at = clock_timestamp()
    where reservations.order_id = v_reservation.order_id
      and reservations.product_id = v_reservation.product_id
      and reservations.status = 'reserved';

    get diagnostics v_updated_rows = row_count;
    if v_updated_rows = 1 then
      v_released_count := v_released_count + 1;
    end if;
  end loop;

  return v_released_count;
end;
$function$;

revoke all on function public.release_expired_checkout_reservations(integer)
  from public, anon, authenticated;
grant execute on function public.release_expired_checkout_reservations(integer)
  to service_role;
