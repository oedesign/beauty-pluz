create table if not exists public.store_settings (
  settings_key text primary key check (settings_key = 'storefront'),
  settings jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.store_settings enable row level security;
revoke all on public.store_settings from public, anon, authenticated;

insert into public.store_settings (settings_key, settings)
values (
  'storefront',
  '{
    "storeName":"Beauty Pluz",
    "logo":"images/beautypluz-logo.webp",
    "contact":{"email":"hello@beautypluz.com","phone":"+447823894470","whatsapp":"+447823894470","businessHours":"Monday – Friday: 9am – 6pm\nSaturday: 10am – 4pm\nSunday: Closed","address":"Unit 53, 140a Queensway, Bletchley Milton Keynes, MK2 2AA"},
    "social":{"instagram":"https://instagram.com/beautypluz","facebook":"https://facebook.com/beautypluz","tiktok":""},
    "shippingInfo":"Contact us for current delivery options and time estimates. Delivery charges and availability are confirmed directly with our team.",
    "promotionalMessages":[
      {"id":"promo-free-delivery","message":"Free shipping on orders over £75","code":""},
      {"id":"promo-new-products","message":"New products available now","code":""}
    ],
    "footerDescription":"Thoughtfully chosen beauty, skincare and haircare.",
    "footerLinks":[
      {"id":"footer-contact","label":"Contact","url":"contact.html"},
      {"id":"footer-shipping","label":"Shipping information","url":"contact.html"}
    ],
    "currency":"GBP"
  }'::jsonb
)
on conflict (settings_key) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'store-assets',
  'store-assets',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public store assets are readable" on storage.objects;
create policy "Public store assets are readable"
on storage.objects for select
to anon, authenticated
using (bucket_id = 'store-assets');

drop policy if exists "Admins upload store assets" on storage.objects;
create policy "Admins upload store assets"
on storage.objects for insert
to authenticated
with check (bucket_id = 'store-assets' and public.is_beautypluz_admin());

drop policy if exists "Admins update store assets" on storage.objects;
create policy "Admins update store assets"
on storage.objects for update
to authenticated
using (bucket_id = 'store-assets' and public.is_beautypluz_admin())
with check (bucket_id = 'store-assets' and public.is_beautypluz_admin());

drop policy if exists "Admins delete store assets" on storage.objects;
create policy "Admins delete store assets"
on storage.objects for delete
to authenticated
using (bucket_id = 'store-assets' and public.is_beautypluz_admin());

create or replace function public.get_published_store_settings()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select settings
  from public.store_settings
  where settings_key = 'storefront';
$function$;

revoke all on function public.get_published_store_settings() from public;
grant execute on function public.get_published_store_settings() to anon, authenticated;

create or replace function public.get_admin_store_settings()
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
  select settings into result
  from public.store_settings
  where settings_key = 'storefront';
  return result;
end;
$function$;

revoke all on function public.get_admin_store_settings() from public, anon;
grant execute on function public.get_admin_store_settings() to authenticated;

create or replace function public.save_store_settings(settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  saved jsonb;
begin
  perform public.require_beautypluz_admin();

  if jsonb_typeof(settings) is distinct from 'object'
     or pg_column_size(settings) > 100000
     or jsonb_typeof(settings->'contact') is distinct from 'object'
     or jsonb_typeof(settings->'social') is distinct from 'object'
     or jsonb_typeof(settings->'promotionalMessages') is distinct from 'array'
     or jsonb_typeof(settings->'footerLinks') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Invalid store settings shape or size';
  end if;

  if jsonb_typeof(settings->'storeName') is distinct from 'string'
     or nullif(trim(settings->>'storeName'), '') is null
     or length(settings->>'storeName') > 100
     or jsonb_typeof(settings->'logo') is distinct from 'string'
     or length(settings->>'logo') > 2000
     or jsonb_typeof(settings->'shippingInfo') is distinct from 'string'
     or length(settings->>'shippingInfo') > 2000
     or jsonb_typeof(settings->'footerDescription') is distinct from 'string'
     or length(settings->>'footerDescription') > 500
     or settings->>'currency' is distinct from 'GBP' then
    raise exception using errcode = '22023', message = 'Invalid store identity, content, or unsupported currency';
  end if;

  if (settings->>'logo') !~* '^(images/[A-Za-z0-9._/-]+|https://[^[:space:]]+)?$' then
    raise exception using errcode = '22023', message = 'Store logo must be a site image path or secure https URL';
  end if;

  if length(settings->'contact'->>'email') > 254
     or jsonb_typeof(settings->'contact'->'email') is distinct from 'string'
     or jsonb_typeof(settings->'contact'->'phone') is distinct from 'string'
     or jsonb_typeof(settings->'contact'->'whatsapp') is distinct from 'string'
     or jsonb_typeof(settings->'contact'->'businessHours') is distinct from 'string'
     or jsonb_typeof(settings->'contact'->'address') is distinct from 'string'
     or (nullif(trim(settings->'contact'->>'email'), '') is not null
         and settings->'contact'->>'email' !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$')
     or length(settings->'contact'->>'phone') > 40
     or length(settings->'contact'->>'whatsapp') > 40
     or length(settings->'contact'->>'businessHours') > 500
     or length(settings->'contact'->>'address') > 500
     or (nullif(trim(settings->'contact'->>'phone'), '') is not null
         and settings->'contact'->>'phone' !~ '^\+?[0-9 ()-]{6,40}$')
     or (nullif(trim(settings->'contact'->>'whatsapp'), '') is not null
         and settings->'contact'->>'whatsapp' !~ '^\+?[0-9 ()-]{6,40}$') then
    raise exception using errcode = '22023', message = 'Invalid store contact information';
  end if;

  if jsonb_typeof(settings->'social'->'instagram') is distinct from 'string'
     or jsonb_typeof(settings->'social'->'facebook') is distinct from 'string'
     or jsonb_typeof(settings->'social'->'tiktok') is distinct from 'string'
     or jsonb_typeof(settings->'social'->'youtube') is distinct from 'string'
     or jsonb_typeof(settings->'social'->'x') is distinct from 'string'
     or length(settings->'social'->>'instagram') > 500
     or length(settings->'social'->>'facebook') > 500
     or length(settings->'social'->>'tiktok') > 500
     or length(settings->'social'->>'youtube') > 500
     or length(settings->'social'->>'x') > 500 then
    raise exception using errcode = '22023', message = 'Invalid social media link settings';
  end if;

  if jsonb_array_length(settings->'promotionalMessages') > 10
     or jsonb_array_length(settings->'footerLinks') > 12 then
    raise exception using errcode = '22023', message = 'Too many promotional messages or footer links';
  end if;

  if exists (
    select 1
    from jsonb_each_text(settings->'social') as social(platform, url)
    where platform not in ('instagram', 'facebook', 'tiktok', 'youtube', 'x')
       or (url <> '' and not public.is_valid_homepage_link(url))
       or (url <> '' and url !~* '^https://')
  ) then
    raise exception using errcode = '22023', message = 'Social links must be secure https URLs';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(settings->'promotionalMessages') as item(message)
    where jsonb_typeof(item.message) is distinct from 'object'
       or jsonb_typeof(item.message->'id') is distinct from 'string'
       or nullif(trim(item.message->>'id'), '') is null
       or jsonb_typeof(item.message->'message') is distinct from 'string'
       or nullif(trim(item.message->>'message'), '') is null
       or length(item.message->>'message') > 180
       or jsonb_typeof(item.message->'code') is distinct from 'string'
       or length(item.message->>'code') > 40
       or (item.message->>'code' <> '' and item.message->>'code' !~ '^[A-Za-z0-9_-]{1,40}$')
  ) then
    raise exception using errcode = '22023', message = 'Invalid promotional message or discount code';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(settings->'promotionalMessages') as item(message)
    group by item.message->>'id'
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Promotional message IDs must be unique';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(settings->'footerLinks') as item(link)
    where jsonb_typeof(item.link) is distinct from 'object'
       or jsonb_typeof(item.link->'id') is distinct from 'string'
       or nullif(trim(item.link->>'id'), '') is null
       or jsonb_typeof(item.link->'label') is distinct from 'string'
       or nullif(trim(item.link->>'label'), '') is null
       or jsonb_typeof(item.link->'url') is distinct from 'string'
       or length(item.link->>'label') > 80
       or length(item.link->>'url') > 500
       or not public.is_valid_homepage_link(item.link->>'url')
  ) then
    raise exception using errcode = '22023', message = 'Footer links must have a label and safe same-site or https URL';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(settings->'footerLinks') as item(link)
    group by item.link->>'id'
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Footer link IDs must be unique';
  end if;

  insert into public.store_settings (settings_key, settings, updated_at)
  values ('storefront', settings, now())
  on conflict (settings_key) do update
    set settings = excluded.settings,
        updated_at = excluded.updated_at
  returning store_settings.settings into saved;

  return saved;
end;
$function$;

revoke all on function public.save_store_settings(jsonb) from public, anon;
grant execute on function public.save_store_settings(jsonb) to authenticated;
