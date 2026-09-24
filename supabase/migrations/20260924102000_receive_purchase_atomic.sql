-- Server-authoritative GRN receive.
-- Existing POS Purchase/GRN model remains the single source of truth.
create unique index if not exists inventory_units_shop_imei_unique
  on public.inventory_units(shop_id, lower(btrim(imei)))
  where imei is not null and btrim(imei) <> '';
create unique index if not exists inventory_units_shop_serial_unique
  on public.inventory_units(shop_id, lower(btrim(serial)))
  where serial is not null and btrim(serial) <> '';

create or replace function private.receive_purchase_atomic(
  p_shop_id uuid,
  p_purchase_id uuid,
  p_device_id text,
  p_purchase jsonb
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_uid uuid := auth.uid();
  v_purchase public.purchases%rowtype;
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty numeric;
  v_cost numeric;
  v_name text;
  v_imei text;
  v_serial text;
  v_expiry date;
  v_track_imei boolean;
  v_track_serial boolean;
  v_total numeric := 0;
  v_item_id uuid;
  v_unit_id uuid;
  v_existing jsonb;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if p_shop_id is null or p_purchase_id is null or p_purchase is null or jsonb_typeof(p_purchase) <> 'object' then
    raise exception 'Invalid GRN payload';
  end if;
  if length(btrim(coalesce(p_device_id,''))) = 0 or length(p_device_id) > 200 then
    raise exception 'Invalid device id';
  end if;

  if not exists (
    select 1 from public.shop_memberships m
    where m.shop_id=p_shop_id and m.user_id=v_uid and m.active=true
      and m.role in ('admin','manager','inventory_manager')
  ) then
    raise exception 'User is not authorized to receive GRNs';
  end if;

  if not exists (
    select 1 from public.pos_devices d
    where d.shop_id=p_shop_id::text and d.device_id=btrim(p_device_id)
      and d.user_id=v_uid and d.revoked_at is null
  ) then
    raise exception 'POS device is not registered to this user for this shop';
  end if;

  select * into v_purchase from public.purchases where id=p_purchase_id and shop_id=p_shop_id for update;
  if found then
    if v_purchase.status='received' then
      return jsonb_build_object('ok',true,'already_committed',true,'purchase_id',p_purchase_id,'status','received');
    end if;
    if v_purchase.status not in ('draft','ordered','partial') then
      raise exception 'GRN is not eligible for receiving';
    end if;
  end if;

  if jsonb_array_length(coalesce(p_purchase->'items','[]'::jsonb)) = 0 then raise exception 'GRN items are required'; end if;

  -- Validate every item before mutating any stock.
  for v_item in select * from jsonb_array_elements(p_purchase->'items') loop
    if (v_item->>'productId') is null or (v_item->>'productId') = '' then raise exception 'GRN item product is required'; end if;
    v_qty := (v_item->>'qty')::numeric;
    v_cost := (v_item->>'cost')::numeric;
    if v_qty <= 0 or v_qty <> trunc(v_qty) then raise exception 'GRN quantity must be a positive whole number'; end if;
    if v_cost < 0 or v_cost <> v_cost then raise exception 'Invalid GRN cost'; end if;
    select * into v_product from public.products where id=(v_item->>'productId')::uuid and shop_id=p_shop_id for update;
    if not found then raise exception 'GRN product does not belong to this shop'; end if;
    v_track_imei := coalesce(v_product.track_imei,false);
    v_track_serial := coalesce(v_product.track_serial,false);
    if v_track_imei or v_track_serial then
      if jsonb_array_length(coalesce(v_item->'unitIdentifiers','[]'::jsonb)) <> v_qty then
        raise exception 'Tracked GRN product must contain exactly one identifier per unit';
      end if;
      for v_existing in select * from jsonb_array_elements(coalesce(v_item->'unitIdentifiers','[]'::jsonb)) loop
        v_imei := nullif(lower(btrim(v_existing->>'imei')),'');
        v_serial := nullif(lower(btrim(v_existing->>'serial')),'');
        if v_track_imei and v_imei is null then raise exception 'IMEI is required for a tracked unit'; end if;
        if v_track_serial and v_serial is null then raise exception 'Serial number is required for a tracked unit'; end if;
        if v_imei is not null and exists(select 1 from public.inventory_units u where u.shop_id=p_shop_id and lower(btrim(u.imei))=v_imei) then raise exception 'Duplicate IMEI in shop'; end if;
        if v_serial is not null and exists(select 1 from public.inventory_units u where u.shop_id=p_shop_id and lower(btrim(u.serial))=v_serial) then raise exception 'Duplicate serial number in shop'; end if;
      end loop;
    end if;
  end loop;

  if not found then
    insert into public.purchases(id,shop_id,po_no,supplier_id,supplier_name,status,total,notes,received_at,created_by)
    values (
      p_purchase_id,p_shop_id,
      left(coalesce(p_purchase->>'poNo','GRN-'||p_purchase_id::text),100),
      nullif(p_purchase->>'supplierId','')::uuid,
      left(coalesce(p_purchase->>'supplierName',''),200),
      'received',0,left(coalesce(p_purchase->>'notes',''),1000),now(),v_uid
    ) returning * into v_purchase;
  end if;

  delete from public.purchase_items where purchase_id=p_purchase_id;
  for v_item in select * from jsonb_array_elements(p_purchase->'items') loop
    v_qty := (v_item->>'qty')::numeric;
    v_cost := (v_item->>'cost')::numeric;
    v_name := left(coalesce(v_item->>'name',''),200);
    insert into public.purchase_items(purchase_id,product_id,name,qty_ordered,qty_received,cost,expiry_date)
    values(p_purchase_id,(v_item->>'productId')::uuid,v_name,v_qty,v_qty,v_cost,nullif(v_item->>'expiryDate','')::date);
    v_total := v_total + v_qty*v_cost;

    update public.products
      set stock=stock+v_qty,cost=v_cost,updated_at=now()
      where id=(v_item->>'productId')::uuid and shop_id=p_shop_id;

    select * into v_product from public.products where id=(v_item->>'productId')::uuid and shop_id=p_shop_id;
    if v_product.track_imei or v_product.track_serial then
      for v_existing in select * from jsonb_array_elements(coalesce(v_item->'unitIdentifiers','[]'::jsonb)) loop
        v_imei := nullif(btrim(v_existing->>'imei'),'');
        v_serial := nullif(btrim(v_existing->>'serial'),'');
        v_expiry := nullif(v_item->>'expiryDate','')::date;
        v_unit_id := extensions.uuid_generate_v4();
        insert into public.inventory_units(id,shop_id,product_id,imei,serial,expiry_date,status,cost,purchase_id,warranty_months,note)
        values(v_unit_id,p_shop_id,v_product.id,v_imei,v_serial,v_expiry,'in_stock',v_cost,p_purchase_id,v_product.warranty_months,'From '||v_purchase.po_no);
      end loop;
    end if;
  end loop;

  update public.purchases
    set status='received', total=v_total, received_at=now(), created_by=coalesce(created_by,v_uid)
    where id=p_purchase_id and shop_id=p_shop_id;

  insert into public.audit_log(id,shop_id,user_id,user_email,action,entity,details)
  select extensions.uuid_generate_v4(),p_shop_id,v_uid,u.email,'PURCHASE-RECEIVE','Purchase',
         'GRN '||v_purchase.po_no||' received server-side'
  from auth.users u where u.id=v_uid;

  return jsonb_build_object('ok',true,'already_committed',false,'purchase_id',p_purchase_id,'status','received','total',v_total);
exception
  when unique_violation then
    raise exception 'A tracked IMEI or serial number is already registered in this shop';
end
$$;

create or replace function public.receive_purchase_atomic(
  p_shop_id uuid,p_purchase_id uuid,p_device_id text,p_purchase jsonb
) returns jsonb
language sql security invoker set search_path to ''
as $$ select private.receive_purchase_atomic($1,$2,$3,$4) $$;

revoke all on function private.receive_purchase_atomic(uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.receive_purchase_atomic(uuid,uuid,text,jsonb) from public,anon;
grant execute on function public.receive_purchase_atomic(uuid,uuid,text,jsonb) to authenticated;