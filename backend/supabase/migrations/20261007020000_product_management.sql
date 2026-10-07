create table if not exists public.products (
  id text primary key default ('bp-' || replace(gen_random_uuid()::text, '-', '')),
  name text not null check (length(trim(name)) between 1 and 180),
  description text not null default '',
  category text not null default 'uncategorized' check (length(trim(category)) between 1 and 80),
  price numeric(10, 2) not null check (price >= 0),
  sale_price numeric(10, 2) check (sale_price is null or (sale_price >= 0 and sale_price < price)),
  image_url text,
  badge text not null default '' check (badge in ('', 'new', 'bestseller')),
  icon text not null default 'balm',
  rating numeric(2, 1) not null default 0 check (rating between 0 and 5),
  review_count integer not null default 0 check (review_count >= 0),
  stock_quantity integer check (stock_quantity is null or stock_quantity >= 0),
  is_available boolean not null default true,
  is_published boolean not null default true,
  is_featured boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists products_name_ci_unique
  on public.products (lower(trim(name)));
create index if not exists products_storefront_order_idx
  on public.products (is_published, is_available, is_featured, created_at desc);

create or replace function public.set_product_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at
before update on public.products
for each row execute function public.set_product_updated_at();

alter table public.products enable row level security;
grant select on public.products to anon, authenticated;
grant insert, update, delete on public.products to authenticated;

drop policy if exists "Published available products are public" on public.products;
create policy "Published available products are public"
on public.products for select
to anon, authenticated
using (
  (is_published and is_available and (stock_quantity is null or stock_quantity > 0))
  or public.is_beautypluz_admin()
);

-- The public catalogue RLS policy can evaluate this safe, read-only check
-- for anon sessions; an anonymous auth.uid() can never match an admin row.
grant execute on function public.is_beautypluz_admin() to anon;

drop policy if exists "Admins insert products" on public.products;
create policy "Admins insert products"
on public.products for insert
to authenticated
with check (public.is_beautypluz_admin());

drop policy if exists "Admins update products" on public.products;
create policy "Admins update products"
on public.products for update
to authenticated
using (public.is_beautypluz_admin())
with check (public.is_beautypluz_admin());

drop policy if exists "Admins delete products" on public.products;
create policy "Admins delete products"
on public.products for delete
to authenticated
using (public.is_beautypluz_admin());

insert into public.products
  (id, name, category, price, description, image_url, badge, icon, rating, review_count, is_featured)
values
  ('sp-001', 'Virgin Hair Fertilizer Cream Enriched With Coconut Oil - 100g', 'uncategorized', 7.98, 'Nourish Your Scalp and Elevate Your Hair Care Routine Revitalize your hair care regimen with Virgin Hair Fertilizer Cream. Expertly enriched with nourishing coconut oil, this 125g conditioning treatment is designed to provide deep moisture, support scalp comfort, and keep your hair looking smooth, soft, and manageable every single day. Crafted for all hair types, it absorbs effortlessly to condition strands from root to tip. Incorporate this trusted formula into your regular routine to maintain a healthy-looking shine and silky texture effortlessly. Directions for Use Take a small amount of the hair fertilizer cream onto your fingertips.', 'images/products/Stacked Virgin Hair Fertilizer Boxes.webp', 'bestseller', 'balm', 4.8, 1240, true),
  ('sp-002', 'Blue Magic Original Super Sure Gro', 'uncategorized', 7.99, 'Made with Shea Butter, Jojoba Oil, & Japanese Green Tea leaves WITH HERBS YOU CAN ACTUALLY SEE', 'images/products/skincare-product-12.webp', 'new', 'serum', 4.9, 860, false),
  ('sp-003', 'Chambers Chapter 2000 Hair Growth and Scalp Treatment', 'uncategorized', 10.99, 'Chambers Chapter 2000 Hair Grow Scalp Treatment is a nourishing cream that promotes healthy hair growth from roots to ends. Formulated with sulphur and nourishing herbal extracts, this 295g treatment stimulates circulation in the scalp to encourage hair growth, especially around thinning edges. Gentle enough for daily use, the cream''s rich formula is rapidly absorbed to moisturize dry hair and scalp without residue. Regular application encourages stronger, thicker hair by stimulating dormant follicles. Suitable for all hair types, this herbal treatment from Ghana has helped regrow hair for millions worldwide.', 'images/products/skincare-product3.jpeg', 'bestseller', 'cream', 4.7, 1580, true),
  ('sp-004', 'Tea Tree Conditioner and shampoo', 'uncategorized', 5.99, 'Tea Tree Shampoo and Conditioner Set is specially formulated to cleanse, refresh, and nourish the hair and scalp. Infused with natural tea tree extract, this powerful duo helps remove product buildup, excess oil, and impurities while soothing dry, itchy, and flaky scalp. The shampoo deeply cleanses without stripping essential moisture, leaving your hair feeling fresh, light, and revitalized. The conditioner works to detangle, soften, and restore moisture balance, improving manageability and shine. Ideal for oily, dandruff-prone, and irritated scalps, this tea tree hair care set promotes a healthier scalp environment for stronger, smoother hair growth. Suitable for both men and women, and perfect for regular use. XBC Tea Tree Shampoo and Conditioner delivers salon-quality results at home, leaving hair clean, refreshed, and beautifully conditioned. Great for everyday scalp care and maintaining healthy, vibrant-looking hair.', 'images/products/beautypluz-product-13.webp', 'new', 'mist', 4.6, 410, false),
  ('sp-005', 'Satin Quality Unisex Hair Bonnet Large Sleep Cap Wide Elastic Band', 'uncategorized', 4.99, 'Designed for those who seek comfort and style while protecting their hair during sleep or daily activities. Made from high-quality satin, these bonnets provide a smooth, soft touch that helps to control frizz and maintain hairstyles.Features of ARHANORY Satin Hair Bonnet Comfortable Care: The satin material ensures a soft feel against your hair, preventing breakage. Frizz Control: Keeps your hairstyles intact while you sleep or go about your day. Versatile Use: Functions as a sleep cap or headband, making it suitable for various tasks', 'images/products/beautypluz-product-16.webp', 'bestseller', 'oil', 4.9, 970, true),
  ('sp-006', 'Argan Oil Cream of Nature Oil From Morroco, Style & Shine Mousse', 'uncategorized', 8.99, 'Infused with Certified Natural Argan Oil from Morocco. For Exotic Shine™ & Nourishing Moisture This styling mousse leaves wraps soft and full of body, and gives hold for twist outs. It also moisturizes dry, brittle hair while defining curls and instantly imparting Exotic Shine.  Infused with Certified Natural Argan Oil from Morocco. Formulated without adding. Formulated without adding ethanol.', 'images/products/beautypluz-product-14.webp', 'new', 'balm', 4.5, 260, false),
  ('sp-007', 'WILD GROWTH Natural Hair Growth Oil - 4 FL OZ', 'uncategorized', 15.99, 'Wild Growth Hair Oil consists of an uncompromisingly rich plant based formula that hydrates, conditions and softens for more manageable hair. Dry, tangled and hard to manage hair will become soft, healthy and less prone to split ends and hair breakage. The hair oil promotes strong, thick hair growth for all hair types. Wild Growth Hair Oil will keep your tresses healthy from root to tip by conditioning the scalp and this will lead to longer, fuller hair that grows. Turn dry, tangled and hard to manage hair into softer, healthier hair without split ends and reduced breakage.', 'images/products/beautypluz-product-17.webp', 'bestseller', 'serum', 4.8, 1120, true),
  ('sp-008', 'Anti itch Spray', 'uncategorized', 4.99, 'Nature Field Miracle Natural Oil is a multi-purpose beauty elixir formulated with a powerful blend of 12 natural oilsto deeply nourish, repair, and protect both hair and skin. Enriched with argan oil, coconut oil, jojoba oil, and castor oil, this lightweight yet deeply hydrating formula restores moisture, shine, and strength, making it perfect for dry, damaged, or frizzy hair and dull, dehydrated skin. Natural Oils Blend – A unique mix of argan, coconut, jojoba, castor, avocado, almond, and more for deep hydration and repair. Intense Hair Nourishment – Helps reduce frizz, split ends, and breakage, leaving hair silky, shiny, and healthy. Skin Hydration & Glow – Locks in moisture, soothes dryness, and promotes radiant, soft skin. Lightweight & Non-Greasy – Absorbs quickly without leaving residue. Versatile Beauty Oil – Ideal for hair, scalp, face, body, nails, and cuticles. How to Use: For Hair: Apply a few drops to damp or dry hair, focusing on ends and frizz-prone areas. For Skin: Massage onto clean skin for deep hydration and a natural glow. Nature Field 12-in-1 Miracle Natural Oil – The Power of 12 Oils in One Bottle for Complete Beauty Care!', 'images/products/beautypluz-product-15.webp', 'new', 'balm', 4.7, 340, false),
  ('sp-009', 'Ors Olive Oil Nourishing Hair Shine Sheen Spray for Dry & Dull Hair', 'uncategorized', 8.40, 'ORS Olive Oil Nourishing Sheen Spray 480ml is specially formulated to restore moisture, enhance shine, and revitalise dry, dull-looking hair without leaving a heavy or greasy residue. Infused with the nourishing benefits of olive oil, this lightweight sheen spray helps replenish moisture while leaving hair looking healthy, soft, and radiant. The fast-drying formula helps reduce dryness, tame frizz, and improve the overall appearance of the hair, making it ideal for daily use. It provides a beautiful natural-looking shine without weighing the hair down, helping to keep styles fresh and manageable throughout the day. Suitable for natural, relaxed, colour-treated, braided, and chemically treated hair, ORS Olive Oil Nourishing Sheen Spray is perfect for maintaining soft, smooth, and healthy-looking hair while protecting it from dryness and environmental stress.', 'images/products/skincare-product5.jpeg', 'new', 'spf', 4.8, 512, false),
  ('sp-010', 'Mouldin Gel Wax', 'uncategorized', 5.80, 'Moulding gel wax is a hybrid hair-styling product that combines the firm hold of a wax with the lightweight flexibility and slick finish of a gel. Enriched with tea tree oil and glycerin to moisturize and condition the scalp. With regular use, hair will maintain a naturally healthy shine.', 'images/products/Styling Gel Wax Product Jar.webp', '', 'cream', 4.6, 298, false),
  ('sp-011', 'DLWEL', 'uncategorized', 4.80, 'Dlwel Hair Bleach Developer is a professional hair care product mixed with hair dye or bleach to activate color, open the hair shaft, and provide lift. Achieve salon-quality hair color with DLWEL Developer Condition Hair, a premium developer formula designed to enhance color absorption, protect hair.', 'images/products/skincare-product8.jpeg', 'bestseller', 'cream', 4.8, 734, true),
  ('sp-012', 'Olive Moisture', 'uncategorized', 5.99, 'Tired of thinning hair, slow growth, or lacklustre locks? Discover the secret to a vibrant, fuller mane with Olive Moisture Professional Hair Growth Oil, your ultimate solution for promoting healthy, accelerated hair growth right here in the UK. This premium 200 ml (6.76 oz) leave-in hair treatment is meticulously crafted with a powerful blend of natural oils and active ingredients to deeply nourish your scalp, awaken dormant follicles, and significantly reduce hair loss and breakage. Experience the transformative power of a professional formula designed to give you visibly thicker, stronger, and healthier hair.', 'images/products/skincare-product6.jpeg', '', 'mist', 4.7, 189, false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public product images are readable" on storage.objects;
create policy "Public product images are readable"
on storage.objects for select
to anon, authenticated
using (bucket_id = 'product-images');

drop policy if exists "Admins upload product images" on storage.objects;
create policy "Admins upload product images"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'product-images'
  and public.is_beautypluz_admin()
);

drop policy if exists "Admins update product images" on storage.objects;
create policy "Admins update product images"
on storage.objects for update
to authenticated
using (bucket_id = 'product-images' and public.is_beautypluz_admin())
with check (bucket_id = 'product-images' and public.is_beautypluz_admin());

drop policy if exists "Admins delete product images" on storage.objects;
create policy "Admins delete product images"
on storage.objects for delete
to authenticated
using (bucket_id = 'product-images' and public.is_beautypluz_admin());

-- Keep order lines independent of current catalogue values. Product deletion
-- nulls only the reference; these immutable snapshots remain available.
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  product_id text references public.products (id) on delete set null,
  product_name text not null,
  unit_price numeric(10, 2) not null check (unit_price >= 0),
  image_url text,
  quantity integer not null check (quantity > 0)
);

create or replace function public.product_image_is_in_order_history(target_image_url text)
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
    from public.order_items as items
    where items.image_url = target_image_url
  );
end;
$function$;

revoke all on function public.product_image_is_in_order_history(text) from public, anon;
grant execute on function public.product_image_is_in_order_history(text) to authenticated;

alter table public.orders enable row level security;
alter table public.order_items enable row level security;
revoke all on public.orders, public.order_items from anon, authenticated;
