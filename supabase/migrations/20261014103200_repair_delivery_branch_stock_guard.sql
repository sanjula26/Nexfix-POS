-- Keep repair part consumption branch-aware in multi-branch shops.
-- A repair is attributed to the currently assigned device branch because the
-- existing repairs schema has no historical branch_id. Single-branch behavior
-- remains unchanged.
CREATE OR REPLACE FUNCTION private.process_repair_delivery_atomic(p_shop_id uuid, p_repair_id uuid, p_device_id text, p_repair jsonb)
 RETURNS TABLE(ok boolean, already_committed boolean, repair_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_repair public.repairs;
  v_part jsonb;
  v_product public.products;
  v_qty numeric;
  v_existing_parts_deducted timestamptz;
  v_active_branch_count integer := 1;
  v_branch_id uuid;
  v_branch_qty numeric;
  v_total_stock numeric;
  v_now timestamptz := now();
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if p_shop_id is null or p_repair_id is null or coalesce(trim(p_device_id),'')='' then raise exception 'Missing repair identifiers'; end if;
  if not exists(select 1 from public.shop_memberships sm where sm.shop_id=p_shop_id and sm.user_id=v_uid and sm.active=true) then
    raise exception 'Shop membership required';
  end if;
  select role into v_role from public.shop_memberships where shop_id=p_shop_id and user_id=v_uid and active=true limit 1;
  if v_role not in ('admin','manager','inventory_manager','technician') then raise exception 'Repair delivery permission denied'; end if;
  if not exists(select 1 from public.pos_devices d where d.shop_id=p_shop_id::text and d.device_id=btrim(p_device_id) and d.user_id=v_uid and d.revoked_at is null) then
    raise exception 'Registered active POS device required';
  end if;

  -- Repair parts have no historical branch column. For a multi-branch shop,
  -- consume stock only from the currently assigned device branch, and fail
  -- closed if the device has no valid assignment.
  select count(*) into v_active_branch_count from public.branches b where b.shop_id=p_shop_id and b.active;
  if v_active_branch_count > 1 then
    select pb.branch_id into v_branch_id
    from public.pos_device_branches pb
    join public.branches b on b.id=pb.branch_id and b.shop_id=pb.shop_id and b.active
    where pb.shop_id=p_shop_id and pb.device_id=btrim(p_device_id)
    limit 1;
    if v_branch_id is null then
      raise exception 'This POS device is not assigned to an active branch; repair parts were not deducted';
    end if;
  end if;

  select * into v_repair from public.repairs where id=p_repair_id and shop_id=p_shop_id for update;
  if found and v_repair.parts_deducted_at is not null then
    return query select true,true,p_repair_id;
    return;
  end if;

  if coalesce(p_repair->>'status','') <> 'delivered' then raise exception 'Repair must be delivered'; end if;
  if not found then
    insert into public.repairs(
      id,shop_id,job_no,customer_id,customer_name,customer_phone,device_type,device_brand,device_model,
      imei,serial,fault,diagnosis,labor_cost,status,received_at,promised_at,completed_at,delivered_at,
      technician_id,technician_name,warranty_days,advance_paid,notes,created_by,created_at,parts_deducted_at
    ) values (
      p_repair_id,p_shop_id,nullif(p_repair->>'jobNo',''),nullif(p_repair->>'customerId','')::uuid,
      coalesce(p_repair->>'customerName',''),coalesce(p_repair->>'customerPhone',''),coalesce(p_repair->>'deviceType',''),
      coalesce(p_repair->>'deviceBrand',''),coalesce(p_repair->>'deviceModel',''),nullif(p_repair->>'imei',''),
      nullif(p_repair->>'serial',''),coalesce(p_repair->>'fault',''),coalesce(p_repair->>'diagnosis',''),
      coalesce((p_repair->>'laborCost')::numeric,0),'delivered',nullif(p_repair->>'receivedAt','')::timestamptz,
      nullif(p_repair->>'promisedAt','')::timestamptz,nullif(p_repair->>'completedAt','')::timestamptz,
      nullif(p_repair->>'deliveredAt','')::timestamptz,nullif(p_repair->>'technicianId','')::uuid,
      coalesce(p_repair->>'technicianName',''),coalesce((p_repair->>'warrantyDays')::integer,0),
      coalesce((p_repair->>'advancePaid')::numeric,0),nullif(p_repair->>'notes',''),v_uid,
      coalesce(nullif(p_repair->>'createdAt','')::timestamptz,v_now),v_now
    ) returning * into v_repair;
  else
    update public.repairs set status='delivered',
      completed_at=coalesce(completed_at,nullif(p_repair->>'completedAt','')::timestamptz),
      delivered_at=coalesce(delivered_at,nullif(p_repair->>'deliveredAt','')::timestamptz),
      parts_deducted_at=v_now
    where id=p_repair_id and shop_id=p_shop_id
    returning * into v_repair;
  end if;

  for v_part in select value from jsonb_array_elements(coalesce(p_repair->'parts','[]'::jsonb))
  loop
    if nullif(v_part->>'productId','') is null then continue; end if;
    v_qty := (v_part->>'qty')::numeric;
    if v_qty <= 0 then raise exception 'Invalid repair part quantity'; end if;
    select * into v_product from public.products where id=(v_part->>'productId')::uuid and shop_id=p_shop_id for update;
    if not found or v_product.track_imei or v_product.track_serial then
      raise exception 'Invalid repair part product';
    end if;
    if v_active_branch_count > 1 then
      select bs.qty into v_branch_qty
      from public.branch_stock bs
      where bs.shop_id=p_shop_id and bs.branch_id=v_branch_id and bs.product_id=v_product.id
      for update;
      if not found or v_branch_qty < v_qty then
        raise exception 'Insufficient repair part stock at the assigned branch';
      end if;
      update public.branch_stock set qty=qty-v_qty,updated_at=v_now
      where shop_id=p_shop_id and branch_id=v_branch_id and product_id=v_product.id;
      select coalesce(sum(bs.qty),0) into v_total_stock
      from public.branch_stock bs
      join public.branches b on b.id=bs.branch_id and b.shop_id=bs.shop_id and b.active
      where bs.shop_id=p_shop_id and bs.product_id=v_product.id;
      update public.products set stock=v_total_stock,updated_at=v_now where id=v_product.id and shop_id=p_shop_id;
    else
      if v_product.stock < v_qty then raise exception 'Insufficient repair part stock'; end if;
      update public.products set stock=stock-v_qty,updated_at=v_now where id=v_product.id and shop_id=p_shop_id;
    end if;
  end loop;

  delete from public.repair_parts where repair_id=p_repair_id;
  insert into public.repair_parts(id,repair_id,product_id,name,qty,cost)
  select coalesce(nullif(x->>'id','')::uuid,gen_random_uuid()),p_repair_id,nullif(x->>'productId','')::uuid,
         coalesce(x->>'name',''),coalesce((x->>'qty')::numeric,0),coalesce((x->>'cost')::numeric,0)
  from jsonb_array_elements(coalesce(p_repair->'parts','[]'::jsonb)) x;

  update public.repairs set parts_deducted_at=v_now,status='delivered',delivered_at=coalesce(delivered_at,v_now) where id=p_repair_id and shop_id=p_shop_id;
  return query select true,false,p_repair_id;
exception when unique_violation then
  select parts_deducted_at into v_existing_parts_deducted from public.repairs where id=p_repair_id and shop_id=p_shop_id;
  if v_existing_parts_deducted is not null then return query select true,true,p_repair_id; else raise; end if;
end;
$function$;
