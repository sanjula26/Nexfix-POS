-- The public RPC wrapper must execute the private SECURITY DEFINER resolver
-- with its own privileges. The resolver itself performs auth.uid() and shop-membership
-- checks, so callers never receive an authorization bypass.
create or replace function public.resolve_sale_return_items(
  p_shop_id uuid,
  p_sale_id uuid,
  p_lines jsonb
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.resolve_sale_return_items(p_shop_id, p_sale_id, p_lines);
$$;

revoke all on function public.resolve_sale_return_items(uuid,uuid,jsonb) from public, anon;
grant execute on function public.resolve_sale_return_items(uuid,uuid,jsonb) to authenticated;
