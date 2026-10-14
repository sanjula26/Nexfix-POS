-- Multi-branch transaction RPCs must bind the branch to a live device registered to the authenticated shop member.
-- Single-branch behavior remains unchanged.

CREATE OR REPLACE FUNCTION public.add_inventory_units_atomic(p_shop_id uuid, p_branch_id uuid, p_device_id text, p_units jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_active_branches integer;
  v_binding uuid;
  v_unit jsonb;
  v_unit_id uuid;
  v_product_id uuid;
  v_product public.products%rowtype;
  v_existing public.inventory_units%rowtype;
  v_imei text;
  v_serial text;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_reconciled integer := 0;
  v_branch_qty numeric;
  v_expected_branch_qty numeric;
  v_total_qty numeric;
  v_product_ids uuid[] := '{}'::uuid[];
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT m.role INTO v_role
  FROM public.shop_memberships m
  WHERE m.shop_id=p_shop_id AND m.user_id=v_uid AND m.active;
  IF v_role IS NULL OR v_role NOT IN ('admin','manager') THEN
    RAISE EXCEPTION 'Adding tracked inventory requires admin or manager permission';
  END IF;
  IF p_shop_id IS NULL OR p_branch_id IS NULL THEN RAISE EXCEPTION 'Shop and branch are required'; END IF;
  IF jsonb_typeof(coalesce(p_units,'null'::jsonb)) <> 'array'
     OR jsonb_array_length(coalesce(p_units,'[]'::jsonb)) < 1
     OR jsonb_array_length(coalesce(p_units,'[]'::jsonb)) > 500 THEN
    RAISE EXCEPTION 'Provide between 1 and 500 inventory units';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.branches b
    WHERE b.id=p_branch_id AND b.shop_id=p_shop_id AND b.active
  ) THEN RAISE EXCEPTION 'Selected branch is unavailable'; END IF;

  SELECT count(*) INTO v_active_branches FROM public.branches b
  WHERE b.shop_id=p_shop_id AND b.active;
  IF v_active_branches > 1 THEN
    if not exists (
      select 1 from public.pos_devices pd
      where pd.shop_id=p_shop_id::text
        and pd.device_id=btrim(coalesce(p_device_id,''))
        and pd.user_id=auth.uid()
        and pd.revoked_at is null
    ) then
      raise exception 'POS device is not registered to this user for this shop';
    end if;
    SELECT d.branch_id INTO v_binding
    FROM public.pos_device_branches d
    WHERE d.shop_id=p_shop_id AND d.device_id=btrim(coalesce(p_device_id,'')) LIMIT 1;
    IF v_binding IS NULL OR v_binding<>p_branch_id THEN
      RAISE EXCEPTION 'This POS device is not assigned to the selected branch';
    END IF;
  END IF;

  -- Lock product rows in a stable order before processing IDs, avoiding
  -- deadlocks when two devices submit batches containing overlapping products.
  PERFORM 1
  FROM public.products p
  JOIN (
    SELECT DISTINCT (value->>'product_id')::uuid AS product_id
    FROM jsonb_array_elements(p_units)
  ) requested ON requested.product_id=p.id
  WHERE p.shop_id=p_shop_id
  ORDER BY p.id
  FOR UPDATE OF p;

  FOR v_unit IN SELECT value FROM jsonb_array_elements(p_units) LOOP
    v_unit_id := nullif(v_unit->>'id','')::uuid;
    v_product_id := nullif(v_unit->>'product_id','')::uuid;
    v_imei := nullif(btrim(coalesce(v_unit->>'imei','')),'');
    v_serial := nullif(btrim(coalesce(v_unit->>'serial','')),'');
    IF v_unit_id IS NULL OR v_product_id IS NULL THEN RAISE EXCEPTION 'Unit and product IDs are required'; END IF;
    IF coalesce(v_unit->>'status','in_stock') <> 'in_stock' THEN RAISE EXCEPTION 'Only in-stock units can be added or identified'; END IF;

    SELECT * INTO v_product FROM public.products p
    WHERE p.id=v_product_id AND p.shop_id=p_shop_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unit product does not belong to this shop'; END IF;
    IF NOT coalesce(v_product.track_imei,false) AND NOT coalesce(v_product.track_serial,false) THEN
      RAISE EXCEPTION 'Product is not configured for IMEI/serial tracking';
    END IF;
    IF coalesce(v_product.track_imei,false) AND v_imei IS NULL THEN RAISE EXCEPTION 'IMEI is required'; END IF;
    IF coalesce(v_product.track_serial,false) AND v_serial IS NULL THEN RAISE EXCEPTION 'Serial is required'; END IF;
    IF NOT coalesce(v_product.track_imei,false) AND v_imei IS NOT NULL THEN RAISE EXCEPTION 'IMEI is not enabled for this product'; END IF;
    IF NOT coalesce(v_product.track_serial,false) AND v_serial IS NOT NULL THEN RAISE EXCEPTION 'Serial is not enabled for this product'; END IF;

    SELECT * INTO v_existing FROM public.inventory_units iu WHERE iu.id=v_unit_id FOR UPDATE;
    IF FOUND THEN
      IF v_existing.shop_id<>p_shop_id OR v_existing.product_id<>v_product_id
         OR v_existing.branch_id<>p_branch_id OR v_existing.status<>'in_stock' THEN
        RAISE EXCEPTION 'Unit ID belongs to another shop, product, branch or status';
      END IF;
      IF (v_existing.imei IS NOT NULL AND lower(btrim(v_existing.imei))<>lower(v_imei))
         OR (v_existing.serial IS NOT NULL AND lower(btrim(v_existing.serial))<>lower(v_serial)) THEN
        RAISE EXCEPTION 'Existing IMEI/serial cannot be reassigned';
      END IF;
      IF (v_existing.imei IS NULL AND v_imei IS NOT NULL)
         OR (v_existing.serial IS NULL AND v_serial IS NOT NULL) THEN
        UPDATE public.inventory_units
        SET imei=coalesce(imei,v_imei),
            serial=coalesce(serial,v_serial),
            note=coalesce(nullif(v_unit->>'note',''),note)
        WHERE id=v_unit_id AND shop_id=p_shop_id;
        v_updated := v_updated+1;
      END IF;
    ELSE
      IF EXISTS (
        SELECT 1 FROM public.inventory_units iu
        WHERE iu.shop_id=p_shop_id
          AND ((v_imei IS NOT NULL AND lower(btrim(iu.imei))=lower(v_imei))
            OR (v_serial IS NOT NULL AND lower(btrim(iu.serial))=lower(v_serial)))
      ) THEN RAISE EXCEPTION 'Duplicate IMEI/serial is already registered in this shop'; END IF;

      INSERT INTO public.inventory_units(
        id,shop_id,product_id,imei,serial,expiry_date,status,cost,purchase_id,
        sale_id,sale_bill_no,warranty_months,warranty_expires_at,note,created_at,sold_at,branch_id
      ) VALUES (
        v_unit_id,p_shop_id,v_product_id,v_imei,v_serial,
        nullif(v_unit->>'expiry_date','')::date,'in_stock',
        nullif(v_unit->>'cost','')::numeric,nullif(v_unit->>'purchase_id','')::uuid,
        nullif(v_unit->>'sale_id','')::uuid,nullif(v_unit->>'sale_bill_no',''),
        nullif(v_unit->>'warranty_months','')::integer,
        nullif(v_unit->>'warranty_expires_at','')::date,
        nullif(v_unit->>'note',''),
        coalesce(nullif(v_unit->>'created_at','')::timestamptz,now()),
        nullif(v_unit->>'sold_at','')::timestamptz,p_branch_id
      );
      v_inserted := v_inserted+1;
    END IF;
    IF NOT (v_product_id=ANY(v_product_ids)) THEN v_product_ids := array_append(v_product_ids,v_product_id); END IF;
  END LOOP;

  -- Reconcile tracked-product quantities to the actual in-stock unit count.
  -- This also repairs older unit rows that were uploaded without their branch stock.
  FOREACH v_product_id IN ARRAY v_product_ids LOOP
    SELECT * INTO v_product FROM public.products p
    WHERE p.id=v_product_id AND p.shop_id=p_shop_id FOR UPDATE;
    SELECT count(*)::numeric INTO v_expected_branch_qty
    FROM public.inventory_units iu
    WHERE iu.shop_id=p_shop_id AND iu.product_id=v_product_id
      AND iu.branch_id=p_branch_id AND iu.status='in_stock';

    INSERT INTO public.branch_stock(shop_id,branch_id,product_id,qty,updated_at)
    VALUES(p_shop_id,p_branch_id,v_product_id,v_expected_branch_qty,now())
    ON CONFLICT(branch_id,product_id) DO UPDATE
      SET qty=excluded.qty,updated_at=now()
      WHERE public.branch_stock.qty IS DISTINCT FROM excluded.qty;

    SELECT coalesce(sum(bs.qty),0) INTO v_total_qty
    FROM public.branch_stock bs
    WHERE bs.shop_id=p_shop_id AND bs.product_id=v_product_id;
    IF v_product.stock IS DISTINCT FROM v_total_qty THEN
      UPDATE public.products SET stock=v_total_qty,updated_at=now()
      WHERE id=v_product_id AND shop_id=p_shop_id;
      v_reconciled := v_reconciled+1;
    END IF;
  END LOOP;

  IF v_inserted>0 OR v_updated>0 OR v_reconciled>0 THEN
    INSERT INTO public.audit_log(shop_id,user_id,action,entity,details)
    VALUES(p_shop_id,v_uid,'UNIT_STOCK_SYNC','InventoryUnit',
      format('Branch %s: inserted %s unit(s), identified %s placeholder unit(s), reconciled %s tracked product total(s)',
        p_branch_id,v_inserted,v_updated,v_reconciled));
  END IF;
  RETURN jsonb_build_object('ok',true,'inserted',v_inserted,'updated',v_updated,'reconciled_products',v_reconciled);
END;
$function$;

CREATE OR REPLACE FUNCTION public.adjust_branch_stock_atomic(p_shop_id uuid, p_branch_id uuid, p_device_id text, p_product_id uuid, p_delta numeric, p_note text, p_adjustment_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid:=auth.uid();
  v_role text;
  v_branch_count integer;
  v_binding uuid;
  v_existing public.branch_stock_adjustments%rowtype;
  v_branch_qty numeric;
  v_product_stock numeric;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  select m.role into v_role from public.shop_memberships m
  where m.shop_id=p_shop_id and m.user_id=v_uid and m.active;
  if v_role is null or v_role not in ('admin','manager') then raise exception 'Stock adjustment requires admin or manager permission'; end if;
  if p_delta is null or p_delta=0 or abs(p_delta)>1000000 then raise exception 'Invalid stock adjustment quantity'; end if;
  if p_adjustment_id is null or p_product_id is null then raise exception 'Adjustment and product ids are required'; end if;
  if not exists(select 1 from public.branches b where b.id=p_branch_id and b.shop_id=p_shop_id and b.active) then raise exception 'Selected branch is unavailable'; end if;
  select count(*) into v_branch_count from public.branches b where b.shop_id=p_shop_id and b.active;
  if v_branch_count>1 then
    if not exists (
      select 1 from public.pos_devices pd
      where pd.shop_id=p_shop_id::text
        and pd.device_id=btrim(coalesce(p_device_id,''))
        and pd.user_id=auth.uid()
        and pd.revoked_at is null
    ) then
      raise exception 'POS device is not registered to this user for this shop';
    end if;
    select d.branch_id into v_binding from public.pos_device_branches d
    where d.shop_id=p_shop_id and d.device_id=btrim(coalesce(p_device_id,'')) limit 1;
    if v_binding is null or v_binding<>p_branch_id then raise exception 'This POS device is not assigned to the selected branch'; end if;
  end if;
  perform pg_advisory_xact_lock(hashtext(p_adjustment_id::text));
  select * into v_existing from public.branch_stock_adjustments a where a.id=p_adjustment_id;
  if found then
    if v_existing.shop_id<>p_shop_id or v_existing.branch_id<>p_branch_id or v_existing.product_id<>p_product_id or v_existing.delta<>p_delta then
      raise exception 'Adjustment idempotency key was reused with different data';
    end if;
    select bs.qty into v_branch_qty from public.branch_stock bs where bs.shop_id=p_shop_id and bs.branch_id=p_branch_id and bs.product_id=p_product_id;
    select p.stock into v_product_stock from public.products p where p.shop_id=p_shop_id and p.id=p_product_id;
    return jsonb_build_object('ok',true,'already_committed',true,'branch_qty',v_branch_qty,'product_stock',v_product_stock);
  end if;
  perform 1 from public.products p where p.shop_id=p_shop_id and p.id=p_product_id for update;
  if not found then raise exception 'Product is not synced to this cloud shop yet'; end if;
  insert into public.branch_stock(shop_id,branch_id,product_id,qty,updated_at)
  values(p_shop_id,p_branch_id,p_product_id,0,now()) on conflict(branch_id,product_id) do nothing;
  select bs.qty into v_branch_qty from public.branch_stock bs
  where bs.shop_id=p_shop_id and bs.branch_id=p_branch_id and bs.product_id=p_product_id for update;
  select p.stock into v_product_stock from public.products p where p.shop_id=p_shop_id and p.id=p_product_id;
  if v_branch_qty+p_delta<0 then raise exception 'Selected branch stock cannot become negative'; end if;
  if v_product_stock+p_delta<0 then raise exception 'Shop total stock cannot become negative'; end if;
  insert into public.branch_stock_adjustments(id,shop_id,branch_id,product_id,delta,note,created_by)
  values(p_adjustment_id,p_shop_id,p_branch_id,p_product_id,p_delta,left(coalesce(p_note,'Stock adjustment'),500),v_uid);
  update public.branch_stock set qty=qty+p_delta,updated_at=now()
  where shop_id=p_shop_id and branch_id=p_branch_id and product_id=p_product_id returning qty into v_branch_qty;
  update public.products set stock=stock+p_delta,updated_at=now() where shop_id=p_shop_id and id=p_product_id returning stock into v_product_stock;
  insert into public.audit_log(shop_id,user_id,action,entity,details)
  values(p_shop_id,v_uid,'STOCK_ADJUSTMENT','Product',format('Branch stock adjustment %s for product %s in branch %s: delta %s (%s)',p_adjustment_id,p_product_id,p_branch_id,p_delta,left(coalesce(p_note,''),300)));
  return jsonb_build_object('ok',true,'already_committed',false,'branch_qty',v_branch_qty,'product_stock',v_product_stock);
end;
$function$;

CREATE OR REPLACE FUNCTION public.complete_sale_atomic_for_device_branch(p_shop_id uuid, p_branch_id uuid, p_device_id text, p_sale_id uuid, p_customer_id uuid DEFAULT NULL::uuid, p_shipping numeric DEFAULT 0, p_discount numeric DEFAULT 0, p_tax_pct numeric DEFAULT 0, p_points_redeemed integer DEFAULT 0, p_note text DEFAULT NULL::text, p_salesman_id uuid DEFAULT NULL::uuid, p_lines jsonb DEFAULT '[]'::jsonb, p_payments jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_branch_count integer; v_binding uuid; v_result jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not exists(select 1 from public.shop_memberships m where m.shop_id=p_shop_id and m.user_id=auth.uid() and m.active and m.role in ('admin','manager','cashier')) then
    raise exception 'User is not authorized to complete sales for this shop';
  end if;
  select count(*) into v_branch_count from public.branches b where b.shop_id=p_shop_id and b.active;
  if v_branch_count > 1 then
    if not exists (
      select 1 from public.pos_devices pd
      where pd.shop_id=p_shop_id::text
        and pd.device_id=btrim(coalesce(p_device_id,''))
        and pd.user_id=auth.uid()
        and pd.revoked_at is null
    ) then
      raise exception 'POS device is not registered to this user for this shop';
    end if;
    select d.branch_id into v_binding from public.pos_device_branches d
    where d.shop_id=p_shop_id and d.device_id=btrim(coalesce(p_device_id,'')) limit 1;
    if v_binding is null or v_binding<>p_branch_id then
      raise exception 'This POS device is not assigned to the selected branch. Ask the shop admin to assign this PC to an active branch.';
    end if;
  end if;
  v_result := public.complete_sale_atomic_for_branch(
    p_shop_id,p_branch_id,p_sale_id,p_customer_id,p_shipping,p_discount,p_tax_pct,
    p_points_redeemed,p_note,p_salesman_id,p_lines,p_payments
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_inventory_unit_atomic(p_shop_id uuid, p_branch_id uuid, p_device_id text, p_unit_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_active_branches integer;
  v_binding uuid;
  v_unit public.inventory_units%rowtype;
  v_product public.products%rowtype;
  v_expected_branch_qty numeric;
  v_total_qty numeric;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT m.role INTO v_role FROM public.shop_memberships m
  WHERE m.shop_id=p_shop_id AND m.user_id=v_uid AND m.active;
  IF v_role IS NULL OR v_role NOT IN ('admin','manager') THEN
    RAISE EXCEPTION 'Deleting tracked inventory requires admin or manager permission';
  END IF;
  IF p_shop_id IS NULL OR p_branch_id IS NULL OR p_unit_id IS NULL THEN
    RAISE EXCEPTION 'Shop, branch and unit are required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id=p_branch_id AND b.shop_id=p_shop_id AND b.active) THEN
    RAISE EXCEPTION 'Selected branch is unavailable';
  END IF;
  SELECT count(*) INTO v_active_branches FROM public.branches b WHERE b.shop_id=p_shop_id AND b.active;
  IF v_active_branches > 1 THEN
    if not exists (
      select 1 from public.pos_devices pd
      where pd.shop_id=p_shop_id::text
        and pd.device_id=btrim(coalesce(p_device_id,''))
        and pd.user_id=auth.uid()
        and pd.revoked_at is null
    ) then
      raise exception 'POS device is not registered to this user for this shop';
    end if;
    SELECT d.branch_id INTO v_binding FROM public.pos_device_branches d
    WHERE d.shop_id=p_shop_id AND d.device_id=btrim(coalesce(p_device_id,'')) LIMIT 1;
    IF v_binding IS NULL OR v_binding<>p_branch_id THEN
      RAISE EXCEPTION 'This POS device is not assigned to the selected branch';
    END IF;
  END IF;

  SELECT * INTO v_unit FROM public.inventory_units iu
  WHERE iu.id=p_unit_id AND iu.shop_id=p_shop_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Inventory unit was not found in this shop'; END IF;
  IF v_unit.branch_id<>p_branch_id THEN RAISE EXCEPTION 'Cannot delete a unit from another branch; use a stock transfer'; END IF;
  IF v_unit.status<>'in_stock' THEN RAISE EXCEPTION 'Only in-stock units can be deleted'; END IF;

  SELECT * INTO v_product FROM public.products p
  WHERE p.id=v_unit.product_id AND p.shop_id=p_shop_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unit product was not found'; END IF;
  IF NOT coalesce(v_product.track_imei,false) AND NOT coalesce(v_product.track_serial,false) THEN
    RAISE EXCEPTION 'Unit product is not configured for IMEI/serial tracking';
  END IF;

  DELETE FROM public.inventory_units WHERE id=p_unit_id AND shop_id=p_shop_id;
  SELECT count(*)::numeric INTO v_expected_branch_qty
  FROM public.inventory_units iu
  WHERE iu.shop_id=p_shop_id AND iu.product_id=v_unit.product_id
    AND iu.branch_id=p_branch_id AND iu.status='in_stock';
  INSERT INTO public.branch_stock(shop_id,branch_id,product_id,qty,updated_at)
  VALUES(p_shop_id,p_branch_id,v_unit.product_id,v_expected_branch_qty,now())
  ON CONFLICT(branch_id,product_id) DO UPDATE
    SET qty=excluded.qty,updated_at=now()
    WHERE public.branch_stock.qty IS DISTINCT FROM excluded.qty;

  SELECT coalesce(sum(bs.qty),0) INTO v_total_qty
  FROM public.branch_stock bs WHERE bs.shop_id=p_shop_id AND bs.product_id=v_unit.product_id;
  UPDATE public.products SET stock=v_total_qty,updated_at=now()
  WHERE id=v_unit.product_id AND shop_id=p_shop_id AND stock IS DISTINCT FROM v_total_qty;

  INSERT INTO public.audit_log(shop_id,user_id,action,entity,details)
  VALUES(p_shop_id,v_uid,'UNIT_DELETE','InventoryUnit',
    format('Deleted in-stock tracked unit %s from branch %s; remaining branch qty %s',
      p_unit_id,p_branch_id,v_expected_branch_qty));
  RETURN jsonb_build_object('ok',true,'deleted',true,'product_id',v_unit.product_id,'branch_qty',v_expected_branch_qty,'product_stock',v_total_qty);
END;
$function$;
