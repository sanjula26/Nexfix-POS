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
$function$


REVOKE ALL ON FUNCTION public.delete_inventory_unit_atomic(uuid,uuid,text,uuid) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.delete_inventory_unit_atomic(uuid,uuid,text,uuid) TO authenticated;
