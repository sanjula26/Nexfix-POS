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
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_product public.products%rowtype;
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
  select * into v_product from public.products
   where id=p_product_id and shop_id=p_shop_id and active=true for update;
  if not found then raise exception 'Trade-in product not found'; end if;
  if not v_product.track_imei and not v_product.track_serial then
    raise exception 'Trade-in product must track IMEI or serial';
  end if;
  if v_product.track_imei and nullif(trim(coalesce(p_imei,'')),'') is null then raise exception 'Trade-in IMEI required'; end if;
  if v_product.track_serial and nullif(trim(coalesce(p_serial,'')),'') is null then raise exception 'Trade-in serial required'; end if;
  if nullif(trim(coalesce(p_imei,'')),'') is not null and exists (
    select 1 from public.inventory_units where shop_id=p_shop_id and imei=trim(p_imei) and status='in_stock'
  ) then raise exception 'Trade-in IMEI already exists'; end if;
  if nullif(trim(coalesce(p_serial,'')),'') is not null and exists (
    select 1 from public.inventory_units where shop_id=p_shop_id and serial=trim(p_serial) and status='in_stock'
  ) then raise exception 'Trade-in serial already exists'; end if;
  if exists (select 1 from public.inventory_units where id=p_unit_id and shop_id=p_shop_id) then
    return jsonb_build_object('ok',true,'already_committed',true,'unit_id',p_unit_id);
  end if;
  if not exists (select 1 from public.sales where id=p_sale_id and shop_id=p_shop_id) then
    raise exception 'Sale not found';
  end if;
  insert into public.inventory_units(
    id,shop_id,product_id,imei,serial,status,cost,sale_id,note,created_at
  ) values (
    p_unit_id,p_shop_id,p_product_id,nullif(trim(p_imei),''),nullif(trim(p_serial),''),
    'in_stock',p_value,p_sale_id,'Trade-in',now()
  );
  update public.products set stock=coalesce(stock,0)+1,updated_at=now()
   where id=p_product_id and shop_id=p_shop_id;
  return jsonb_build_object('ok',true,'already_committed',false,'unit_id',p_unit_id);
end;
$function$;

create or replace function public.register_trade_in_atomic(
  p_shop_id uuid,
  p_sale_id uuid,
  p_unit_id uuid,
  p_product_id uuid,
  p_value numeric,
  p_imei text default null,
  p_serial text default null
)
returns jsonb
language sql
security invoker
set search_path = ''
as $wrapper$
  select private.register_trade_in_atomic(
    p_shop_id, p_sale_id, p_unit_id, p_product_id, p_value, p_imei, p_serial
  );
$wrapper$;

revoke all on function public.register_trade_in_atomic(uuid,uuid,uuid,uuid,numeric,text,text) from public, anon;
grant execute on function public.register_trade_in_atomic(uuid,uuid,uuid,uuid,numeric,text,text) to authenticated;
revoke all on function private.register_trade_in_atomic(uuid,uuid,uuid,uuid,numeric,text,text) from public, anon, authenticated;
