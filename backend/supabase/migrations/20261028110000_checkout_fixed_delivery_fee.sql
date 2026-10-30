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
  v_delivery_minor bigint := 460;
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
    'GBP',
    null,
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
  from public, anon, authenticated, service_role;
grant execute on function public.create_checkout_order(uuid, text, text, text, text, text, bytea, jsonb)
  to service_role;
