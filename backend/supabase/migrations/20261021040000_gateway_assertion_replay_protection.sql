begin;

create table public.guest_gateway_assertion_nonces (
  nonce_hash text primary key check (nonce_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.guest_gateway_assertion_nonces enable row level security;
revoke all on public.guest_gateway_assertion_nonces from public, anon, authenticated;
create index guest_gateway_assertion_nonces_expiry_idx
  on public.guest_gateway_assertion_nonces (expires_at);

create function public.consume_guest_gateway_assertion_nonce(
  p_nonce_hash text,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_nonce_hash !~ '^[0-9a-f]{64}$'
     or p_expires_at is null
     or p_expires_at <= now()
     or p_expires_at > now() + interval '2 minutes' then
    raise exception using errcode = '22023', message = 'Invalid gateway assertion nonce';
  end if;

  delete from public.guest_gateway_assertion_nonces
  where expires_at <= now();

  insert into public.guest_gateway_assertion_nonces (nonce_hash, expires_at)
  values (p_nonce_hash, p_expires_at)
  on conflict (nonce_hash) do nothing;

  return found;
end;
$function$;

revoke all on function public.consume_guest_gateway_assertion_nonce(text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.consume_guest_gateway_assertion_nonce(text, timestamptz)
  to service_role;

commit;
