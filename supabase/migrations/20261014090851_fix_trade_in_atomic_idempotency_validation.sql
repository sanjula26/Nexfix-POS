-- Idempotent trade-in retries must not silently accept a reused unit id
-- carrying a different product, IMEI/serial, value, sale, or branch.
create or replace function private.register_trade_in_atomic(
  p_shop_id uuid,
  p_sale_id uuid,
  p_unit_id uuid,
  p_product_id uuid,
  p_value numeric,
  p_imei text default null,
  p_serial text default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_product public.products%rowtype;
  v_sale public.sales%rowtype;
  v_existing public.inventory_units%rowtype;
  v_branch_id uuid;
  v_stock_branch_id uuid;
  v_branch_qty numeric;
  v_total_qty numeric;
  v_imei text := nullif(trim(coalesce(p_imei,'')),'');
  v_serial text := nullif(trim(coalesce(p_serial,'')),'');
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  select role into v_role from public.shop_memberships
   where shop_id=p_shop_id and user_id=v_uid and active=true limit 1;
  if v_role is null or v_role not in ('admin','manager','cashier') then
    raise exception 'Active shop membership required';
  end if;
  if p_shop_id is null or p_sale_id is null or p_unit_id is null or p_product_id is null or p_value is null or p_value <= 0 then
    raise exception 'Invalid trade-in data';
  end if;

  select * into v_sale from public.sales
   where id=p_sale_id and shop_id=p_shop_id for update;
  if not found then raise exception 'Sale not found'; end if;
  v_branch_id := coalesce(v_sale.branch_id,(select b.id from public.branches b where b.shop_id=p_shop_id and b.is_default limit 1));
  if v_branch_id is null then raise exception 'Sale branch is not configured'; end if;

  -- Reuse an existing unit only when the full stable identity matches. Status
  -- is intentionally not compared: the trade-in may have been sold later.
  select * into v_existing from public.inventory_units
   where id=p_unit_id and shop_id=p_shop_id for update;
  if found then
    if v_existing.sale_id is not distinct from p_sale_id
       and v_existing.product_id is not distinct from p_product_id
       and v_existing.imei is not distinct from v_imei
       and v_existing.serial is not distinct from v_serial
       and v_existing.cost is not distinct from p_value
       and v_existing.branch_id is not distinct from v_branch_id then
      return jsonb_build_object('ok',true,'already_committed',true,'unit_id',p_unit_id);
    end if;
    raise exception 'Trade-in unit id already exists with different sale, product, identity, value, or branch data';
  end if;

  select * into v_product from public.products
   where id=p_product_id and shop_id=p_shop_id and active=true for update;
  if not found then raise exception 'Trade-in product not found'; end if;
  if not v_product.track_imei and not v_product.track_serial then
    raise exception 'Trade-in product must track IMEI or serial';
  end if;
  if v_product.track_imei and v_imei is null then raise exception 'Trade-in IMEI required'; end if;
  if v_product.track_serial and v_serial is null then raise exception 'Trade-in serial required'; end if;

  if v_imei is not null and exists (
    select 1 from public.inventory_units where shop_id=p_shop_id and imei=v_imei and status='in_stock'
  ) then raise exception 'Trade-in IMEI already exists'; end if;
  if v_serial is not null and exists (
    select 1 from public.inventory_units where shop_id=p_shop_id and serial=v_serial and status='in_stock'
  ) then raise exception 'Trade-in serial already exists'; end if;

  insert into public.inventory_units(id,shop_id,product_id,imei,serial,status,cost,sale_id,note,created_at,branch_id)
  values(p_unit_id,p_shop_id,p_product_id,v_imei,v_serial,'in_stock',p_value,p_sale_id,'Trade-in',now(),v_branch_id);
  update public.products set stock=coalesce(stock,0)+1,updated_at=now() where id=p_product_id and shop_id=p_shop_id;
  for v_stock_branch_id in select b.id from public.branches b where b.shop_id=p_shop_id loop
    select count(*)::numeric into v_branch_qty from public.inventory_units iu where iu.shop_id=p_shop_id and iu.product_id=p_product_id and iu.branch_id=v_stock_branch_id and iu.status='in_stock';
    insert into public.branch_stock(shop_id,branch_id,product_id,qty,updated_at) values(p_shop_id,v_stock_branch_id,p_product_id,v_branch_qty,now()) on conflict(branch_id,product_id) do update set qty=excluded.qty,updated_at=now();
  end loop;
  select coalesce(sum(bs.qty),0) into v_total_qty from public.branch_stock bs where bs.shop_id=p_shop_id and bs.product_id=p_product_id;
  update public.products set stock=v_total_qty,updated_at=now() where id=p_product_id and shop_id=p_shop_id;
  return jsonb_build_object('ok',true,'already_committed',false,'unit_id',p_unit_id);
end;
$function$;
