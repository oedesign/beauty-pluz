begin;

insert into auth.users
  (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000411', 'authenticated', 'authenticated', 'orders-admin-test@example.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000412', 'authenticated', 'authenticated', 'orders-customer-test@example.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now())
on conflict (id) do nothing;

insert into public.beautypluz_admins (user_id)
values ('00000000-0000-0000-0000-000000000411')
on conflict (user_id) do nothing;

insert into public.products (id, name, category, price, stock_quantity)
values ('bp-order-test-product', 'Order history test product', 'testing', 9.50, 2)
on conflict (id) do nothing;

insert into public.orders
  (id, customer_name, customer_email, customer_phone, shipping_address,
   subtotal, delivery_fee, total, fulfillment_status, payment_status,
   payment_provider, payment_reference)
values
  ('00000000-0000-0000-0000-000000000421', 'Test Customer', 'customer@example.invalid',
   '+441234567890', '1 Test Street', 19.00, 2.50, 21.50, 'pending',
   'unverified', null, null);

insert into public.order_items
  (order_id, product_id, product_name, unit_price, image_url, quantity)
values
  ('00000000-0000-0000-0000-000000000421', 'bp-order-test-product',
   'Historical product name', 9.50, 'https://test.invalid/history-image.webp', 2);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000411', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $test$
declare
  listing jsonb;
  details jsonb;
begin
  listing := public.get_admin_orders('Test Customer', 'pending', 10, 0);
  if listing->>'total' <> '1'
     or listing->'orders'->0->>'customerName' <> 'Test Customer'
     or listing->'orders'->0->>'paymentStatus' <> 'unverified'
     or listing->'orders'->0->>'paymentReference' is not null then
    raise exception 'Admin order search/list failed or unverified payment data was fabricated';
  end if;

  details := public.get_admin_order_details('00000000-0000-0000-0000-000000000421');
  if details->>'shippingAddress' <> '1 Test Street'
     or details->'items'->0->>'productName' <> 'Historical product name'
     or details->'items'->0->>'unitPrice' <> '9.50'
     or details->'items'->0->>'quantity' <> '2'
     or details->'items'->0->>'lineTotal' <> '19.00'
     or details->>'total' <> '21.50' then
    raise exception 'Admin order details did not return customer or historical line snapshots';
  end if;
end;
$test$;

select public.set_order_fulfillment_status(
  '00000000-0000-0000-0000-000000000421',
  'shipped'
);

do $test$
declare
  details jsonb;
  rejected boolean := false;
begin
  details := public.get_admin_order_details('00000000-0000-0000-0000-000000000421');
  if details->>'fulfillmentStatus' <> 'shipped'
     or jsonb_array_length(details->'statusHistory') <> 1
     or details->'statusHistory'->0->>'previousStatus' <> 'pending'
     or details->'statusHistory'->0->>'nextStatus' <> 'shipped'
     or details->>'paymentStatus' <> 'unverified'
     or details->>'paymentReference' is not null then
    raise exception 'Fulfilment update or status history was not recorded';
  end if;

  begin
    perform public.set_order_fulfillment_status(
      '00000000-0000-0000-0000-000000000421',
      'paid'
    );
  exception
    when invalid_parameter_value then
      rejected := true;
  end;
  if not rejected then
    raise exception 'Invalid fulfilment status was accepted';
  end if;
end;
$test$;

select public.set_product_stock_quantity('bp-order-test-product', 1);

update public.products
set name = 'Renamed catalogue product',
    price = 4.25
where id = 'bp-order-test-product';

do $test$
begin
  if (select stock_quantity from public.products where id = 'bp-order-test-product') <> 1 then
    raise exception 'Admin inventory update failed';
  end if;
end;
$test$;

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000412', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $test$
declare
  denied boolean;
begin
  denied := false;
  begin
    perform 1 from public.orders where id = '00000000-0000-0000-0000-000000000421';
  exception
    when insufficient_privilege then
      denied := true;
  end;
  if not denied then
    raise exception 'Ordinary customer directly selected customer order records';
  end if;

  denied := false;
  begin
    perform 1 from public.order_items where order_id = '00000000-0000-0000-0000-000000000421';
  exception
    when insufficient_privilege then
      denied := true;
  end;
  if not denied then
    raise exception 'Ordinary customer directly selected order item/customer history';
  end if;

  denied := false;
  begin
    perform public.get_admin_orders(null, null, 50, 0);
  exception
    when insufficient_privilege then
      denied := true;
  end;
  if not denied then
    raise exception 'Ordinary customer accessed order search data';
  end if;

  denied := false;
  begin
    perform public.get_admin_order_details('00000000-0000-0000-0000-000000000421');
  exception
    when insufficient_privilege then
      denied := true;
  end;
  if not denied then
    raise exception 'Ordinary customer accessed order customer details';
  end if;

  denied := false;
  begin
    perform public.set_order_fulfillment_status(
      '00000000-0000-0000-0000-000000000421',
      'delivered'
    );
  exception
    when insufficient_privilege then
      denied := true;
  end;
  if not denied then
    raise exception 'Ordinary customer changed fulfilment status';
  end if;

  denied := false;
  begin
    perform public.set_product_stock_quantity('bp-order-test-product', 99);
  exception
    when insufficient_privilege then
      denied := true;
  end;
  if not denied then
    raise exception 'Ordinary customer changed inventory';
  end if;
end;
$test$;

reset role;
delete from public.products where id = 'bp-order-test-product';

do $test$
begin
  if not exists (
    select 1
    from public.order_items
    where order_id = '00000000-0000-0000-0000-000000000421'
      and product_id is null
      and product_name = 'Historical product name'
      and unit_price = 9.50
      and quantity = 2
  ) then
    raise exception 'Product deletion damaged historical order item details';
  end if;
end;
$test$;

do $test$
declare
  rejected boolean := false;
begin
  begin
    update public.orders
    set payment_status = 'paid',
        payment_provider = null,
        payment_reference = null
    where id = '00000000-0000-0000-0000-000000000421';
  exception
    when check_violation then
      rejected := true;
  end;

  if not rejected then
    raise exception 'Paid payment status was accepted without verified provider/reference data';
  end if;
end;
$test$;

rollback;
