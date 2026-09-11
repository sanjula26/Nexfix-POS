-- The first-shop bootstrap needs elevated database privileges to create the
-- shop, membership and counter before normal RLS membership exists. Keep the
-- privileged implementation private and expose only an invoker wrapper.

create schema if not exists private;

alter function public.bootstrap_first_shop(text) set schema private;
alter function private.bootstrap_first_shop(text) set search_path = '';

create or replace function public.bootstrap_first_shop(shop_name text)
returns uuid
language sql
security invoker
set search_path to ''
as $$
  select private.bootstrap_first_shop(shop_name);
$$;

revoke all on function public.bootstrap_first_shop(text) from public, anon;
grant execute on function public.bootstrap_first_shop(text) to authenticated;
grant execute on function private.bootstrap_first_shop(text) to authenticated;
