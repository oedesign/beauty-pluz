-- Admin identities are provisioned by a trusted project operator only.
-- Authenticated clients cannot read or mutate this table.
create table if not exists public.beautypluz_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.beautypluz_admins enable row level security;
revoke all on table public.beautypluz_admins from public, anon, authenticated;

create or replace function public.is_beautypluz_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.beautypluz_admins as admins
    where admins.user_id = (select auth.uid())
  );
$function$;

revoke all on function public.is_beautypluz_admin() from public, anon;
grant execute on function public.is_beautypluz_admin() to authenticated;

create or replace function public.require_beautypluz_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not public.is_beautypluz_admin() then
    raise exception using
      errcode = '42501',
      message = 'Administrator access required';
  end if;
end;
$function$;

revoke all on function public.require_beautypluz_admin() from public, anon;
grant execute on function public.require_beautypluz_admin() to authenticated;
