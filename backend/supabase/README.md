# Admin authentication setup

The storefront is a static HTML/CSS/JavaScript site, so admin authorization is enforced by Supabase rather than by trusting a browser-side flag. The public Supabase anon key is safe to use in the browser only when database grants and row-level security are configured as intended. Never put a service-role key, database password, or other privileged credential in this site.

## Provision the backend

1. Create a Supabase project and apply, in filename order, `migrations/20261007010000_admin_auth.sql`, `migrations/20261007020000_product_management.sql`, `migrations/20261007030000_homepage_content.sql`, `migrations/20261007040000_orders_inventory.sql`, `migrations/20261007050000_store_settings.sql`, `migrations/20261027140000_checkout_order_foundation.sql`, `migrations/20261027150000_checkout_abuse_lifecycle.sql`, `migrations/20261028100000_checkout_delivery_sumup_lifecycle.sql`, `migrations/20261028110000_checkout_fixed_delivery_fee.sql`, and `migrations/20261101213000_checkout_inventory_payment_integrity.sql` using the Supabase CLI or SQL editor. The product migration creates the shared catalogue table, seeds the current 12 products without overwriting later edits, configures the persistent `product-images` bucket, and adds immutable order-line snapshot fields. The homepage migration adds draft/published content storage, guarded admin RPCs, and the persistent homepage image bucket. The order/inventory migration adds protected order-history and fulfilment RPCs, status audit records, and guarded stock updates. The store-settings migration adds protected editable store identity, customer contact details including address and business hours, social links, display-only promotions, delivery copy, footer links, and a persistent store logo bucket. The checkout migrations add private delivery and abuse-control settings, payload-bound idempotency, tracked-stock expiry, the fixed delivery fee, server-verified SumUp checkout state, and immutable checkout-time inventory tracking with reservation validation before payment is marked paid. Legacy tracking snapshots are backfilled from reservation rows, not current product stock; the migration does not create reservations or adjust stock for existing orders.
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
- The cart offers both WhatsApp ordering and SumUp checkout. SumUp checkout sends only product IDs and quantities plus customer and delivery details to `functions/create-checkout-order`; the server calculates the authoritative order total and creates the provider checkout. The browser generates a UUID idempotency key and a random checkout-access token, retaining the attempt and order ID in tab-scoped session storage so an unchanged retry after a refresh can recover the same order and the payment-result page can verify the return. The checkout uses the configured `BEAUTY_PLUZ_SITE_URL` server setting to send the customer to the static `payment-result.html` page from SumUp's hosted-checkout success screen. The page ignores URL status parameters and independently calls `functions/verify-sumup-payment`; it clears the cart only after the backend reports verified payment and the cart still matches the checked-out items. The checkout access token never appears in a URL or customer-facing content.
- `functions/create-checkout-order` validates customer and cart data, reads current prices and stock from PostgreSQL, calculates GBP totals in integer minor units, snapshots order lines, and reserves tracked inventory transactionally. It then creates or recovers a SumUp Hosted Checkout using sandbox credentials only. Browser-supplied prices, delivery amounts, payment states, and redirects are never authoritative. `payment-result.html` presents the order's random checkout-access token to `functions/verify-sumup-payment`, which verifies status server-to-server. A browser redirect never marks an order paid.
- Delivery uses a single server-side fixed fee of £4.60 per order (460 minor units) for all valid delivery destinations. The checkout still validates the customer's normalized country code and postal code format, but it does not use `checkout_delivery_zones` or `checkout_delivery_destinations` to compute or authorize the delivery amount. The legacy `checkout_settings.delivery_amount_pence` remains untouched and is not used to authorize or calculate the public delivery fee.

   GBP is fixed and amounts are integer minor units. The £4.60 fee is applied directly by the server-side checkout calculation; no delivery zones, free-delivery thresholds, or geographic rules are configured. An authorized operator must configure the reservation lifetime and approved rate-limit values in `checkout_settings` without changing that legacy fee field. Invalid customer delivery data still fails closed, but all valid destinations pay the same fixed fee and client-submitted delivery amounts are rejected.
- The sandbox testing checkout and payment-status functions require `CHECKOUT_RATE_LIMIT_HMAC_KEY`, a randomly generated secret with at least 32 bytes, stored only in Supabase Edge Function secrets. Checkout creation HMACs a normalized customer phone identity (uppercase country code plus digits with punctuation removed); payment verification HMACs the digest of the validated checkout access token. Only HMAC digests enter the rate-limit table; plaintext phone numbers and access tokens are not stored there or logged. This is format normalization, not telephone-number-plan validation, and phone/token throttling is supplemental protection only: it is not a replacement for verified IP-based rate limiting, trusted ingress controls, or platform-wide abuse/DDoS prevention. Do not rely on this testing alternative as production abuse protection. Before any production exposure, verify the deployed ingress overwrites its client-IP header and add appropriate verified-IP or ingress-level controls.
- The Edge Functions use `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` only in the trusted server runtime. `config.toml` disables JWT verification for the public checkout-start and payment-status endpoints and for reconciliation. The reconciliation handler instead requires an exact match of the dedicated 256-bit hexadecimal `RECONCILIATION_API_KEY` from the `x-reconciliation-key` header. Supabase's gateway `verify_jwt` check cannot validate this custom secret; it accepts JWTs or recognized Supabase API keys, not arbitrary hex values. Do not send the custom secret in `Authorization` or `apikey`. The GitHub workflow sends a separate project publishable key in `apikey` for gateway project identification; it does not authorize reconciliation. No privileged credential belongs in storefront files, workflow source, migrations, or logs.
- Reservations are consumed or released transactionally with the verified payment state under a consistent order/session lock order. A successful payment consumes the reservation; confirmed checkout expiry releases it. SumUp documents `FAILED` as the latest processing attempt failing, so a failed attempt and a cancelled transaction remain pending and retain stock while the hosted checkout may still be retried. The scheduler must recheck the provider until it reports a verified success or checkout expiry; if provider status remains ambiguous, keep the reservation and escalate rather than release stock.
- `functions/reconcile-sumup-checkouts` is the privileged scheduled worker. The optional GitHub Actions workflow at `.github/workflows/reconcile-sumup-checkouts.yml` runs every five minutes and can also be started manually. Configure the repository variables `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, and the GitHub Actions secret `RECONCILIATION_API_KEY`; configure the Edge Function secret with the same locally generated 64-character hexadecimal value. The workflow sends the publishable key in `apikey` only for gateway project identification and sends the custom secret only in `x-reconciliation-key`. The function rejects missing, malformed, or non-matching custom secrets before doing work; a publishable key alone cannot authorize reconciliation. Supabase gateway JWT verification is disabled for this function only because the custom secret is not a Supabase JWT or API key. All callers must possess the custom secret. Do not put credential values in workflow files, source, logs, or responses.

  Alternatively, a Supabase `pg_cron` + `pg_net` job can invoke the function every five minutes; this repository does not create that database job. Before activation, enable `pg_cron` and `pg_net` in the Supabase Dashboard, then create Vault entries named `beauty_pluz_project_url` and `beauty_pluz_reconciliation_api_key` using the Dashboard UI. The SQL example below sends the custom secret through `x-reconciliation-key`. Restrict database access to trusted operators: `pg_net` temporarily queues decrypted request headers until dispatch.

  After verifying the deployed function's server-side configuration and that the Vault entries exist, an authorized operator can run this non-secret SQL in the project SQL editor. The transaction-scoped advisory lock and job-name check prevent repeated or simultaneous runs from creating another job with this name. If `cron.job` already contains multiple matching jobs from an earlier setup, remove the extras through an authorized operator action before relying on this block; it does not delete existing jobs.

  ```sql
  do $setup$
  declare
    v_matching_jobs integer;
    v_present_vault_entries integer;
  begin
    perform pg_advisory_xact_lock(
      hashtextextended('beauty-pluz-sumup-reconciliation', 0)
    );

    select count(*) into v_present_vault_entries
    from vault.decrypted_secrets
    where name in (
      'beauty_pluz_project_url',
      'beauty_pluz_reconciliation_api_key'
    )
      and decrypted_secret <> '';
    if v_present_vault_entries <> 2 then
      raise exception 'Required scheduler Vault entries are missing or empty';
    end if;

    select count(*) into v_matching_jobs
    from cron.job
    where jobname = 'beauty-pluz-sumup-reconciliation';
    if v_matching_jobs > 1 then
      raise exception 'Multiple scheduler jobs already use the reconciliation name';
    end if;
    if v_matching_jobs = 0 then
      perform cron.schedule(
        'beauty-pluz-sumup-reconciliation',
        '*/5 * * * *',
        $job$
          select net.http_post(
            url := (
              select decrypted_secret
              from vault.decrypted_secrets
              where name = 'beauty_pluz_project_url'
            ) || '/functions/v1/reconcile-sumup-checkouts',
            headers := jsonb_build_object(
              'Content-Type', 'application/json',
              'x-reconciliation-key', (
                select decrypted_secret
                from vault.decrypted_secrets
                where name = 'beauty_pluz_reconciliation_api_key'
              )
            ),
            body := '{}'::jsonb
          ) as request_id;
        $job$
      );
    end if;
  end;
  $setup$;
  ```

  The block checks Vault entry presence without selecting or displaying their values. It only returns normally when zero or one matching job exists; it does not delete jobs.

  The worker examines at most two expired-window checkouts per run, with at most two provider reconciliations in flight and no retry loop. Its JSON response contains only aggregate counts: `examined`, `paid`, `pending`, `failed`, `cancelled`, `expired`, `errors`, `providerErrors`, and `releasedReservations`. `failed` and `cancelled` can count a retryable latest transaction attempt while its checkout is still counted as `pending`; those attempts do not release inventory. A per-checkout error is counted and logged without exception/provider details, and does not stop another checkout in that batch. A provider timeout or invalid response leaves that checkout and its reservation unchanged for a later run. The database verification RPC independently checks the provider identifiers, merchant, amount, currency, and transaction before changing state.

  Monitor Edge Function logs for run-level 503s and aggregate item-error warnings. `cron.job_run_details` confirms cron dispatch, while `net._http_response` holds the HTTP result for six hours by default; inspect only status/timeout/error-presence metadata and aggregate function output, not request headers. To identify long-overdue pending orders for manual review, an authorized database operator can run:

  ```sql
  select
    orders.id as order_id,
    sessions.payment_state,
    floor(extract(epoch from (
      clock_timestamp() - orders.checkout_reservation_expires_at
    )) / 60)::bigint as minutes_past_checkout_expiry,
    sessions.last_verified_at
  from public.sumup_checkout_sessions as sessions
  join public.orders as orders on orders.id = sessions.order_id
  where sessions.payment_state in ('creating', 'pending')
    and orders.checkout_reservation_expires_at < clock_timestamp() - interval '30 minutes'
  order by orders.checkout_reservation_expires_at
  limit 100;
  ```

  This query returns no customer details. Escalate old pending rows or repeated provider errors for manual investigation; do not release their inventory until SumUp has been independently checked. Never put a service-role token in source, a browser, or logs.
- Before enabling either public Edge Function in a sandbox project, configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CHECKOUT_RATE_LIMIT_HMAC_KEY` (at least 32 random bytes), `SUMUP_ENVIRONMENT=sandbox`, `SUMUP_SANDBOX_API_KEY`, and `SUMUP_SANDBOX_MERCHANT_CODE` as server-side function secrets/configuration only. Set the non-secret `BEAUTY_PLUZ_SITE_URL` function setting to the dedicated Vercel Preview Deployment's HTTPS origin, with no path, query, or fragment. Do not use the production website origin in sandbox configuration. For production, configure `BEAUTY_PLUZ_SITE_URL` separately to the live Beauty Pluz website's HTTPS origin; production configuration is outside sandbox testing. Checkout fails closed if this setting is missing or invalid and uses it only to construct the fixed `/payment-result.html` URL. No live SumUp API key is accepted by this implementation. The testing flow does not require `CHECKOUT_TRUSTED_INGRESS_CONFIRMED=true` or trust caller-supplied IP headers; its phone/token rate limits are supplemental only and are not sufficient production abuse prevention. Verify trusted ingress and configure verified-IP or ingress-level controls before any production exposure. Rate limiting and sandbox configuration remain fail-closed, and status checks require the private access token.
- Reusing an idempotency key with a different normalized customer/shipping value or sorted product/quantity list is rejected with a generic conflict. PostgreSQL computes and stores a SHA-256 digest of the canonical request; the browser cannot supply it, and it is not exposed through admin RPCs. Concurrent identical requests serialize on product locks and the unique idempotency key, returning one order without a second stock reservation. Expired keys cannot be used to treat an old order as active.
- Apply migrations in order with `supabase migration up --local` from `backend/` when the local Supabase database is running, or apply the SQL files in order in a disposable test project's SQL editor. Run `tests/checkout_foundation.test.sql` on a disposable test/local database with `psql -v ON_ERROR_STOP=1 -f supabase/tests/checkout_foundation.test.sql` from `backend/`, using a securely configured local test connection. It checks server-side prices, sale prices, the fixed fee for mapped and unmapped valid destinations, resistance to client-supplied prices/fees/totals, checkout-policy fail-closed behavior, invalid input, availability/stock, retries/mismatched keys, expiry/release, rate limiting, tracked/untracked inventory, unverified payment state, and direct client write denial. The test runs in a transaction and rolls back its fixture changes; do not run it against a production database.
- For multi-session concurrency coverage, start Supabase locally and run `node supabase/tests/checkout_concurrency.test.mjs` from `backend/`. The test requires Docker, creates uniquely named synthetic products and orders, launches parallel `psql` sessions, and removes only its own fixtures. It does not modify the existing checkout settings or delivery fee. It checks concurrent same-key checkouts and requests at the rate-limit boundary. Do not run it against a production or shared database.
- Run `tests/checkout_payment_lifecycle.test.sql` against a local/disposable database for verified success, duplicate verification, retryable failed/cancelled attempts, expiry, access-token ownership, and reservation-state consistency. Run the server-side tests with `node --test supabase/tests/sumup_verification.test.mjs supabase/tests/checkout_rate_limit.test.mjs supabase/tests/checkout_endpoints.test.mjs` from `backend/`. These tests do not require SumUp credentials or make provider API calls.
- Run `tests/checkout_inventory_integrity.test.sql` against a local/disposable database after applying all migrations. It checks transactional rollback, tracked versus untracked checkout snapshots, reservation consumption, no second stock deduction, missing or mismatched reservation rejection, legacy untracked-order compatibility, idempotent verification, and expired-reservation release. The SQL regression runner also supports this test with `.\supabase\tests\run_sql_tests.ps1 -Test checkout_inventory_integrity`; do not run it against production or shared customer data.
- Run `node --experimental-transform-types --test supabase/tests/checkout_rate_limit.test.mjs` from `backend/` to verify phone normalization, HMAC identity separation, malformed input handling, and fail-closed allow/deny behavior of the existing rate-limit RPC client.
- SumUp integration is implemented only as a sandbox backend foundation and is not yet verified against a sandbox account. Do not deploy, enable customer checkout, or switch the storefront until sandbox credentials, trusted ingress behavior, the scheduler, and the full runtime/provider checks are verified.
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
