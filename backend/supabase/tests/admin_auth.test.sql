begin;

set local role anon;

do $test$
begin
  if public.is_beautypluz_admin() then
    raise exception 'Unauthenticated role was treated as an admin';
  end if;

  begin
    perform public.require_beautypluz_admin();
  exception
    when insufficient_privilege then
      return;
  end;

  raise exception 'Unauthenticated role passed the admin guard';
end;
$test$;

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000001',
  true
);

do $test$
begin
  if public.is_beautypluz_admin() then
    raise exception 'Unprovisioned authenticated user was treated as an admin';
  end if;

  begin
    perform public.require_beautypluz_admin();
  exception
    when insufficient_privilege then
      return;
  end;

  raise exception 'Unprovisioned authenticated user passed the admin guard';
end;
$test$;

rollback;
