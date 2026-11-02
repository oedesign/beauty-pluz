create table if not exists public.checkout_delivery_zones (
  zone_code text primary key
    check (zone_code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  display_name text not null
    check (length(btrim(display_name)) between 1 and 100),
  coverage_description text not null
    check (length(btrim(coverage_description)) between 1 and 500),
  delivery_amount_minor bigint
    check (delivery_amount_minor between 0 and 9999999999),
  currency text not null default 'GBP'
    check (currency = 'GBP'),
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.checkout_delivery_destinations (
  country_code text not null
    check (country_code ~ '^[A-Z]{2}$'),
  postal_code text not null
    check (postal_code ~ '^[A-Z0-9]{2,12}$'),
  zone_code text not null
    references public.checkout_delivery_zones (zone_code) on update cascade on delete restrict,
  created_at timestamptz not null default now(),
  primary key (country_code, postal_code)
);

alter table public.checkout_delivery_zones enable row level security;
alter table public.checkout_delivery_destinations enable row level security;
revoke all on public.checkout_delivery_zones, public.checkout_delivery_destinations
  from public, anon, authenticated, service_role;

alter table public.orders
  add column if not exists subtotal_minor bigint
    check (subtotal_minor between 0 and 9999999999),
  add column if not exists delivery_fee_minor bigint
    check (delivery_fee_minor between 0 and 9999999999),
  add column if not exists total_minor bigint
    check (total_minor between 0 and 9999999999),
  add column if not exists currency text
    check (currency is null or currency = 'GBP'),
  add column if not exists checkout_access_token_hash bytea
    check (checkout_access_token_hash is null or octet_length(checkout_access_token_hash) = 32),
  add column if not exists delivery_zone_code text
    references public.checkout_delivery_zones (zone_code) on update cascade on delete restrict,
  add column if not exists delivery_country_code text
    check (delivery_country_code is null or delivery_country_code ~ '^[A-Z]{2}$'),
  add column if not exists delivery_postal_code text
    check (delivery_postal_code is null or delivery_postal_code ~ '^[A-Z0-9]{2,12}$');

alter table public.orders
  drop constraint if exists orders_payment_status_check,
  add constraint orders_payment_status_check
    check (payment_status in ('unverified', 'pending', 'paid', 'failed', 'cancelled', 'expired', 'refunded'));

create table if not exists public.sumup_checkout_sessions (
  order_id uuid primary key references public.orders (id) on delete restrict,
  checkout_reference text not null unique
    check (length(checkout_reference) between 1 and 64),
  checkout_id text unique,
  hosted_checkout_url text,
  merchant_code text not null,
  payment_state text not null
    check (payment_state in ('creating', 'pending', 'paid', 'failed', 'cancelled', 'expired')),
  creation_lease_until timestamptz,
  last_verified_at timestamptz,
  transaction_reference text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sumup_checkout_session_creation_state_check check (
    (payment_state = 'creating' and checkout_id is null and hosted_checkout_url is null and creation_lease_until is not null)
    or (payment_state = 'expired' and checkout_id is null and hosted_checkout_url is null and creation_lease_until is null)
    or (payment_state not in ('creating', 'expired') and checkout_id is not null and hosted_checkout_url is not null and creation_lease_until is null)
    or (payment_state = 'expired' and checkout_id is not null and hosted_checkout_url is not null and creation_lease_until is null)
  ),
  constraint sumup_checkout_session_paid_reference_check check (
    payment_state <> 'paid' or transaction_reference is not null
  )
);

create index if not exists sumup_checkout_sessions_reconciliation_idx
  on public.sumup_checkout_sessions (payment_state, updated_at);

alter table public.sumup_checkout_sessions enable row level security;
revoke all on public.sumup_checkout_sessions from public, anon, authenticated, service_role;

drop function if exists public.create_checkout_order(uuid, text, text, text, jsonb);

create or replace function public.create_checkout_order(
  p_idempotency_key uuid,
  p_customer_name text,
  p_customer_phone text,
  p_shipping_address text,
  p_country_code text,
  p_postal_code text,
  p_checkout_access_token_hash bytea,
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
  v_country_code text;
  v_postal_code text;
  v_zone_code text;
  v_zone_name text;
  v_delivery_minor bigint;
  v_currency text;
  v_reservation_lifetime_seconds integer;
  v_subtotal_minor bigint := 0;
  v_total_minor bigint;
  v_requested_count integer;
  v_found_count integer := 0;
  v_quantity integer;
  v_unit_price numeric(10, 2);
  v_line_minor bigint;
  v_product public.products%rowtype;
  v_request_item jsonb;
  v_updated_rows integer;
  v_expires_at timestamptz;
begin
  if p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'A checkout request key is required';
  end if;
  if p_checkout_access_token_hash is null or octet_length(p_checkout_access_token_hash) <> 32 then
    raise exception using errcode = '22023', message = 'A checkout access token is required';
  end if;

  p_customer_name := btrim(p_customer_name);
  p_customer_phone := btrim(p_customer_phone);
  p_shipping_address := btrim(p_shipping_address);
  v_country_code := upper(btrim(p_country_code));
  v_postal_code := upper(regexp_replace(btrim(p_postal_code), '[[:space:]-]+', '', 'g'));

  if p_customer_name is null
     or length(p_customer_name) not between 1 and 120
     or p_customer_name ~ '[[:cntrl:]]'
     or p_customer_phone is null
     or length(p_customer_phone) not between 5 and 40
     or p_customer_phone !~ '^[+0-9() .-]+$'
     or length(regexp_replace(p_customer_phone, '[^0-9]', '', 'g')) not between 5 and 15
     or p_shipping_address is null
     or length(p_shipping_address) not between 5 and 500
     or p_shipping_address ~ '[[:cntrl:]]'
     or v_country_code !~ '^[A-Z]{2}$'
     or v_postal_code !~ '^[A-Z0-9]{2,12}$' then
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
        'countryCode', v_country_code,
        'postalCode', v_postal_code,
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
       or (select orders.checkout_access_token_hash from public.orders as orders where orders.id = v_order_id)
          is distinct from p_checkout_access_token_hash
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
       or (select orders.checkout_access_token_hash from public.orders as orders where orders.id = v_order_id)
          is distinct from p_checkout_access_token_hash
       or v_existing_expiry is null
       or v_existing_expiry <= clock_timestamp() then
      raise exception using errcode = 'P0001', message = 'Checkout request cannot be reused';
    end if;
    return v_order_id;
  end if;

  v_zone_code := null;
  v_zone_name := null;
  v_delivery_minor := 460;
  v_currency := 'GBP';

  select settings.reservation_lifetime_seconds
  into v_reservation_lifetime_seconds
  from public.checkout_settings as settings
  where settings.id;

  if not found or v_reservation_lifetime_seconds is null then
    raise exception using errcode = '55000', message = 'Checkout policy is not configured';
  end if;
  if v_reservation_lifetime_seconds not between 60 and 604800 then
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
    v_line_minor := v_unit_price * 100;
    v_subtotal_minor := v_subtotal_minor + v_line_minor * v_quantity;
    v_found_count := v_found_count + 1;
  end loop;

  if v_found_count <> v_requested_count then
    raise exception using errcode = 'P0002', message = 'One or more products are unavailable';
  end if;

  v_total_minor := v_subtotal_minor + v_delivery_minor;
  if v_total_minor > 9999999999 then
    raise exception using errcode = '22003', message = 'The checkout total is outside the supported range';
  end if;
  v_expires_at := clock_timestamp() + make_interval(secs => v_reservation_lifetime_seconds);

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
    subtotal_minor,
    delivery_fee_minor,
    total_minor,
    currency,
    delivery_zone_code,
    delivery_country_code,
    delivery_postal_code,
    checkout_access_token_hash,
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
    v_subtotal_minor::numeric / 100,
    v_delivery_minor::numeric / 100,
    v_total_minor::numeric / 100,
    v_subtotal_minor,
    v_delivery_minor,
    v_total_minor,
    v_currency,
    v_zone_code,
    v_country_code,
    v_postal_code,
    p_checkout_access_token_hash,
    'pending',
    'unverified'
  )
  returning id into v_order_id;

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
      order_id, product_id, product_name, unit_price, image_url, quantity
    )
    values (
      v_order_id, v_product.id, v_product.name, v_unit_price, v_product.image_url, v_quantity
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
        order_id, product_id, quantity, expires_at
      )
      values (
        v_order_id, v_product.id, v_quantity, v_expires_at
      );
    end if;
  end loop;

  return v_order_id;
end;
$function$;

revoke all on function public.create_checkout_order(uuid, text, text, text, text, text, bytea, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_checkout_order(uuid, text, text, text, text, text, bytea, jsonb)
  to service_role;

create or replace function public.claim_sumup_checkout(
  p_order_id uuid,
  p_access_token_hash bytea,
  p_merchant_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public.orders%rowtype;
  v_session public.sumup_checkout_sessions%rowtype;
  v_claimed boolean := false;
begin
  if p_order_id is null
     or p_access_token_hash is null
     or octet_length(p_access_token_hash) <> 32
     or p_merchant_code is null
     or length(btrim(p_merchant_code)) not between 1 and 40 then
    raise exception using errcode = '22023', message = 'Invalid checkout request';
  end if;

  select orders.* into v_order
  from public.orders as orders
  where orders.id = p_order_id
  for update;
  if not found or v_order.checkout_access_token_hash is distinct from p_access_token_hash then
    raise exception using errcode = 'P0002', message = 'Checkout order is unavailable';
  end if;

  select sessions.* into v_session
  from public.sumup_checkout_sessions as sessions
  where sessions.order_id = p_order_id
  for update;

  if not found then
    if v_order.payment_status <> 'unverified'
       or v_order.checkout_reservation_expires_at is null
       or v_order.checkout_reservation_expires_at <= clock_timestamp()
       or v_order.total_minor is null
       or v_order.currency <> 'GBP' then
      raise exception using errcode = 'P0001', message = 'Checkout is no longer available';
    end if;

    insert into public.sumup_checkout_sessions (
      order_id, checkout_reference, merchant_code, payment_state, creation_lease_until
    )
    values (
      p_order_id, p_order_id::text, btrim(p_merchant_code), 'creating', clock_timestamp() + interval '2 minutes'
    )
    returning * into v_session;
    v_claimed := true;

    update public.orders
    set payment_status = 'pending',
        payment_provider = 'sumup'
    where id = p_order_id;
  elsif v_session.merchant_code <> btrim(p_merchant_code) then
    raise exception using errcode = 'P0001', message = 'Checkout merchant configuration does not match';
  elsif v_session.payment_state = 'creating'
        and v_session.creation_lease_until <= clock_timestamp() then
    update public.sumup_checkout_sessions
    set creation_lease_until = clock_timestamp() + interval '2 minutes',
        updated_at = clock_timestamp()
    where order_id = p_order_id
    returning * into v_session;
    v_claimed := true;
  end if;

  return jsonb_build_object(
    'orderId', v_order.id,
    'checkoutReference', v_session.checkout_reference,
    'checkoutId', v_session.checkout_id,
    'hostedCheckoutUrl', v_session.hosted_checkout_url,
    'state', v_session.payment_state,
    'claimed', v_claimed,
    'amountMinor', v_order.total_minor,
    'currency', v_order.currency,
    'validUntil', v_order.checkout_reservation_expires_at
  );
end;
$function$;

revoke all on function public.claim_sumup_checkout(uuid, bytea, text) from public, anon, authenticated;
grant execute on function public.claim_sumup_checkout(uuid, bytea, text) to service_role;

create or replace function public.save_sumup_checkout(
  p_order_id uuid,
  p_checkout_id text,
  p_hosted_checkout_url text,
  p_merchant_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public.orders%rowtype;
  v_session public.sumup_checkout_sessions%rowtype;
begin
  select orders.* into v_order
  from public.orders as orders
  where orders.id = p_order_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Checkout order is unavailable';
  end if;

  select sessions.* into v_session
  from public.sumup_checkout_sessions as sessions
  where sessions.order_id = p_order_id
  for update;
  if not found or v_session.merchant_code <> p_merchant_code then
    raise exception using errcode = 'P0001', message = 'Checkout session is unavailable';
  end if;

  if p_checkout_id is null or length(p_checkout_id) not between 1 and 100
     or p_hosted_checkout_url is null
     or p_hosted_checkout_url !~ '^https://checkout[.]sumup[.]com/pay/[A-Za-z0-9-]+$' then
    raise exception using errcode = '22023', message = 'Invalid provider checkout details';
  end if;

  if v_session.checkout_id is not null then
    if v_session.checkout_id = p_checkout_id
       and v_session.hosted_checkout_url = p_hosted_checkout_url then
      return true;
    end if;
    raise exception using errcode = 'P0001', message = 'Provider checkout cannot be replaced';
  end if;

  if v_session.payment_state <> 'creating'
     or v_order.payment_status <> 'pending' then
    raise exception using errcode = 'P0001', message = 'Checkout reservation is no longer active';
  end if;

  update public.sumup_checkout_sessions
  set checkout_id = p_checkout_id,
      hosted_checkout_url = p_hosted_checkout_url,
      payment_state = 'pending',
      creation_lease_until = null,
      updated_at = clock_timestamp()
  where order_id = p_order_id;

  return true;
end;
$function$;

revoke all on function public.save_sumup_checkout(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.save_sumup_checkout(uuid, text, text, text)
  to service_role;

create or replace function public.get_sumup_checkout_for_verification(
  p_order_id uuid,
  p_access_token_hash bytea
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public.orders%rowtype;
  v_session public.sumup_checkout_sessions%rowtype;
begin
  select orders.* into v_order
  from public.orders as orders
  where orders.id = p_order_id;
  if not found or p_access_token_hash is null
     or octet_length(p_access_token_hash) <> 32
     or v_order.checkout_access_token_hash is distinct from p_access_token_hash then
    raise exception using errcode = 'P0002', message = 'Checkout order is unavailable';
  end if;

  select sessions.* into v_session
  from public.sumup_checkout_sessions as sessions
  where sessions.order_id = p_order_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Payment checkout is unavailable';
  end if;

  return jsonb_build_object(
    'orderId', v_order.id,
    'checkoutReference', v_session.checkout_reference,
    'checkoutId', v_session.checkout_id,
    'hostedCheckoutUrl', v_session.hosted_checkout_url,
    'state', v_session.payment_state,
    'merchantCode', v_session.merchant_code,
    'amountMinor', v_order.total_minor,
    'currency', v_order.currency,
    'validUntil', v_order.checkout_reservation_expires_at
  );
end;
$function$;

revoke all on function public.get_sumup_checkout_for_verification(uuid, bytea)
  from public, anon, authenticated;
grant execute on function public.get_sumup_checkout_for_verification(uuid, bytea)
  to service_role;

create or replace function public.release_checkout_order_inventory(p_order_id uuid)
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
  for v_reservation in
    select reservations.product_id, reservations.quantity
    from public.order_inventory_reservations as reservations
    where reservations.order_id = p_order_id
      and reservations.status = 'reserved'
    order by reservations.product_id
    for update of reservations
  loop
    update public.products as products
    set stock_quantity = products.stock_quantity + v_reservation.quantity
    where products.id = v_reservation.product_id
      and products.stock_quantity is not null
      and products.stock_quantity <= 2147483647 - v_reservation.quantity;

    get diagnostics v_updated_rows = row_count;
    if v_updated_rows = 0 then
      select products.stock_quantity into v_stock_quantity
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
    where reservations.order_id = p_order_id
      and reservations.product_id = v_reservation.product_id
      and reservations.status = 'reserved';
    get diagnostics v_updated_rows = row_count;
    v_released_count := v_released_count + v_updated_rows;
  end loop;

  return v_released_count;
end;
$function$;

revoke all on function public.release_checkout_order_inventory(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.record_sumup_checkout_verification(
  p_order_id uuid,
  p_checkout_id text,
  p_checkout_reference text,
  p_merchant_code text,
  p_checkout_status text,
  p_transaction_status text,
  p_amount_minor bigint,
  p_currency text,
  p_transaction_reference text
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public.orders%rowtype;
  v_session public.sumup_checkout_sessions%rowtype;
  v_state text;
begin
  select orders.* into v_order
  from public.orders as orders
  where orders.id = p_order_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Checkout order is unavailable';
  end if;

  select sessions.* into v_session
  from public.sumup_checkout_sessions as sessions
  where sessions.order_id = p_order_id
  for update;
  if not found
     or v_session.checkout_id is distinct from p_checkout_id
     or v_session.checkout_reference is distinct from p_checkout_reference
     or v_session.merchant_code is distinct from p_merchant_code
     or v_order.total_minor is distinct from p_amount_minor
     or v_order.currency is distinct from p_currency then
    raise exception using errcode = 'P0001', message = 'Verified payment does not match the order';
  end if;

  if v_session.payment_state = 'paid' then
    return 'paid';
  end if;

  if v_session.payment_state in ('failed', 'cancelled', 'expired') then
    raise exception using errcode = 'P0001', message = 'Payment checkout is already terminal';
  end if;

  if p_checkout_status = 'PAID' then
    if p_transaction_status <> 'SUCCESSFUL'
       or p_transaction_reference is null
       or length(p_transaction_reference) not between 1 and 100 then
      raise exception using errcode = 'P0001', message = 'Successful transaction details are unavailable';
    end if;
    if exists (
      select 1
      from public.order_inventory_reservations as reservations
      where reservations.order_id = p_order_id
        and reservations.status <> 'reserved'
    ) then
      raise exception using errcode = 'P0001', message = 'Inventory reservation is no longer active';
    end if;
    update public.order_inventory_reservations as reservations
    set status = 'consumed',
        consumed_at = clock_timestamp()
    where reservations.order_id = p_order_id
      and reservations.status = 'reserved';
    v_state := 'paid';
  elsif p_checkout_status = 'EXPIRED' then
    v_state := 'expired';
  elsif p_checkout_status in ('PENDING', 'FAILED')
        and (
          p_transaction_status is null
          or p_transaction_status in ('PENDING', 'FAILED', 'CANCELLED')
        ) then
    v_state := 'pending';
  else
    raise exception using errcode = 'P0001', message = 'Provider payment status is not supported';
  end if;

  update public.sumup_checkout_sessions
  set payment_state = v_state,
      last_verified_at = clock_timestamp(),
      transaction_reference = case when v_state = 'paid' then p_transaction_reference else transaction_reference end,
      updated_at = clock_timestamp()
  where order_id = p_order_id;

  update public.orders
  set payment_status = v_state,
      payment_provider = 'sumup',
      payment_reference = case when v_state = 'paid' then p_transaction_reference else null end
  where id = p_order_id;

  if v_state in ('failed', 'cancelled', 'expired') then
    perform public.release_checkout_order_inventory(p_order_id);
  end if;

  return v_state;
end;
$function$;

revoke all on function public.record_sumup_checkout_verification(uuid, text, text, text, text, text, bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.record_sumup_checkout_verification(uuid, text, text, text, text, text, bigint, text, text)
  to service_role;

create or replace function public.expire_uncreated_sumup_checkout(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public.orders%rowtype;
  v_session public.sumup_checkout_sessions%rowtype;
begin
  select orders.* into v_order
  from public.orders as orders
  where orders.id = p_order_id
  for update;
  if not found then
    return false;
  end if;

  select sessions.* into v_session
  from public.sumup_checkout_sessions as sessions
  where sessions.order_id = p_order_id
  for update;
  if not found
     or v_session.payment_state <> 'creating'
     or v_session.creation_lease_until > clock_timestamp()
     or v_order.checkout_reservation_expires_at > clock_timestamp() then
    return false;
  end if;

  update public.sumup_checkout_sessions
  set payment_state = 'expired',
      creation_lease_until = null,
      last_verified_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where order_id = p_order_id;
  update public.orders
  set payment_status = 'expired',
      payment_provider = 'sumup'
  where id = p_order_id;
  perform public.release_checkout_order_inventory(p_order_id);
  return true;
end;
$function$;

revoke all on function public.expire_uncreated_sumup_checkout(uuid)
  from public, anon, authenticated;
grant execute on function public.expire_uncreated_sumup_checkout(uuid)
  to service_role;

create or replace function public.get_due_sumup_checkouts(p_batch_size integer default 50)
returns setof jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_batch_size is null or p_batch_size not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Invalid reconciliation batch size';
  end if;

  return query
  select jsonb_build_object(
    'orderId', orders.id,
    'checkoutReference', sessions.checkout_reference,
    'checkoutId', sessions.checkout_id,
    'state', sessions.payment_state,
    'merchantCode', sessions.merchant_code,
    'amountMinor', orders.total_minor,
    'currency', orders.currency,
    'validUntil', orders.checkout_reservation_expires_at
  )
  from public.sumup_checkout_sessions as sessions
  join public.orders as orders on orders.id = sessions.order_id
  where orders.checkout_reservation_expires_at <= clock_timestamp()
    and (
      sessions.payment_state = 'pending'
      or (
        sessions.payment_state = 'creating'
        and sessions.creation_lease_until <= clock_timestamp()
      )
    )
  order by orders.checkout_reservation_expires_at, orders.id
  limit p_batch_size;
end;
$function$;

revoke all on function public.get_due_sumup_checkouts(integer)
  from public, anon, authenticated;
grant execute on function public.get_due_sumup_checkouts(integer)
  to service_role;

create or replace function public.release_expired_checkout_reservations(p_batch_size integer default 100)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order_id uuid;
  v_order public.orders%rowtype;
  v_released_count integer := 0;
begin
  if p_batch_size is null or p_batch_size not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Invalid reservation release batch size';
  end if;

  for v_order_id in
    select orders.id
    from public.orders as orders
    where orders.checkout_reservation_expires_at <= clock_timestamp()
      and orders.payment_status in ('unverified', 'failed', 'cancelled', 'expired')
      and exists (
        select 1
        from public.order_inventory_reservations as reservations
        where reservations.order_id = orders.id
          and reservations.status = 'reserved'
          and reservations.expires_at <= clock_timestamp()
      )
      and not exists (
        select 1
        from public.sumup_checkout_sessions as sessions
        where sessions.order_id = orders.id
          and sessions.payment_state in ('creating', 'pending')
      )
    order by orders.checkout_reservation_expires_at, orders.id
    limit p_batch_size
  loop
    select orders.* into v_order
    from public.orders as orders
    where orders.id = v_order_id
    for update;
    if not found
       or v_order.payment_status not in ('unverified', 'failed', 'cancelled', 'expired')
       or exists (
         select 1
         from public.sumup_checkout_sessions as sessions
         where sessions.order_id = v_order_id
           and sessions.payment_state in ('creating', 'pending')
       ) then
      continue;
    end if;

    v_released_count := v_released_count + public.release_checkout_order_inventory(v_order_id);
  end loop;

  return v_released_count;
end;
$function$;

revoke all on function public.release_expired_checkout_reservations(integer)
  from public, anon, authenticated;
grant execute on function public.release_expired_checkout_reservations(integer)
  to service_role;
