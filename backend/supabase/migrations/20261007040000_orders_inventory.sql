alter table public.orders
  add column if not exists customer_name text,
  add column if not exists customer_email text,
  add column if not exists customer_phone text,
  add column if not exists shipping_address text,
  add column if not exists subtotal numeric(10, 2),
  add column if not exists delivery_fee numeric(10, 2),
  add column if not exists total numeric(10, 2),
  add column if not exists fulfillment_status text not null default 'pending',
  add column if not exists payment_status text not null default 'unverified',
  add column if not exists payment_provider text,
  add column if not exists payment_reference text;

alter table public.orders
  drop constraint if exists orders_fulfillment_status_check,
  add constraint orders_fulfillment_status_check
    check (fulfillment_status in ('pending', 'processing', 'shipped', 'delivered', 'cancelled')),
  drop constraint if exists orders_payment_status_check,
  add constraint orders_payment_status_check
    check (payment_status in ('unverified', 'pending', 'paid', 'failed', 'refunded')),
  drop constraint if exists orders_subtotal_check,
  add constraint orders_subtotal_check check (subtotal is null or subtotal >= 0),
  drop constraint if exists orders_delivery_fee_check,
  add constraint orders_delivery_fee_check check (delivery_fee is null or delivery_fee >= 0),
  drop constraint if exists orders_total_check,
  add constraint orders_total_check check (total is null or total >= 0),
  drop constraint if exists orders_verified_payment_reference_check,
  add constraint orders_verified_payment_reference_check
    check (
      payment_status not in ('paid', 'refunded')
      or (
        nullif(trim(payment_provider), '') is not null
        and nullif(trim(payment_reference), '') is not null
      )
    );

create index if not exists orders_created_at_idx
  on public.orders (created_at desc);
create index if not exists orders_fulfillment_status_idx
  on public.orders (fulfillment_status, created_at desc);

create table if not exists public.order_status_history (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders (id) on delete cascade,
  previous_status text not null,
  next_status text not null,
  changed_by uuid references auth.users (id) on delete set null,
  changed_at timestamptz not null default now(),
  constraint order_status_history_previous_status_check
    check (previous_status in ('pending', 'processing', 'shipped', 'delivered', 'cancelled')),
  constraint order_status_history_next_status_check
    check (next_status in ('pending', 'processing', 'shipped', 'delivered', 'cancelled'))
);

create index if not exists order_status_history_order_idx
  on public.order_status_history (order_id, changed_at);

alter table public.order_status_history enable row level security;
revoke all on public.order_status_history from public, anon, authenticated;

create or replace function public.record_order_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.fulfillment_status is distinct from old.fulfillment_status then
    insert into public.order_status_history
      (order_id, previous_status, next_status, changed_by)
    values
      (new.id, old.fulfillment_status, new.fulfillment_status, auth.uid());
  end if;
  return new;
end;
$function$;

revoke all on function public.record_order_status_change() from public, anon, authenticated;

drop trigger if exists orders_record_status_change on public.orders;
create trigger orders_record_status_change
after update of fulfillment_status on public.orders
for each row execute function public.record_order_status_change();

create or replace function public.get_admin_orders(
  search_term text default null,
  status_filter text default null,
  result_limit integer default 50,
  result_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  result jsonb;
  normalized_search text := nullif(trim(search_term), '');
begin
  perform public.require_beautypluz_admin();

  if result_limit is null or result_limit < 1 or result_limit > 100
     or result_offset is null or result_offset < 0 then
    raise exception using errcode = '22023', message = 'Invalid order page size or offset';
  end if;

  if length(normalized_search) > 200 then
    raise exception using errcode = '22023', message = 'Order search text is too long';
  end if;

  if status_filter is not null
     and status_filter not in ('pending', 'processing', 'shipped', 'delivered', 'cancelled') then
    raise exception using errcode = '22023', message = 'Invalid fulfilment status filter';
  end if;

  with matched as (
    select
      orders.id,
      orders.created_at,
      orders.customer_name,
      orders.customer_email,
      orders.customer_phone,
      orders.subtotal,
      orders.delivery_fee,
      orders.total,
      orders.fulfillment_status,
      orders.payment_status,
      orders.payment_provider,
      orders.payment_reference,
      count(items.id)::integer as item_count
    from public.orders as orders
    left join public.order_items as items on items.order_id = orders.id
    where (status_filter is null or orders.fulfillment_status = status_filter)
      and (
        normalized_search is null
        or orders.id::text ilike '%' || normalized_search || '%'
        or coalesce(orders.customer_name, '') ilike '%' || normalized_search || '%'
        or coalesce(orders.customer_email, '') ilike '%' || normalized_search || '%'
        or coalesce(orders.customer_phone, '') ilike '%' || normalized_search || '%'
      )
    group by orders.id
  )
  select jsonb_build_object(
    'total', (select count(*) from matched),
    'orders', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', page.id,
          'createdAt', page.created_at,
          'customerName', page.customer_name,
          'customerEmail', page.customer_email,
          'customerPhone', page.customer_phone,
          'subtotal', page.subtotal,
          'deliveryFee', page.delivery_fee,
          'total', page.total,
          'fulfillmentStatus', page.fulfillment_status,
          'paymentStatus', page.payment_status,
          'paymentProvider', page.payment_provider,
          'paymentReference', page.payment_reference,
          'itemCount', page.item_count
        )
        order by page.created_at desc, page.id
      )
      from (
        select *
        from matched
        order by created_at desc, id
        limit result_limit offset result_offset
      ) as page
    ), '[]'::jsonb)
  )
  into result;

  return result;
end;
$function$;

revoke all on function public.get_admin_orders(text, text, integer, integer) from public, anon;
grant execute on function public.get_admin_orders(text, text, integer, integer) to authenticated;

create or replace function public.get_admin_order_details(target_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  result jsonb;
begin
  perform public.require_beautypluz_admin();

  select jsonb_build_object(
    'id', orders.id,
    'createdAt', orders.created_at,
    'customerName', orders.customer_name,
    'customerEmail', orders.customer_email,
    'customerPhone', orders.customer_phone,
    'shippingAddress', orders.shipping_address,
    'subtotal', orders.subtotal,
    'deliveryFee', orders.delivery_fee,
    'total', orders.total,
    'fulfillmentStatus', orders.fulfillment_status,
    'paymentStatus', orders.payment_status,
    'paymentProvider', orders.payment_provider,
    'paymentReference', orders.payment_reference,
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', items.id,
          'productId', items.product_id,
          'productName', items.product_name,
          'unitPrice', items.unit_price,
          'imageUrl', items.image_url,
          'quantity', items.quantity,
          'lineTotal', items.unit_price * items.quantity
        )
        order by items.id
      )
      from public.order_items as items
      where items.order_id = orders.id
    ), '[]'::jsonb),
    'statusHistory', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'previousStatus', history.previous_status,
          'nextStatus', history.next_status,
          'changedAt', history.changed_at,
          'changedBy', history.changed_by
        )
        order by history.changed_at, history.id
      )
      from public.order_status_history as history
      where history.order_id = orders.id
    ), '[]'::jsonb)
  )
  into result
  from public.orders as orders
  where orders.id = target_order_id;

  if result is null then
    raise exception using errcode = 'P0002', message = 'Order not found';
  end if;

  return result;
end;
$function$;

revoke all on function public.get_admin_order_details(uuid) from public, anon;
grant execute on function public.get_admin_order_details(uuid) to authenticated;

create or replace function public.set_order_fulfillment_status(
  target_order_id uuid,
  next_status text
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform public.require_beautypluz_admin();

  if next_status is null
     or next_status not in ('pending', 'processing', 'shipped', 'delivered', 'cancelled') then
    raise exception using errcode = '22023', message = 'Invalid fulfilment status';
  end if;

  update public.orders
  set fulfillment_status = next_status
  where id = target_order_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Order not found';
  end if;

  return next_status;
end;
$function$;

revoke all on function public.set_order_fulfillment_status(uuid, text) from public, anon;
grant execute on function public.set_order_fulfillment_status(uuid, text) to authenticated;

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
begin
  perform public.require_beautypluz_admin();

  if next_quantity is not null and next_quantity < 0 then
    raise exception using errcode = '22023', message = 'Inventory quantity cannot be negative';
  end if;

  update public.products
  set stock_quantity = next_quantity
  where id = target_product_id
  returning stock_quantity into updated_quantity;

  if not found then
    raise exception using errcode = 'P0002', message = 'Product not found';
  end if;

  return updated_quantity;
end;
$function$;

revoke all on function public.set_product_stock_quantity(text, integer) from public, anon;
grant execute on function public.set_product_stock_quantity(text, integer) to authenticated;
