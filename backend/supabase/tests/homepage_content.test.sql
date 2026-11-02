begin;

insert into auth.users
  (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000311', 'authenticated', 'authenticated', 'homepage-admin-test@example.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000312', 'authenticated', 'authenticated', 'homepage-customer-test@example.invalid', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now())
on conflict (id) do nothing;

insert into public.beautypluz_admins (user_id)
values ('00000000-0000-0000-0000-000000000311')
on conflict (user_id) do nothing;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000311', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select public.save_homepage_draft(
  '{
    "announcement":{"enabled":true,"text":"Test announcement"},
    "slides":[
      {"id":"test-slide","enabled":true,"image":"images/hero/skincare-product-hero-image1.jpeg","theme":"sage","eyebrow":"Test","heading":"Draft hero","description":"Draft description","ctaText":"Shop now","ctaLink":"shop.html","secondaryCtaText":"","secondaryCtaLink":"","align":"left"}
    ],
    "featuredProductIds":[],
    "promotions":[
      {"id":"test-banner","enabled":true,"image":"","eyebrow":"Test","heading":"Draft offer","description":"Draft promotion","code":"","ctaText":"Shop","ctaLink":"shop.html"}
    ]
  }'::jsonb
);

reset role;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'anon', true);

do $test$
begin
  if public.get_published_homepage_content()->'slides'->0->>'heading' = 'Draft hero' then
    raise exception 'Unpublished homepage draft leaked to storefront visitors';
  end if;
end;
$test$;

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000312', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $test$
declare
  denied boolean;
begin
  denied := false;
  begin
    perform public.get_admin_homepage_content();
  exception
    when insufficient_privilege then
      denied := true;
  end;
  if not denied then
    raise exception 'Ordinary customer read private homepage content';
  end if;

  denied := false;
  begin
    perform public.publish_homepage_draft();
  exception
    when insufficient_privilege then
      denied := true;
  end;
  if not denied then
    raise exception 'Ordinary customer published homepage content';
  end if;

  denied := false;
  begin
    perform public.homepage_image_is_in_use('https://example.invalid/private-image');
  exception
    when insufficient_privilege then
      denied := true;
  end;
  if not denied then
    raise exception 'Ordinary customer inspected private homepage image references';
  end if;
end;
$test$;

do $test$
begin
  begin
    perform public.save_homepage_draft('{"announcement":{},"slides":[],"featuredProductIds":[],"promotions":[]}'::jsonb);
  exception
    when insufficient_privilege then
      return;
  end;

  raise exception 'Ordinary customer changed homepage draft';
end;
$test$;

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000311', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $test$
begin
  begin
    perform public.save_homepage_draft(
      '{
        "announcement":{"enabled":false,"text":""},
        "slides":[{"id":"bad-slide","enabled":true,"image":"images/hero/skincare-product-hero-image1.jpeg","ctaText":"Unsafe link","ctaLink":"javascript:alert(1)"}],
        "featuredProductIds":[],
        "promotions":[]
      }'::jsonb
    );
  exception
    when invalid_parameter_value then
      return;
  end;

  raise exception 'Unsafe homepage CTA link was accepted';
end;
$test$;

select public.publish_homepage_draft();

reset role;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'anon', true);

do $test$
begin
  if public.get_published_homepage_content()->'slides'->0->>'heading' <> 'Draft hero' then
    raise exception 'Published homepage content did not reach storefront readers';
  end if;
  if public.get_published_homepage_content()->'announcement'->>'text' <> 'Test announcement' then
    raise exception 'Published announcement did not reach storefront readers';
  end if;
end;
$test$;

rollback;
