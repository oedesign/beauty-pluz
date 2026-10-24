# Restore Beauty Pluz on a new Windows computer

This repository's recovery target is the `development` branch. The storefront and admin UI, Supabase function source, database migrations and tests, checkout gateway source, and checked-in static images are in Git. Git does not contain private environment files, Supabase database contents, uploaded Storage objects, or local emulator state.

## 1. Install prerequisites

- Git for Windows.
- Node.js 24.11.0 and npm 11.13.0, matching the inspected development computer. The repository does not pin a Node version; use Node.js 24 LTS for this checkout.
- Docker Desktop, started before local Supabase commands.
- Supabase CLI 2.121.0 (the version on the inspected development computer).
- Python 3 if you want to run the included static-file server.
- Stripe CLI only if you need to test Stripe webhook delivery locally.

Wrangler is a project-local development dependency; do not install it globally.

## 2. Clone the development branch

In PowerShell:

```powershell
git clone --branch development --single-branch https://github.com/oedesign/beauty-pluz.git C:\beauty-pluz
Set-Location C:\beauty-pluz
git status --short --branch
```

Confirm the reported branch is `development`.

## 3. Install checkout-gateway dependencies

```powershell
Set-Location C:\beauty-pluz\checkout-gateway
npm ci
npm test
```

The static storefront/admin pages have no root package manifest or root dependency installation.

## 4. Restore secrets securely

Restore private files from your separate encrypted backup or password manager; they are intentionally not in Git:

- `C:\secure\beauty-pluz-functions.local.env` for local Supabase Edge Function settings.
- `C:\beauty-pluz\checkout-gateway\.dev.vars` for local Worker settings.

Create these files locally with access limited to your Windows account. Do not paste credentials into chat, source files, this guide, or Git. Do not copy the old computer's generated Supabase `.temp` files; Supabase regenerates them.

The Supabase Edge Function environment uses `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CHECKOUT_ALLOWED_ORIGINS`, `CHECKOUT_SUCCESS_URL`, `CHECKOUT_CANCEL_URL`, `CHECKOUT_DELIVERY_FEE_PENCE`, `CHECKOUT_CAPABILITY_SECRET`, `CHECKOUT_RATE_LIMIT_SECRET`, and `GUEST_GATEWAY_PUBLIC_KEY`. Supabase supplies local `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` when serving functions; do not put a service-role key in the storefront or Worker.

The local Worker `.dev.vars` uses `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `ALLOWED_ORIGINS`, `GUEST_GATEWAY_PRIVATE_KEY`, and `GUEST_RATE_LIMIT_SECRET`. Keep the Ed25519 private key only in this ignored file or the Worker secret store. The matching public key belongs in the Edge Function environment. Use the local publishable/anon key shown by `supabase status`, and use local origins such as `http://127.0.0.1:5500`; do not substitute a production URL for local testing.

`js/backend-config.js` contains the storefront's public Supabase URL and publishable/anon key. These are browser-visible values, not privileged credentials. The gateway URL is currently empty; keep it empty unless a local or deployed gateway is deliberately configured and reviewed.

Stripe checkout Edge Functions are documented as not yet deployed. For local end-to-end checkout, use Stripe test-mode credentials and a Stripe CLI webhook-forwarding secret. Do not set production secrets, deploy functions, or change hosted configuration as part of local setup.

## 5. Start local Supabase and apply migrations

Start Docker Desktop, then from PowerShell:

```powershell
Set-Location C:\beauty-pluz
supabase start --workdir "C:\beauty-pluz\backend"
supabase status --workdir "C:\beauty-pluz\backend"
supabase migration up --local --workdir "C:\beauty-pluz\backend"
```

The migrations create the schema and seed the initial catalogue. Do not run `supabase db reset` against a database containing data you need; a reset is destructive. The SQL and PowerShell database tests require the local Supabase/PostgreSQL stack to be running.

To serve the Edge Functions locally, use a separate PowerShell window after securely restoring the env file:

```powershell
supabase functions serve stripe-checkout stripe-webhook stripe-guest-handoff stripe-guest-status stripe-checkout-recover --env-file "C:\secure\beauty-pluz-functions.local.env" --workdir "C:\beauty-pluz\backend"
```

## 6. Run the storefront, gateway, and tests

With the local Supabase services configured, use separate PowerShell windows:

```powershell
py -m http.server 5500 --bind 127.0.0.1 --directory "C:\beauty-pluz"
```

```powershell
Set-Location C:\beauty-pluz\checkout-gateway
npm run dev -- --ip 127.0.0.1 --port 8787
```

The local gateway needs its `.dev.vars` and the local Supabase settings described above. The browser gateway URL should be set to `http://127.0.0.1:8787` only for local testing.

Run the Node test suites from the repository root:

```powershell
Set-Location C:\beauty-pluz
npm test --prefix checkout-gateway
node --test checkout-gateway\tests\gateway.test.mjs backend\supabase\tests\stripe_functions.test.mjs backend\supabase\tests\storefront_checkout.test.mjs
```

Run database-backed SQL and PowerShell tests only against the local test stack after applying migrations; follow the commands and precautions in [backend/supabase/README.md](./backend/supabase/README.md). Do not run database tests against production.

## 7. Restore data that Git cannot recover

Before wiping the old computer, separately preserve any data you need from:

- The Supabase project: database rows edited since the migrations, administrator allowlist entries, orders and customer data, store settings, homepage content, and objects in Supabase Storage. These are not recovered by cloning. Use the Supabase project's authorized backup/export facilities and store exports encrypted; verify the backup before reinstalling. The migrations only provide schema and seed data, not a copy of live project contents.
- Local Supabase Docker volumes, if they contain local-only test data. The old Docker daemon was not running during inspection, so its volumes could not be listed or verified.
- `checkout-gateway/.wrangler/` only if you need its local Durable Object/emulator state. It contains local SQLite/cache/trace state and is not part of the Git clone; it is normally disposable development state.
- Any additional untracked files outside the listed Git changes. Review `git status --short --ignored` before reinstalling if you have created more local files.
- The two private environment files above, backed up securely and separately from Git.

The checked-in `images/` directory contains 46 image assets. Dynamic images uploaded to Supabase Storage are remote data and need a separate export if they must be preserved.

After restoring the Supabase project, invite the administrator through Supabase Auth and add that user's UUID to `public.beautypluz_admins` using the protected setup procedure in [backend/supabase/README.md](./backend/supabase/README.md). Do not enable public admin registration or put a service-role key in browser code.
