begin;

insert into auth.users
  (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000111', 'authenticated', 'authenticated', 'admin-crud-test@example.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000112', 'authenticated', 'authenticated', 'customer-crud-test@example.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now())
on conflict (id) do nothing;

insert into public.beautypluz_admins (user_id)
values ('00000000-0000-0000-0000-000000000111')
on conflict (user_id) do nothing;

set local role authenticated;

select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000111',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

insert into public.products
  (id, name, category, price, description, stock_quantity, is_featured)
values
  ('bp-crud-test', 'CRUD integration product', 'testing', 12.50, 'Before update', 5, false);

do $test$
begin
  if not exists (select 1 from public.products where id = 'bp-crud-test') then
    raise exception 'Admin create/read workflow failed';
  end if;
end;
$test$;

update public.products
set name = 'CRUD integration product updated',
    price = 10.00,
    sale_price = 8.50,
    description = 'After update',
    stock_quantity = 7,
    is_featured = true
where id = 'bp-crud-test';

do $test$
begin
  if not exists (
    select 1 from public.products
    where id = 'bp-crud-test'
      and name = 'CRUD integration product updated'
      and price = 10.00
      and sale_price = 8.50
      and stock_quantity = 7
      and is_featured
  ) then
    raise exception 'Admin update workflow failed';
  end if;
end;
$test$;

do $test$
begin
  begin
    insert into public.products (id, name, price)
    values ('bp-crud-duplicate', ' crud integration PRODUCT updated ', 3.00);
  exception
    when unique_violation then
      return;
  end;

  raise exception 'Case-insensitive duplicate product name was accepted';
end;
$test$;

reset role;
insert into public.orders (id) values ('00000000-0000-0000-0000-000000000211');
insert into public.order_items
  (order_id, product_id, product_name, unit_price, image_url, quantity)
values
  ('00000000-0000-0000-0000-000000000211', 'bp-crud-test', 'Historical product snapshot', 12.50, 'https://test.invalid/product-images/order-snapshot.webp', 2);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000112',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $test$
begin
  begin
    insert into public.products (id, name, price)
    values ('bp-customer-forbidden', 'Customer must not create product', 2.00);
  exception
    when insufficient_privilege then
      return;
  end;

  raise exception 'Ordinary customer created an administrative product';
end;
$test$;

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000111',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

delete from public.products where id = 'bp-crud-test';

reset role;

do $test$
begin
  if exists (select 1 from public.products where id = 'bp-crud-test') then
    raise exception 'Admin delete workflow failed';
  end if;
  if not exists (
    select 1 from public.order_items
    where order_id = '00000000-0000-0000-0000-000000000211'
      and product_id is null
      and product_name = 'Historical product snapshot'
      and unit_price = 12.50
      and image_url = 'https://test.invalid/product-images/order-snapshot.webp'
  ) then
    raise exception 'Deleting product damaged historical order data';
  end if;
  if not public.product_image_is_in_order_history(
    'https://test.invalid/product-images/order-snapshot.webp'
  ) then
    raise exception 'Historical image reference was not preserved';
  end if;
end;
$test$;

rollback;
