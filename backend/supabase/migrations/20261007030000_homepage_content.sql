create table if not exists public.storefront_content (
  content_key text primary key check (content_key = 'homepage'),
  draft_content jsonb not null,
  published_content jsonb not null,
  updated_at timestamptz not null default now(),
  published_at timestamptz
);

alter table public.storefront_content enable row level security;
revoke all on public.storefront_content from public, anon, authenticated;

insert into public.storefront_content
  (content_key, draft_content, published_content)
values
  (
    'homepage',
    '{
      "announcement":{"enabled":false,"text":""},
      "slides":[
        {"id":"hero-1","enabled":true,"image":"images/hero/skincare-product-hero-image1.jpeg","theme":"sage","eyebrow":"","heading":"","description":"","ctaText":"Shop Now","ctaLink":"shop.html","secondaryCtaText":"Explore Collection","secondaryCtaLink":"shop.html","align":"left"},
        {"id":"hero-2","enabled":true,"image":"images/hero/skincare-product-hero-image2.jpeg","theme":"rose","eyebrow":"","heading":"","description":"","ctaText":"Shop Skincare","ctaLink":"shop.html","secondaryCtaText":"","secondaryCtaLink":"","align":"left"},
        {"id":"hero-3","enabled":true,"image":"images/hero/skincare-product-hero-image3.jpeg","theme":"blush","eyebrow":"","heading":"","description":"","ctaText":"Shop New Arrivals","ctaLink":"shop.html","secondaryCtaText":"","secondaryCtaLink":"","align":"right"},
        {"id":"hero-4","enabled":true,"image":"images/hero/skincare-product-hero-image4.jpeg","theme":"sage","eyebrow":"","heading":"","description":"","ctaText":"Shop New Arrivals","ctaLink":"shop.html","secondaryCtaText":"","secondaryCtaLink":"","align":"right"},
        {"id":"hero-5","enabled":true,"image":"images/hero/skincare-product-hero-image5.jpeg","theme":"rose","eyebrow":"","heading":"","description":"","ctaText":"Shop New Arrivals","ctaLink":"shop.html","secondaryCtaText":"","secondaryCtaLink":"","align":"right"}
      ],
      "featuredProductIds":["sp-001","sp-003","sp-005","sp-007"],
      "promotions":[]
    }'::jsonb,
    '{
      "announcement":{"enabled":false,"text":""},
      "slides":[
        {"id":"hero-1","enabled":true,"image":"images/hero/skincare-product-hero-image1.jpeg","theme":"sage","eyebrow":"","heading":"","description":"","ctaText":"Shop Now","ctaLink":"shop.html","secondaryCtaText":"Explore Collection","secondaryCtaLink":"shop.html","align":"left"},
        {"id":"hero-2","enabled":true,"image":"images/hero/skincare-product-hero-image2.jpeg","theme":"rose","eyebrow":"","heading":"","description":"","ctaText":"Shop Skincare","ctaLink":"shop.html","secondaryCtaText":"","secondaryCtaLink":"","align":"left"},
        {"id":"hero-3","enabled":true,"image":"images/hero/skincare-product-hero-image3.jpeg","theme":"blush","eyebrow":"","heading":"","description":"","ctaText":"Shop New Arrivals","ctaLink":"shop.html","secondaryCtaText":"","secondaryCtaLink":"","align":"right"},
        {"id":"hero-4","enabled":true,"image":"images/hero/skincare-product-hero-image4.jpeg","theme":"sage","eyebrow":"","heading":"","description":"","ctaText":"Shop New Arrivals","ctaLink":"shop.html","secondaryCtaText":"","secondaryCtaLink":"","align":"right"},
        {"id":"hero-5","enabled":true,"image":"images/hero/skincare-product-hero-image5.jpeg","theme":"rose","eyebrow":"","heading":"","description":"","ctaText":"Shop New Arrivals","ctaLink":"shop.html","secondaryCtaText":"","secondaryCtaLink":"","align":"right"}
      ],
      "featuredProductIds":["sp-001","sp-003","sp-005","sp-007"],
      "promotions":[]
    }'::jsonb
  )
on conflict (content_key) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'homepage-images',
  'homepage-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public homepage images are readable" on storage.objects;
create policy "Public homepage images are readable"
on storage.objects for select
to anon, authenticated
using (bucket_id = 'homepage-images');

drop policy if exists "Admins upload homepage images" on storage.objects;
create policy "Admins upload homepage images"
on storage.objects for insert
to authenticated
with check (bucket_id = 'homepage-images' and public.is_beautypluz_admin());

drop policy if exists "Admins update homepage images" on storage.objects;
create policy "Admins update homepage images"
on storage.objects for update
to authenticated
using (bucket_id = 'homepage-images' and public.is_beautypluz_admin())
with check (bucket_id = 'homepage-images' and public.is_beautypluz_admin());

drop policy if exists "Admins delete homepage images" on storage.objects;
create policy "Admins delete homepage images"
on storage.objects for delete
to authenticated
using (bucket_id = 'homepage-images' and public.is_beautypluz_admin());

create or replace function public.get_published_homepage_content()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select published_content
  from public.storefront_content
  where content_key = 'homepage';
$function$;

revoke all on function public.get_published_homepage_content() from public;
grant execute on function public.get_published_homepage_content() to anon, authenticated;

create or replace function public.get_admin_homepage_content()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  content jsonb;
begin
  perform public.require_beautypluz_admin();
  select jsonb_build_object(
    'draft', draft_content,
    'published', published_content,
    'updatedAt', updated_at,
    'publishedAt', published_at
  )
  into content
  from public.storefront_content
  where content_key = 'homepage';
  return content;
end;
$function$;

revoke all on function public.get_admin_homepage_content() from public, anon;
grant execute on function public.get_admin_homepage_content() to authenticated;

create or replace function public.is_valid_homepage_link(link text)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce(
    link ~* '^https://[^[:space:]]+$'
    or (
      link <> ''
      and link !~ '^[A-Za-z][A-Za-z0-9+.-]*:'
      and link !~ '^//'
      and link !~ '[[:space:]]'
    ),
    false
  );
$function$;

revoke all on function public.is_valid_homepage_link(text) from public, anon, authenticated;

create or replace function public.save_homepage_draft(content jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized jsonb;
  featured_ids text[];
begin
  perform public.require_beautypluz_admin();

  if jsonb_typeof(content) is distinct from 'object'
     or jsonb_typeof(content->'announcement') is distinct from 'object'
     or jsonb_typeof(content->'slides') is distinct from 'array'
     or jsonb_typeof(content->'featuredProductIds') is distinct from 'array'
     or jsonb_typeof(content->'promotions') is distinct from 'array'
     or pg_column_size(content) > 500000 then
    raise exception using errcode = '22023', message = 'Invalid homepage content shape or size';
  end if;

  if jsonb_array_length(content->'slides') > 20
     or jsonb_array_length(content->'promotions') > 10
     or jsonb_array_length(content->'featuredProductIds') > 12 then
    raise exception using errcode = '22023', message = 'Homepage content exceeds allowed item limits';
  end if;

  if jsonb_typeof(content->'announcement'->'enabled') is distinct from 'boolean'
     or jsonb_typeof(content->'announcement'->'text') is distinct from 'string'
     or length(content->'announcement'->>'text') > 180 then
    raise exception using errcode = '22023', message = 'Invalid announcement bar content';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(content->'slides') as item(slide)
    where jsonb_typeof(item.slide) is distinct from 'object'
       or jsonb_typeof(item.slide->'id') is distinct from 'string'
       or nullif(trim(item.slide->>'id'), '') is null
       or jsonb_typeof(item.slide->'enabled') is distinct from 'boolean'
       or jsonb_typeof(item.slide->'image') is distinct from 'string'
       or length(item.slide->>'image') > 2000
       or length(item.slide->>'eyebrow') > 80
       or length(item.slide->>'heading') > 120
       or length(item.slide->>'description') > 500
       or length(item.slide->>'ctaText') > 40
       or length(item.slide->>'ctaLink') > 500
       or length(item.slide->>'secondaryCtaText') > 40
       or length(item.slide->>'secondaryCtaLink') > 500
       or coalesce(item.slide->>'theme', 'sage') not in ('sage', 'rose', 'blush')
       or coalesce(item.slide->>'align', 'left') not in ('left', 'right')
  ) then
    raise exception using errcode = '22023', message = 'Invalid hero slide content';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(content->'slides') as item(slide)
    group by item.slide->>'id'
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Hero slide IDs must be unique';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(content->'promotions') as item(promotion)
    where jsonb_typeof(item.promotion) is distinct from 'object'
       or jsonb_typeof(item.promotion->'id') is distinct from 'string'
       or nullif(trim(item.promotion->>'id'), '') is null
       or jsonb_typeof(item.promotion->'enabled') is distinct from 'boolean'
       or length(item.promotion->>'image') > 2000
       or length(item.promotion->>'eyebrow') > 80
       or length(item.promotion->>'heading') > 120
       or length(item.promotion->>'description') > 500
       or length(item.promotion->>'code') > 40
       or length(item.promotion->>'ctaText') > 40
       or length(item.promotion->>'ctaLink') > 500
  ) then
    raise exception using errcode = '22023', message = 'Invalid promotional banner content';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(content->'promotions') as item(promotion)
    group by item.promotion->>'id'
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Promotional banner IDs must be unique';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(content->'slides') as item(slide)
    where coalesce((item.slide->>'enabled')::boolean, false)
      and length(trim(coalesce(item.slide->>'image', ''))) > 0
  ) then
    raise exception using errcode = '22023', message = 'At least one enabled hero slide with an image is required';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(content->'slides') as item(slide)
    where nullif(trim(coalesce(item.slide->>'ctaText', '')), '') is not null
      and not public.is_valid_homepage_link(item.slide->>'ctaLink')
  ) or exists (
    select 1
    from jsonb_array_elements(content->'slides') as item(slide)
    where nullif(trim(coalesce(item.slide->>'secondaryCtaText', '')), '') is not null
      and not public.is_valid_homepage_link(item.slide->>'secondaryCtaLink')
  ) or exists (
    select 1
    from jsonb_array_elements(content->'promotions') as item(promotion)
    where nullif(trim(coalesce(item.promotion->>'ctaText', '')), '') is not null
      and not public.is_valid_homepage_link(item.promotion->>'ctaLink')
  ) then
    raise exception using errcode = '22023', message = 'Homepage CTA links must be valid https links or same-site paths';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(content->'featuredProductIds') as item(value)
    where jsonb_typeof(item.value) is distinct from 'string'
       or trim(item.value #>> '{}') = ''
  ) then
    raise exception using errcode = '22023', message = 'Featured product IDs must be non-empty strings';
  end if;

  select array_agg(value #>> '{}')
  into featured_ids
  from jsonb_array_elements(content->'featuredProductIds') as item(value);

  if coalesce(array_length(featured_ids, 1), 0) <> (
    select count(distinct value #>> '{}')
    from jsonb_array_elements(content->'featuredProductIds') as item(value)
  ) then
    raise exception using errcode = '22023', message = 'Featured products cannot contain duplicates';
  end if;

  if exists (
    select 1
    from unnest(coalesce(featured_ids, array[]::text[])) as ids(id)
    where not exists (
      select 1 from public.products as product
      where product.id = ids.id and product.is_published
    )
  ) then
    raise exception using errcode = '22023', message = 'Featured products must refer to published products';
  end if;

  normalized := content;
  update public.storefront_content
  set draft_content = normalized,
      updated_at = now()
  where content_key = 'homepage';

  return normalized;
end;
$function$;

revoke all on function public.save_homepage_draft(jsonb) from public, anon;
grant execute on function public.save_homepage_draft(jsonb) to authenticated;

create or replace function public.publish_homepage_draft()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  content jsonb;
begin
  perform public.require_beautypluz_admin();
  select draft_content into content
  from public.storefront_content
  where content_key = 'homepage'
  for update;

  if content is null then
    raise exception using errcode = 'P0002', message = 'Homepage content is not initialized';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(content->'slides') as item(slide)
    where coalesce((item.slide->>'enabled')::boolean, false)
      and length(trim(coalesce(item.slide->>'image', ''))) > 0
  ) then
    raise exception using errcode = '22023', message = 'At least one enabled hero slide with an image is required';
  end if;

  update public.storefront_content
  set published_content = content,
      published_at = now(),
      updated_at = now()
  where content_key = 'homepage';

  return content;
end;
$function$;

revoke all on function public.publish_homepage_draft() from public, anon;
grant execute on function public.publish_homepage_draft() to authenticated;

create or replace function public.homepage_image_is_in_use(target_image_url text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform public.require_beautypluz_admin();
  return exists (
    select 1
    from public.storefront_content as content
    cross join lateral jsonb_array_elements(content.draft_content->'slides') as drafts(slide)
    where drafts.slide->>'image' = target_image_url
  ) or exists (
    select 1
    from public.storefront_content as content
    cross join lateral jsonb_array_elements(content.published_content->'slides') as published(slide)
    where published.slide->>'image' = target_image_url
  ) or exists (
    select 1
    from public.storefront_content as content
    cross join lateral jsonb_array_elements(content.draft_content->'promotions') as drafts(promotion)
    where drafts.promotion->>'image' = target_image_url
  ) or exists (
    select 1
    from public.storefront_content as content
    cross join lateral jsonb_array_elements(content.published_content->'promotions') as published(promotion)
    where published.promotion->>'image' = target_image_url
  );
end;
$function$;

revoke all on function public.homepage_image_is_in_use(text) from public, anon;
grant execute on function public.homepage_image_is_in_use(text) to authenticated;
