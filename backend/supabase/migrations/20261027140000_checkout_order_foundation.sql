create table if not exists public.checkout_settings (
  id boolean primary key default true check (id),
  delivery_amount_pence bigint not null
    check (delivery_amount_pence between 0 and 9999999999)
);

alter table public.checkout_settings enable row level security;
revoke all on public.checkout_settings from public, anon, authenticated, service_role;

alter table public.orders
  add column if not exists checkout_idempotency_key uuid unique;

create table if not exists public.order_inventory_reservations (
  order_id uuid not null references public.orders (id) on delete restrict,
  product_id text not null references public.products (id) on delete restrict,
  quantity integer not null check (quantity > 0),
  primary key (order_id, product_id),
  status text not null default 'reserved'
    check (status in ('reserved', 'consumed', 'released')),
  created_at timestamptz not null default now(),
  released_at timestamptz,
  consumed_at timestamptz,
  constraint order_inventory_reservation_status_timestamps_check check (
    (status = 'reserved' and released_at is null and consumed_at is null)
    or (status = 'released' and released_at is not null and consumed_at is null)
    or (status = 'consumed' and released_at is null and consumed_at is not null)
  )
);

create index if not exists order_inventory_reservations_product_idx
  on public.order_inventory_reservations (product_id);

alter table public.order_inventory_reservations enable row level security;
revoke all on public.order_inventory_reservations from public, anon, authenticated, service_role;

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
  v_delivery_pence bigint;
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
begin
  if p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'A checkout request key is required';
  end if;

  select orders.id
  into v_order_id
  from public.orders as orders
  where orders.checkout_idempotency_key = p_idempotency_key;

  if found then
    return v_order_id;
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

  perform product.id
  from public.products as product
  join jsonb_array_elements(p_items) as request_item(value)
    on product.id = request_item.value->>'id'
  order by product.id
  for update of product;

  select orders.id
  into v_order_id
  from public.orders as orders
  where orders.checkout_idempotency_key = p_idempotency_key;

  if found then
    return v_order_id;
  end if;

  select settings.delivery_amount_pence
  into v_delivery_pence
  from public.checkout_settings as settings
  where settings.id;

  if not found then
    raise exception using errcode = '55000', message = 'Checkout delivery pricing is not configured';
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

  begin
    insert into public.orders (
      checkout_idempotency_key,
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
    select orders.id
    into v_order_id
    from public.orders as orders
    where orders.checkout_idempotency_key = p_idempotency_key;

    if found then
      return v_order_id;
    end if;
    raise;
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
        quantity
      )
      values (
        v_order_id,
        v_product.id,
        v_quantity
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
