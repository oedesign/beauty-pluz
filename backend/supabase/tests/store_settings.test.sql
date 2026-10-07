begin;

insert into auth.users
  (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000511', 'authenticated', 'authenticated', 'settings-admin-test@example.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000512', 'authenticated', 'authenticated', 'settings-customer-test@example.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now())
on conflict (id) do nothing;

insert into public.beautypluz_admins (user_id)
values ('00000000-0000-0000-0000-000000000511')
on conflict (user_id) do nothing;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000511', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select public.save_store_settings(
  '{
    "storeName":"Test Beauty Store",
    "logo":"images/beautypluz-logo.webp",
    "contact":{"email":"test@example.invalid","phone":"+441234567890","whatsapp":"+441234567890","businessHours":"Weekdays 9am–5pm","address":"Test address"},
    "social":{"instagram":"https://instagram.com/test-store","facebook":"","tiktok":"","youtube":"","x":""},
    "shippingInfo":"Delivery details are informational only.",
    "promotionalMessages":[{"id":"test-message","message":"A test promotion","code":"TEST10"}],
    "footerDescription":"Test footer copy.",
    "footerLinks":[{"id":"test-link","label":"Contact","url":"contact.html"}],
    "currency":"GBP"
  }'::jsonb
);

do $test$
declare
  rejected boolean;
begin
  rejected := false;
  begin
    perform public.save_store_settings(
      '{
        "storeName":"Unsafe",
        "logo":"images/beautypluz-logo.webp",
        "contact":{"email":"","phone":"","whatsapp":"","businessHours":"","address":""},
        "social":{"instagram":"javascript:alert(1)","facebook":"","tiktok":"","youtube":"","x":""},
        "shippingInfo":"",
        "promotionalMessages":[],
        "footerDescription":"",
        "footerLinks":[],
        "currency":"GBP"
      }'::jsonb
    );
  exception
    when invalid_parameter_value then
      rejected := true;
  end;
  if not rejected then
    raise exception 'Unsafe social link was accepted';
  end if;

  rejected := false;
  begin
    perform public.save_store_settings(
      '{
        "storeName":"Unsupported currency",
        "logo":"images/beautypluz-logo.webp",
        "contact":{"email":"","phone":"","whatsapp":"","businessHours":"","address":""},
        "social":{"instagram":"","facebook":"","tiktok":"","youtube":"","x":""},
        "shippingInfo":"",
        "promotionalMessages":[],
        "footerDescription":"",
        "footerLinks":[],
        "currency":"USD"
      }'::jsonb
    );
  exception
    when invalid_parameter_value then
      rejected := true;
  end;
  if not rejected then
    raise exception 'Unsupported currency was accepted';
  end if;
end;
$test$;

reset role;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'anon', true);

do $test$
declare
  settings jsonb;
begin
  settings := public.get_published_store_settings();
  if settings->>'storeName' <> 'Test Beauty Store'
     or settings->'promotionalMessages'->0->>'code' <> 'TEST10'
     or settings->>'shippingInfo' <> 'Delivery details are informational only.'
     or settings->'contact'->>'businessHours' <> 'Weekdays 9am–5pm'
     or settings->'contact'->>'address' <> 'Test address'
     or settings->>'currency' <> 'GBP' then
    raise exception 'Published store settings are not available to storefront visitors';
  end if;
end;
$test$;

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000512', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $test$
declare
  denied boolean;
begin
  denied := false;
  begin
    perform public.get_admin_store_settings();
  exception
    when insufficient_privilege then
      denied := true;
  end;
  if not denied then
    raise exception 'Ordinary customer read administrator store settings';
  end if;

  denied := false;
  begin
    perform public.save_store_settings(
      '{
        "storeName":"Customer takeover",
        "logo":"images/beautypluz-logo.webp",
        "contact":{"email":"","phone":"","whatsapp":"","businessHours":"","address":""},
        "social":{"instagram":"","facebook":"","tiktok":"","youtube":"","x":""},
        "shippingInfo":"",
        "promotionalMessages":[],
        "footerDescription":"",
        "footerLinks":[],
        "currency":"GBP"
      }'::jsonb
    );
  exception
    when insufficient_privilege then
      denied := true;
  end;
  if not denied then
    raise exception 'Ordinary customer changed store settings';
  end if;
end;
$test$;

reset role;
set local role anon;
do $test$
begin
  begin
    perform 1 from public.store_settings;
  exception
    when insufficient_privilege then
      return;
  end;
  raise exception 'Anonymous role directly read the protected settings table';
end;
$test$;

rollback;
