-- Bootstrap the initial full-shop stock into the normalized cloud catalog exactly once.
--
-- Initial POS stock is entered locally before later purchases move through GRN.
-- Existing cloud stock must remain authoritative after any cloud sale, purchase,
-- or tracked-unit activity. This RPC therefore refuses to change stock once the
-- normalized cloud catalog has transaction history.

create or replace function public.bootstrap_initial_catalog_stock(
  p_shop_id uuid,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_sales bigint;
  v_purchases bigint;
  v_units bigint;
  v_updated integer := 0;
  v_row jsonb;
  v_product_id uuid;
  v_stock numeric;
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;

  if p_shop_id is null then
    raise exception 'Shop is required';
  end if;

  select m.role
    into v_role
  from public.shop_memberships m
  where m.shop_id = p_shop_id
    and m.user_id = v_uid
    and m.active = true;

  if v_role is null or v_role not in ('admin', 'manager') then
    raise exception 'Initial stock bootstrap requires admin or manager access';
  end if;

  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'Initial stock rows must be an array';
  end if;

  select count(*) into v_sales
  from public.sales
  where shop_id = p_shop_id;

  select count(*) into v_purchases
  from public.purchases
  where shop_id = p_shop_id;

  select count(*) into v_units
  from public.inventory_units
  where shop_id = p_shop_id;

  -- Once the normalized catalog has any transactional or tracked-unit
  -- history, never overwrite its stock from a local snapshot.
  if v_sales > 0 or v_purchases > 0 or v_units > 0 then
    return jsonb_build_object(
      'ok', true,
      'bootstrapped', false,
      'reason', 'cloud_catalog_already_initialized',
      'updated', 0
    );
  end if;

  for v_row in
    select value from jsonb_array_elements(p_rows)
  loop
    begin
      v_product_id := nullif(v_row->>'product_id', '')::uuid;
      v_stock := (v_row->>'stock')::numeric;
    exception when others then
      continue;
    end;

    if v_product_id is null or v_stock is null or v_stock < 0 then
      continue;
    end if;

    update public.products
       set stock = round(v_stock, 2),
           updated_at = now()
     where id = v_product_id
       and shop_id = p_shop_id;

    if found then
      v_updated := v_updated + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'bootstrapped', v_updated > 0,
    'updated', v_updated
  );
end;
$$;

revoke all on function public.bootstrap_initial_catalog_stock(uuid, jsonb) from public;
revoke all on function public.bootstrap_initial_catalog_stock(uuid, jsonb) from anon;
grant execute on function public.bootstrap_initial_catalog_stock(uuid, jsonb) to authenticated;
