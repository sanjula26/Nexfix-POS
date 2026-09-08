-- Harden first-shop bootstrap against concurrent first-login requests.
-- The transaction-scoped advisory lock serializes the one-time bootstrap check
-- without changing the existing shop/membership/profile/counter architecture.

create or replace function public.bootstrap_first_shop(shop_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_shop uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  -- One global lock is sufficient because bootstrap is intentionally allowed
  -- only while the database contains no shops. The lock is held only for the
  -- current transaction and is released automatically on commit/rollback.
  perform pg_advisory_xact_lock(7483921051);

  if exists (select 1 from public.shops) then
    raise exception 'Bootstrap already completed';
  end if;

  if length(trim(shop_name)) < 2 then
    raise exception 'Shop name is required';
  end if;

  insert into public.shops(name)
  values (trim(shop_name))
  returning id into new_shop;

  insert into public.shop_memberships(user_id, shop_id, role)
  values (auth.uid(), new_shop, 'admin');

  update public.profiles
  set role = 'admin', updated_at = now()
  where id = auth.uid();

  insert into public.counters(shop_id)
  values (new_shop);

  return new_shop;
end;
$$;

revoke all on function public.bootstrap_first_shop(text) from public;
grant execute on function public.bootstrap_first_shop(text) to authenticated;
