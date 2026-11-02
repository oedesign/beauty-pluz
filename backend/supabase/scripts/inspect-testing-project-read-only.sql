-- READ-ONLY pre-migration inspection for Beauty Pluz Testing.
-- Before running: open the Supabase SQL Editor for project
-- nchoghcxcisxzflyrqcy and verify that project reference in the dashboard.
-- Do not run these queries in the production project.
-- All executable statements are SELECT-only and make no database changes.
--
-- Run each query separately in the SQL Editor. The migration-history and
-- Storage data queries below must only be run when their table-existence
-- checks return true. An absent optional table cannot be safely queried by a
-- static SELECT; skip that query and report the table as absent.

-- 1a. Migration history table presence.
select
  pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null
    as migration_history_table_exists;

-- 1b. Applied migration versions.
-- Run only if 1a returns true. An empty table safely returns zero rows.
select version
from supabase_migrations.schema_migrations
order by version;

-- 2. Required public tables.
select
  expected.table_name,
  tables.relname is not null as table_exists
from (
  values
    ('products'),
    ('orders'),
    ('order_items'),
    ('storefront_content'),
    ('store_settings'),
    ('order_status_history'),
    ('checkout_settings'),
    ('order_inventory_reservations'),
    ('checkout_request_limits'),
    ('checkout_delivery_zones'),
    ('checkout_delivery_destinations'),
    ('sumup_checkout_sessions')
) as expected(table_name)
left join pg_catalog.pg_namespace as namespaces
  on namespaces.nspname = 'public'
left join pg_catalog.pg_class as tables
  on tables.relnamespace = namespaces.oid
 and tables.relname = expected.table_name
 and tables.relkind in ('r', 'p')
order by expected.table_name;

-- 3. Required public functions and their existing argument signatures.
select
  expected.function_name,
  coalesce(
    array_agg(
      pg_catalog.pg_get_function_identity_arguments(functions.oid)
      order by pg_catalog.pg_get_function_identity_arguments(functions.oid)
    ) filter (where functions.oid is not null),
    array[]::text[]
  ) as existing_signatures,
  count(functions.oid) > 0 as function_exists
from (
  values
    ('get_published_store_settings'),
    ('get_published_homepage_content'),
    ('create_checkout_order'),
    ('claim_sumup_checkout'),
    ('save_sumup_checkout'),
    ('record_sumup_checkout_verification')
) as expected(function_name)
left join pg_catalog.pg_namespace as namespaces
  on namespaces.nspname = 'public'
left join pg_catalog.pg_proc as functions
  on functions.pronamespace = namespaces.oid
 and functions.proname = expected.function_name
group by expected.function_name
order by expected.function_name;

-- 4a. Supabase Storage bucket table presence.
select
  pg_catalog.to_regclass('storage.buckets') is not null
    as storage_buckets_table_exists;

-- 4b. Required bucket presence.
-- Run only if 4a returns true.
select
  expected.bucket_id,
  buckets.id is not null as bucket_exists
from (
  values
    ('product-images'),
    ('homepage-images'),
    ('store-assets')
) as expected(bucket_id)
left join storage.buckets as buckets
  on buckets.id = expected.bucket_id
order by expected.bucket_id;

-- 5. Installed PostgreSQL extensions, including pgcrypto when present.
select
  extensions.extname as extension_name,
  extensions.extversion as extension_version,
  namespaces.nspname as installed_schema
from pg_catalog.pg_extension as extensions
join pg_catalog.pg_namespace as namespaces
  on namespaces.oid = extensions.extnamespace
order by extensions.extname;
