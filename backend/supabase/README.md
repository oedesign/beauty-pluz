# Admin authentication setup

The storefront is a static HTML/CSS/JavaScript site, so admin authorization is enforced by Supabase rather than by trusting a browser-side flag. The public Supabase anon key is safe to use in the browser only when database grants and row-level security are configured as intended. Never put a service-role key, database password, or other privileged credential in this site.

## Provision the backend

1. Create a Supabase project and apply, in filename order, `migrations/20261007010000_admin_auth.sql`, `migrations/20261007020000_product_management.sql`, `migrations/20261007030000_homepage_content.sql`, `migrations/20261007040000_orders_inventory.sql`, and `migrations/20261007050000_store_settings.sql` using the Supabase CLI or SQL editor. The product migration creates the shared catalogue table, seeds the current 12 products without overwriting later edits, configures the persistent `product-images` bucket, and adds immutable order-line snapshot fields. The homepage migration adds draft/published content storage, guarded admin RPCs, and the persistent homepage image bucket. The order/inventory migration adds protected order-history and fulfilment RPCs, status audit records, and guarded stock updates. The store-settings migration adds protected editable store identity, customer contact details including address and business hours, social links, display-only promotions, delivery copy, footer links, and a persistent store logo bucket.
2. Disable public user sign-ups in Supabase Auth. Create/invite the store owner’s account through the trusted Supabase dashboard; there is no public admin registration page.
3. Add the new Auth user's UUID to the administrator allowlist using the SQL editor:

   ```sql
   insert into public.beautypluz_admins (user_id)
   values ('AUTH_USER_UUID');
   ```

   Remove access by deleting that row. Do not expose a client-side insert or update policy for this table.
4. Set the Supabase project URL and **anon/public** key in `js/backend-config.js`. These values are not privileged credentials. Do not use the service-role key.
5. Serve the site over HTTPS. The admin session is kept in tab-scoped `sessionStorage`, distinct from any customer session, and is cleared by the sign-out action.

## Authorization requirements for future admin features

- Product insert, update, and delete operations are guarded by database RLS using `public.is_beautypluz_admin()`; browser checks only control the dashboard UI.
- Storage upload, update, and delete policies check `public.is_beautypluz_admin()`. Public reads are restricted to the dedicated product-images bucket.
- Homepage content is saved as a private draft and reaches visitors only through the published-content RPC. Publishing and draft updates require the administrator allowlist; uploaded hero and banner images are in a separate persistent bucket. The RPC validates content size, item limits, text lengths, unique IDs, featured-product references, and CTA URL schemes in addition to the editor's client-side validation.
- Customer order details are available only through admin-checked RPCs; direct browser access to `orders`, `order_items`, and status history remains revoked. Fulfilment changes accept only known statuses on the server and are recorded with actor and timestamp. Payment status and references are read-only in this dashboard and must be written by a trusted payment-provider integration after verification.
- Store settings are edited by the administrator and served publicly through a read-only published-settings RPC; the underlying settings table remains private. Logo uploads use the admin-only `store-assets` write policies. Social/footer URLs, contact formats, content sizes, and GBP-only currency are validated on the server as well as in the editor. Promotional codes are rendered as text only and have no discount/checkout effect. Shipping copy is informational and does not modify delivery estimates, charges, thresholds, or availability.
- The existing storefront has no standalone privacy, terms, or shipping policy pages. Store settings can add footer links to pages that exist (or secure external pages), but do not create legal policy content. GBP is fixed because pricing/cart formatting has no currency conversion support.
- The current cart checkout only hands order details to WhatsApp. It does not persist an order, and no payment provider or verified payment webhook is configured. Consequently, the Orders page will remain empty until a trusted backend checkout/order-ingestion endpoint creates order and item rows with customer details, totals, and immutable item snapshots. Do not create client-side orders or mark WhatsApp requests as paid.
- Do not grant browser clients write access to the allowlist or use the service-role key in frontend code.
- `tests/admin_auth.test.sql` covers unauthenticated and ordinary-user guard denial. `tests/product_crud.test.sql` tests authorized create/read/update/delete, case-insensitive duplicate rejection, ordinary-customer write denial, and preservation of historical order snapshots. `tests/homepage_content.test.sql` tests private drafts, customer write denial, rejected unsafe CTA links, and publishing to public storefront readers. `tests/orders_inventory.test.sql` tests protected order search/details, historical snapshots, server-validated fulfilment updates and status history, payment data remaining unverified, and authorized-only stock changes. Run the tests against a Supabase test/local database after applying the migrations.
- `tests/store_settings.test.sql` tests authorized settings persistence, public read-only storefront access, customer denial, private table access, safe URL validation, and rejection of unsupported currency. Run it against a Supabase test/local database after applying the migrations.

## Catalogue and storefront behavior

- The admin Products page creates and edits rows in `public.products`; it does not save an admin-only copy. New product IDs are generated by PostgreSQL. Product names are case-insensitively unique.
- The storefront loads published, available records from the same table. Price, optional sale price, image, badge, stock, availability, and homepage feature state are therefore shared between the admin and public pages. Adding/editing in the dashboard is visible on the next storefront page load.
- The legacy basket remains in browser `localStorage`, but line names, images, sale price, and current stock information are refreshed from the current product row. A removed product is omitted from the basket on next load. Order line snapshots use their own product name, unit price, image, and quantity; deleting a product only nulls the optional product reference, leaving the historical snapshot intact. Image files referenced by order snapshots are retained when a product image is replaced or removed.
- `stock_quantity = NULL` means stock is not tracked (used for the imported legacy catalogue). Newly created products start at zero stock until the owner enters a quantity. Products with zero stock or disabled availability are not shown as purchasable.
- Product images uploaded from the admin page go into Supabase Storage and are not written into the website deployment. Existing repository images continue to work as product image URLs until replaced.

The `/admin/` and `/admin/login.html` documents are static assets and may be retrievable from a static host; no private store data or privileged operation may be exposed by that fact. The dashboard remains hidden until the server confirms the user's admin role, and all actual administrative reads/writes must be independently protected by the database/RLS or a server-side function.
