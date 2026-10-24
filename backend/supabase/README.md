# Admin authentication setup

The storefront is a static HTML/CSS/JavaScript site, so admin authorization is enforced by Supabase rather than by trusting a browser-side flag. The public Supabase anon key is safe to use in the browser only when database grants and row-level security are configured as intended. Never put a service-role key, database password, or other privileged credential in this site.

## Provision the backend

1. Apply the migrations in filename order. The product migration creates the shared catalogue table, seeds the current 12 products without overwriting later edits, configures the persistent `product-images` bucket, and adds immutable order-line snapshot fields. The homepage migration adds draft/published content storage, guarded admin RPCs, and the persistent homepage image bucket. The order/inventory migration adds protected order-history and fulfilment RPCs, status audit records, and guarded stock updates. The store-settings migration adds protected editable store identity, customer contact details including address and business hours, social links, display-only promotions, delivery copy, footer links, and a persistent store logo bucket. The checkout migrations add server-only checkout attempts, event-idempotency, stock reservations, hashed guest capabilities, scoped status/recovery RPCs, and atomic rate-limit buckets. The gateway assertion migration adds single-use nonce storage and a narrowly scoped service-role RPC.
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
- The cart now calls the Stripe Checkout Edge Function, but checkout remains unavailable until the function is deployed with reviewed configuration and the target database migrations are verified. No live payment provider is enabled. The Orders page reflects only orders created by the trusted backend; never create client-side orders or mark a redirect as paid.
- Do not grant browser clients write access to the allowlist or use the service-role key in frontend code.
- `tests/admin_auth.test.sql` covers unauthenticated and ordinary-user guard denial. `tests/product_crud.test.sql` tests authorized create/read/update/delete, case-insensitive duplicate rejection, ordinary-customer write denial, and preservation of historical order snapshots. `tests/homepage_content.test.sql` tests private drafts, customer write denial, rejected unsafe CTA links, and publishing to public storefront readers. `tests/orders_inventory.test.sql` tests protected order search/details, historical snapshots, server-validated fulfilment updates and status history, payment data remaining unverified, and authorized-only stock changes. Run the tests against a Supabase test/local database after applying the migrations.
- `tests/store_settings.test.sql` tests authorized settings persistence, public read-only storefront access, customer denial, private table access, safe URL validation, and rejection of unsupported currency. Run it against a Supabase test/local database after applying the migrations.
- `tests/checkout_foundation.test.sql` covers atomic basket creation, retry/idempotency behavior, verified-event state changes, reservation release, and denied browser-role access. `tests/checkout_guest_safety.test.sql` covers minimal guest status, one-time handoff use, expired/revoked capabilities, rate-limit exhaustion, durable recovery retries and replacement attempts, late payment events, and denied browser-role access. `tests/checkout_concurrency.test.ps1` exercises simultaneous reservations; `tests/checkout_recovery_concurrency.test.ps1` verifies concurrent recovery requests reuse one attempt and concurrent handoff requests consume a token once. Run SQL and PowerShell database tests only after starting the local Supabase stack. Do not treat a test as passing until it has run against local PostgreSQL.
- `tests/gateway_assertion_replay.test.sql` verifies assertion nonces are consumed once, expiry is bounded, and browser roles cannot access the replay table or RPC.
- `tests/stripe_functions.test.mjs` covers checkout request validation, trusted order snapshots, Stripe retry idempotency, raw webhook signature input, database mismatches, and transient failures. Run with `node --test backend/supabase/tests/stripe_functions.test.mjs` from the repository root.
- `tests/storefront_checkout.test.mjs` covers the browser request contract, client idempotency, single-flight submission, Stripe URL validation, and non-authoritative return pages. Run with `node --test backend/supabase/tests/storefront_checkout.test.mjs`.

## Stripe Edge Functions (not yet deployed)

The `stripe-checkout`, `stripe-webhook`, `stripe-guest-handoff`, `stripe-guest-status`, and `stripe-checkout-recover` Edge Functions use Stripe-hosted Checkout in GBP and server-only RPCs. The four browser-facing functions disable Supabase JWT verification and require a fresh Ed25519 request assertion signed by the Worker; the corresponding private signing key is never sent to the browser. The webhook remains separate and authenticates Stripe's raw-body signature; do not proxy it through the browser gateway. Never expose the Supabase service-role key, Worker signing key, or Stripe secrets to the storefront.

Supabase provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the Edge Runtime; the functions require those server-side values but they do not need to be copied into the local env file or manually set as project secrets. Configure these Edge Function secrets and deployment settings:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `CHECKOUT_ALLOWED_ORIGINS` (comma-separated exact origins, with no paths)
- `CHECKOUT_SUCCESS_URL` (must contain Stripe's literal `{CHECKOUT_SESSION_ID}` placeholder)
- `CHECKOUT_CANCEL_URL`
- `CHECKOUT_DELIVERY_FEE_PENCE` (trusted integer pence; never accepted from the browser)
- `CHECKOUT_CAPABILITY_SECRET` (server-only random secret of at least 32 characters, used for purpose-separated HMAC guest capabilities)
- `CHECKOUT_RATE_LIMIT_SECRET` (server-only random secret of at least 32 characters, used to HMAC rate-limit keys)
- `GUEST_GATEWAY_PUBLIC_KEY` (base64url-encoded raw 32-byte Ed25519 public key; configure on the Edge Functions, not in browser code)

Use a local-only env file outside the repository for `supabase functions serve`; do not commit it. Supabase supplies local `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` when serving locally. Set the local origins and return paths to match your actual local static-site port, for example `http://127.0.0.1:5500` with `checkout-success.html?session_id={CHECKOUT_SESSION_ID}` and `checkout-cancelled.html`. For a deployed storefront, replace these with placeholders for the confirmed site host; do not guess a production domain. Example with a local Stripe test key and a Stripe CLI webhook-forwarding secret:

```powershell
supabase start --workdir "C:\beauty-pluz\backend"
supabase functions serve stripe-checkout stripe-webhook stripe-guest-handoff stripe-guest-status stripe-checkout-recover --env-file "C:\secure\beauty-pluz-functions.local.env" --workdir "C:\beauty-pluz\backend"
```

Set the local env file's allowed origin and success/cancel URLs to the actual local static-site origin. Supabase injects the local URL and service-role key and rejects attempts to override `SUPABASE_*` through this env file. The success URL is only a redirect; it is not proof of payment. Stripe CLI forwarding and test-mode credentials are required for end-to-end checkout/payment testing. Do not use `supabase secrets set` or deploy commands until the project is deliberately linked and reviewed.

The cart calls the configured `guestCheckoutGatewayUrl` with only product IDs, quantities, and required customer fields. The return pages use that same gateway origin for handoff, status, and recovery. The public gateway URL is not secret. Leave it empty until the gateway is configured; the storefront must not fall back to direct Supabase function URLs. The Worker sends the publishable Supabase key in `apikey` and signs each upstream method, exact path, timestamp, random nonce, and body digest with its server-held Ed25519 private key.

### Protected Cloudflare checkout gateway

The small Worker project is in `checkout-gateway/`. It proxies exactly these paths to their matching Supabase Edge Functions:

- `/stripe-checkout`
- `/stripe-guest-handoff`
- `/stripe-guest-status`
- `/stripe-checkout-recover`

The Stripe webhook is intentionally excluded. The Worker checks exact paths, POST/JSON requests, payload shapes and byte limits, and an exact allowed `Origin`. It forwards only `Origin`, `Content-Type`, the configured public `apikey`, and the signed assertion headers. It discards caller-supplied authorization, cookie, assertion, and forwarding headers. Each Edge Function verifies the Ed25519 signature against `GUEST_GATEWAY_PUBLIC_KEY`, checks the narrow timestamp window, binds the signature to the method/path/body, and atomically consumes its nonce with a service-role-only RPC before creating checkout services or calling Stripe/Postgres. Missing, invalid, expired, altered, or replayed assertions receive a generic `401`; unavailable signing configuration or nonce storage fails closed with `503`. This is not CORS authentication.

The Worker derives the rate-limit identity only from Cloudflare's `CF-Connecting-IP` header on its public ingress and does not use `X-Forwarded-For`, `X-Real-IP`, or other caller-provided forwarding headers. Cloudflare documents `CF-Connecting-IP` as the visitor IP header provided from its edge to the origin; review its [header and Worker-subrequest caveats](https://developers.cloudflare.com/fundamentals/reference/http-headers/) if the ingress topology changes. IPv4 addresses are bucketed per address and IPv6 addresses per `/64` to reduce circumvention by temporary IPv6 address rotation. The normalized address and endpoint are HMAC-SHA-256 hashed with the Worker-only `GUEST_RATE_LIMIT_SECRET` before use as the bucket identifier, so the stored keys do not contain raw IP addresses. A 256-shard SQLite-backed Durable Object namespace stores atomic token buckets, with a 24-hour stale-row cleanup. Limits currently allow these per-IP bursts and refill rates:

| Endpoint | Initial burst | Refill |
| --- | ---: | ---: |
| Checkout | 20 | 15 per minute |
| Guest handoff | 10 | 10 per minute |
| Guest status | 60 | 60 per minute |
| Recovery | 5 | 5 per minute |

Requests from the same shared NAT/VPN address share a bucket; the burst allowance helps ordinary households and small offices, but thresholds must be monitored and tuned against real traffic. Retries count against the gateway limit; checkout's existing database idempotency preserves the same logical attempt. The Worker returns `429` plus `Retry-After` when throttled and does not call Supabase. A missing trusted IP, broken Durable Object binding, malformed limiter response, or limiter exception returns generic `503` without contacting Supabase. The database limiter remains as a second independent safeguard.

### Direct-origin limitation

The Supabase function URL remains publicly reachable. The Supabase [function configuration](https://supabase.com/docs/guides/functions/function-configuration), [authentication](https://supabase.com/docs/guides/functions/auth), and [network restrictions](https://supabase.com/docs/guides/platform/network-restrictions) documentation reviewed for this deployment describes JWT/API-key checks and database network restrictions, but does not document a per-function network allowlist or private function origin that restricts ingress to this Worker. No provider-level function ingress restriction has been configured or verified.

The request assertion prevents a caller who merely knows the former reusable shared header value, or captures a prior assertion, from generating a new authorized request. It is not network isolation: the public function URL can still receive traffic and consume invocation capacity; a valid, not-yet-expired assertion can be sent directly once; and compromise of the Worker private signing key permits fresh direct assertions until that key is rotated. The assertion nonce RPC only prevents replay of an already accepted assertion. For stronger origin isolation, use a provider-supported private origin or verified ingress policy if one becomes available; otherwise continue to treat the public function URL as exposed and monitor invocation abuse. Do not claim the Worker makes Supabase network-private.

#### Local Worker setup

Required Worker runtime settings (local `.dev.vars`, never commit it):

- `SUPABASE_URL` — Supabase project API origin; use `http://127.0.0.1:54321` locally.
- `SUPABASE_PUBLISHABLE_KEY` — public Supabase publishable/anon key (local value from `supabase status`).
- `ALLOWED_ORIGINS` — comma-separated exact storefront origins, for example `http://127.0.0.1:5500`.
- `GUEST_GATEWAY_PRIVATE_KEY` — base64url-encoded Ed25519 PKCS#8 private key; keep only in Worker secret configuration or ignored `.dev.vars`.
- `GUEST_RATE_LIMIT_SECRET` — independent random secret of at least 32 characters, used only to derive rate-limit bucket IDs.

Local prerequisites are Node.js, Docker with its daemon running, the Supabase CLI, and Wrangler installed locally (do not install Wrangler globally). Generate one Ed25519 keypair for each environment. Keep its PKCS#8 private key only in the Worker secret store/ignored `.dev.vars`, and put the matching raw public key in `GUEST_GATEWAY_PUBLIC_KEY` in `C:\secure\beauty-pluz-functions.local.env`. Never use the private key in the Edge Function env or browser. Set `GUEST_RATE_LIMIT_SECRET` only in the Worker configuration. Set `js/backend-config.js`'s `guestCheckoutGatewayUrl` to `http://127.0.0.1:8787` only for local testing. Do not use the actual project URL for local testing.

Create `checkout-gateway/.dev.vars` locally (the file is ignored by Git) with these values; use the local key from `supabase status` and the same generated gateway secret as the Edge Function env file:

```text
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_PUBLISHABLE_KEY=<local publishable/anon key>
ALLOWED_ORIGINS=http://127.0.0.1:5500
GUEST_GATEWAY_PRIVATE_KEY=<base64url Ed25519 PKCS#8 private key>
GUEST_RATE_LIMIT_SECRET=<independent random limiter secret>
```

```powershell
supabase start --workdir "C:\beauty-pluz\backend"
supabase migration up --local --workdir "C:\beauty-pluz\backend"
supabase functions serve stripe-checkout stripe-webhook stripe-guest-handoff stripe-guest-status stripe-checkout-recover --env-file "C:\secure\beauty-pluz-functions.local.env" --workdir "C:\beauty-pluz\backend"
```

In separate PowerShell windows, run the local storefront server and Worker:

```powershell
py -m http.server 5500 --bind 127.0.0.1 --directory "C:\beauty-pluz"
cd "C:\beauty-pluz\checkout-gateway"
npm test
npm run dev -- --ip 127.0.0.1 --port 8787
```

The Worker unit tests explicitly simulate Cloudflare's ingress header and Durable Object storage; they do not verify production header injection or hosted Durable Object behavior. Wrangler local development may provide only an emulated client address; if it does not provide `CF-Connecting-IP`, the Worker correctly returns `503` rather than trusting a forwarded header. In production, set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `ALLOWED_ORIGINS`, `GUEST_GATEWAY_PRIVATE_KEY`, and `GUEST_RATE_LIMIT_SECRET` through reviewed Worker configuration; set the matching public key as `GUEST_GATEWAY_PUBLIC_KEY` in Supabase Edge Function secrets. Configure the storefront's public gateway origin only after the Worker is deployed and tested. Deployment, DNS changes, hosted secrets, and hosted database changes are explicitly outside this implementation.

#### Deployment prerequisites and rollback

Before production, review the Cloudflare account/plan and Durable Object SQLite namespace availability, configure the intended Worker hostname and allowed storefront origins, provision an Ed25519 keypair and independent limiter secret, confirm the Supabase project URL/publishable key, apply the nonce migration, and run an end-to-end test against a non-production Supabase/Stripe test environment. Verify direct-origin calls without assertions, with stale assertions, and with changed method/path/body are rejected; verify replay is rejected and a valid Worker request succeeds. No hosted deployment, secret configuration, URL change, or payment test has been performed by this change.

For rollback, first set the storefront's `guestCheckoutGatewayUrl` to an empty string to stop new guest checkout requests, then disable the Worker route. Keep Edge Function assertion verification enabled; do not fall back to direct Supabase calls. If the Worker private key may have been exposed, generate a new keypair and rotate the Worker private key and Edge Function public key together during a controlled maintenance window. A gateway outage, missing limiter, or nonce-store failure is fail-closed and intentionally makes checkout temporarily unavailable.

The return pages exchange a short-lived, attempt-scoped handoff capability by POST. A synchronous same-origin script stores that one-time handoff in tab-scoped `sessionStorage` and strips both the fragment and Stripe's `session_id` query value before external page resources load. After exchange, only the read-only status capability is retained in `sessionStorage` so a refresh can ask the backend for the latest status; the more powerful recovery capability remains in page memory and is not persisted. Storage failures degrade to the current page session and never make a redirect proof of payment. The handoff is consumed once, while retries of the same attempt preserve its consumed state. The status RPC returns only an eight-character order reference and payment status; only the Stripe webhook changes payment state. Pending status remains explicit. A service-role-only revocation RPC invalidates all guest capabilities for an order. Recovery requires a customer action and a database lock; the database stores the current recovery idempotency key so retries after reload reuse the same attempt and Stripe Session. Once that attempt is expired or terminal, the next explicit recovery can allocate a fresh database key. Paid orders and active/ambiguous attempts are blocked, and released inventory is reacquired through the existing atomic checkout RPC. A verified paid status clears old basket-specific checkout keys so a later legitimate purchase receives a new key. The Stripe return-fragment behavior was verified in local Stripe test mode; production redirect URLs still need to be configured for the production storefront origin.

The narrow function contracts are: `stripe-guest-handoff` accepts `{ "handoffToken": "..." }` and returns `{ "orderReference", "paymentStatus", "message", "statusToken", "recoveryToken" }`; `stripe-guest-status` accepts `{ "statusToken": "..." }` and returns `{ "orderReference", "paymentStatus", "message" }`; `stripe-checkout-recover` accepts `{ "recoveryToken": "..." }` and returns `{ "url": "https://checkout.stripe.com/..." }`. The capability values are purpose-separated HMAC credentials; only their SHA-256 hashes are stored. Raw credentials must not be persisted in browser storage or logs.

The PostgreSQL limiter uses fixed windows, HMAC-derived keys, atomic upserts, and returns `429` with `Retry-After`; unavailable limiter RPCs fail closed. Current limits are 5 checkout attempts per HMAC(email) per 5 minutes, 10 per HMAC(idempotency key) per 10 minutes, a 100/minute global checkout circuit breaker, 100/minute per-endpoint global caps for handoff/status/recovery, 10 handoff exchanges per capability per 5 minutes, 30 status reads per capability per 5 minutes, and 5 recoveries per capability per 5 minutes. These database limits are defense in depth; the Cloudflare gateway adds the trusted ingress IP buckets above. Email can be varied and global caps can temporarily block all customers, so monitor these controls and tune them before production. No CAPTCHA is configured.

### Local storefront checkout checks

The checked-in `js/backend-config.js` still points at the previously configured Supabase project. For an isolated end-to-end local test, start the local Supabase stack, apply only its local migrations, temporarily configure the browser's public URL/key to the local `API_URL` and `ANON_KEY`, and restore the existing values before publishing. Never use `SERVICE_ROLE_KEY` in the browser. Keep test-mode Stripe keys and the Stripe CLI webhook-forwarding secret in the external local Edge Function env file. The local static origin must match `CHECKOUT_ALLOWED_ORIGINS` exactly.

Run the focused local verification from the repository root:

```powershell
node --test checkout-gateway\tests\gateway.test.mjs
supabase start --workdir "C:\beauty-pluz\backend"
supabase migration up --local --workdir "C:\beauty-pluz\backend"
node --test checkout-gateway\tests\gateway.test.mjs backend\supabase\tests\stripe_functions.test.mjs backend\supabase\tests\storefront_checkout.test.mjs
$dockerPath = (Get-Command docker).Source
foreach ($file in @("backend\supabase\tests\checkout_foundation.test.sql", "backend\supabase\tests\checkout_guest_safety.test.sql")) {
  Get-Content -Raw $file | & $dockerPath exec -i supabase_db_supabase psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f -
  if ($LASTEXITCODE -ne 0) { throw "SQL test failed: $file" }
}
powershell -NoProfile -ExecutionPolicy Bypass -File backend\supabase\tests\checkout_recovery_concurrency.test.ps1
```

The current SQL files use assertion blocks rather than pgTAP output; execute them directly with `psql` as above. The CLI's `supabase test db` TAP summary can return a nonzero result because those files do not emit TAP plans.

```powershell
node --test backend\supabase\tests\stripe_functions.test.mjs backend\supabase\tests\storefront_checkout.test.mjs
supabase start --workdir "C:\beauty-pluz\backend"
supabase migration up --local --workdir "C:\beauty-pluz\backend"
supabase status --workdir "C:\beauty-pluz\backend" -o env | Select-String '^(API_URL|ANON_KEY)='
py -m http.server 5500 --bind 127.0.0.1 --directory "C:\beauty-pluz"
supabase functions serve stripe-checkout stripe-webhook stripe-guest-handoff stripe-guest-status stripe-checkout-recover --env-file "C:\secure\beauty-pluz-functions.local.env" --workdir "C:\beauty-pluz\backend"
# In another PowerShell window, with Stripe CLI installed and test-mode keys:
stripe listen --forward-to http://127.0.0.1:54321/functions/v1/stripe-webhook
```

Use `http://127.0.0.1:5500` for the local allowed origin, success URL `http://127.0.0.1:5500/checkout-success.html?session_id={CHECKOUT_SESSION_ID}`, and cancel URL `http://127.0.0.1:5500/checkout-cancelled.html`. The Stripe CLI `whsec_...` value is local-test-only and belongs in the external env file. Stop the static server with Ctrl+C; stop Supabase with `supabase stop --workdir "C:\beauty-pluz\backend"` when finished. Do not link or deploy a hosted project.

Run local database checks after `supabase migration up --local`:

```powershell
Get-Content "C:\beauty-pluz\backend\supabase\tests\checkout_guest_safety.test.sql" -Raw | docker exec -i supabase_db_supabase psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres
powershell -ExecutionPolicy Bypass -File "C:\beauty-pluz\backend\supabase\tests\checkout_recovery_concurrency.test.ps1"
```

Use only generated local/test secrets for the two new variables; keep them in the external env file. The rate limiter does not read or trust `X-Forwarded-For`, `X-Real-IP`, or other caller-controlled IP headers. No hosted migration, deployment, or production configuration has been performed.

## Catalogue and storefront behavior

- The admin Products page creates and edits rows in `public.products`; it does not save an admin-only copy. New product IDs are generated by PostgreSQL. Product names are case-insensitively unique.
- The storefront loads published, available records from the same table. Price, optional sale price, image, badge, stock, availability, and homepage feature state are therefore shared between the admin and public pages. Adding/editing in the dashboard is visible on the next storefront page load.
- The legacy basket remains in browser `localStorage`, but line names, images, sale price, and current stock information are refreshed from the current product row. A removed product is omitted from the basket on next load. Order line snapshots use their own product name, unit price, image, and quantity; deleting a product only nulls the optional product reference, leaving the historical snapshot intact. Image files referenced by order snapshots are retained when a product image is replaced or removed.
- `stock_quantity = NULL` means stock is not tracked (used for the imported legacy catalogue). Newly created products start at zero stock until the owner enters a quantity. Products with zero stock or disabled availability are not shown as purchasable.
- Product images uploaded from the admin page go into Supabase Storage and are not written into the website deployment. Existing repository images continue to work as product image URLs until replaced.

The `/admin/` and `/admin/login.html` documents are static assets and may be retrievable from a static host; no private store data or privileged operation may be exposed by that fact. The dashboard remains hidden until the server confirms the user's admin role, and all actual administrative reads/writes must be independently protected by the database/RLS or a server-side function.
