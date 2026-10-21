revoke all on function public.reserve_stock_for_order(uuid, text, integer, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.confirm_stock_reservation(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.release_unpaid_stock_reservation(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.get_pending_checkout_session(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.set_product_stock_quantity(text, integer)
  from service_role;
