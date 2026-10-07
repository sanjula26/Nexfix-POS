-- Keep the API wrapper SECURITY INVOKER. The private resolver is the only
-- privileged implementation and already validates auth.uid(), shop membership,
-- sale ownership/status and return quantities before doing any work.
revoke all on function private.resolve_sale_return_items(uuid,uuid,jsonb) from public, anon;
grant execute on function private.resolve_sale_return_items(uuid,uuid,jsonb) to authenticated;

create or replace function public.resolve_sale_return_items(
  p_shop_id uuid,
  p_sale_id uuid,
  p_lines jsonb
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.resolve_sale_return_items(p_shop_id, p_sale_id, p_lines);
$$;

revoke all on function public.resolve_sale_return_items(uuid,uuid,jsonb) from public, anon;
grant execute on function public.resolve_sale_return_items(uuid,uuid,jsonb) to authenticated;
