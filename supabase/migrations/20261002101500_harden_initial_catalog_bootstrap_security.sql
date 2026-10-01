-- Keep the initial-stock bootstrap implementation out of the exposed API
-- surface. The public RPC is an invoker wrapper; the narrowly scoped
-- implementation stays in private, matching the project's existing RPC pattern.

create schema if not exists private;

alter function public.bootstrap_initial_catalog_stock(uuid, jsonb)
  set schema private;

alter function private.bootstrap_initial_catalog_stock(uuid, jsonb)
  security definer;

alter function private.bootstrap_initial_catalog_stock(uuid, jsonb)
  set search_path = '';

revoke all on function private.bootstrap_initial_catalog_stock(uuid, jsonb) from public;
revoke all on function private.bootstrap_initial_catalog_stock(uuid, jsonb) from anon;
grant execute on function private.bootstrap_initial_catalog_stock(uuid, jsonb) to authenticated;

create or replace function public.bootstrap_initial_catalog_stock(
  p_shop_id uuid,
  p_rows jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return private.bootstrap_initial_catalog_stock(p_shop_id, p_rows);
end;
$$;

revoke all on function public.bootstrap_initial_catalog_stock(uuid, jsonb) from public;
revoke all on function public.bootstrap_initial_catalog_stock(uuid, jsonb) from anon;
grant execute on function public.bootstrap_initial_catalog_stock(uuid, jsonb) to authenticated;
