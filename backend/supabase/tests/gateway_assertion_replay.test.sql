begin;

set local role service_role;

do $test$
declare
  first_use boolean;
  replay boolean;
begin
  first_use := public.consume_guest_gateway_assertion_nonce(
    repeat('a', 64),
    now() + interval '1 minute'
  );
  replay := public.consume_guest_gateway_assertion_nonce(
    repeat('a', 64),
    now() + interval '1 minute'
  );
  if not first_use or replay then
    raise exception 'Gateway assertion nonce was not consumed exactly once';
  end if;

  begin
    perform public.consume_guest_gateway_assertion_nonce(
      repeat('b', 64),
      now() + interval '3 minutes'
    );
    raise exception 'Gateway nonce with excessive expiry was accepted';
  exception when sqlstate '22023' then
    null;
  end;
end;
$test$;

reset role;
set local role anon;

do $test$
declare
  rpc_denied boolean := false;
  table_denied boolean := false;
begin
  begin
    perform public.consume_guest_gateway_assertion_nonce(
      repeat('c', 64),
      now() + interval '1 minute'
    );
  exception when insufficient_privilege then
    rpc_denied := true;
  end;
  begin
    perform count(*) from public.guest_gateway_assertion_nonces;
  exception when insufficient_privilege then
    table_denied := true;
  end;
  if not rpc_denied or not table_denied then
    raise exception 'Anonymous access to gateway assertion state was not denied';
  end if;
end;
$test$;

rollback;
