-- Compare-and-set wrapper for Inventory editor quantity changes.
-- Existing delta-based stock adjustments remain unchanged for sales/GRN/other flows.
CREATE OR REPLACE FUNCTION public.adjust_branch_stock_atomic_expected(
  p_shop_id uuid,
  p_branch_id uuid,
  p_device_id text,
  p_product_id uuid,
  p_delta numeric,
  p_note text,
  p_adjustment_id uuid,
  p_expected_branch_qty numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_branch_count integer;
  v_binding uuid;
  v_actual_qty numeric;
  v_existing public.branch_stock_adjustments%rowtype;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  SELECT m.role INTO v_role FROM public.shop_memberships m
  WHERE m.shop_id = p_shop_id AND m.user_id = v_uid AND m.active;
  IF v_role IS NULL OR v_role NOT IN ('admin','manager') THEN
    RAISE EXCEPTION 'Stock adjustment requires admin or manager permission';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = p_branch_id AND b.shop_id = p_shop_id AND b.active) THEN
    RAISE EXCEPTION 'Selected branch is unavailable';
  END IF;
  SELECT count(*) INTO v_branch_count FROM public.branches b WHERE b.shop_id = p_shop_id AND b.active;
  IF v_branch_count > 1 THEN
    SELECT d.branch_id INTO v_binding FROM public.pos_device_branches d
    WHERE d.shop_id = p_shop_id AND d.device_id = btrim(coalesce(p_device_id,'')) LIMIT 1;
    IF v_binding IS NULL OR v_binding <> p_branch_id THEN
      RAISE EXCEPTION 'This POS device is not assigned to the selected branch';
    END IF;
  END IF;
  IF p_expected_branch_qty IS NULL
     OR p_expected_branch_qty < 0
     OR p_expected_branch_qty <> trunc(p_expected_branch_qty) THEN
    RAISE EXCEPTION 'Expected branch quantity must be a non-negative whole number';
  END IF;
  IF p_shop_id IS NULL OR p_branch_id IS NULL OR p_product_id IS NULL OR p_adjustment_id IS NULL THEN
    RAISE EXCEPTION 'Shop, branch, product and adjustment ids are required';
  END IF;
  IF p_delta IS NULL OR p_delta = 0 OR abs(p_delta) > 1000000
     OR p_delta <> trunc(p_delta) THEN
    RAISE EXCEPTION 'Invalid stock adjustment quantity';
  END IF;

  -- Serialize duplicate submissions before checking idempotency or stock.
  PERFORM pg_advisory_xact_lock(hashtext(p_adjustment_id::text));
  SELECT * INTO v_existing
  FROM public.branch_stock_adjustments a
  WHERE a.id = p_adjustment_id;
  IF FOUND THEN
    -- Delegate payload validation and the already-committed response to the
    -- existing audited RPC; it rejects an id reused with different data.
    RETURN public.adjust_branch_stock_atomic(
      p_shop_id, p_branch_id, p_device_id, p_product_id, p_delta, p_note, p_adjustment_id
    );
  END IF;

  -- Keep the lock order consistent with the existing RPC: product first,
  -- then branch stock. Reconcile legacy totals before validating the target.
  PERFORM private.reconcile_product_stock_from_branch_stock(p_shop_id, ARRAY[p_product_id]::uuid[]);
  PERFORM 1 FROM public.products p
  WHERE p.shop_id = p_shop_id AND p.id = p_product_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product is not synced to this cloud shop yet';
  END IF;

  INSERT INTO public.branch_stock(shop_id, branch_id, product_id, qty, updated_at)
  VALUES (p_shop_id, p_branch_id, p_product_id, 0, now())
  ON CONFLICT (branch_id, product_id) DO NOTHING;

  SELECT bs.qty INTO v_actual_qty
  FROM public.branch_stock bs
  WHERE bs.shop_id = p_shop_id AND bs.branch_id = p_branch_id AND bs.product_id = p_product_id
  FOR UPDATE;

  IF v_actual_qty IS DISTINCT FROM p_expected_branch_qty THEN
    RAISE EXCEPTION 'Stock changed on another POS (expected %, current %). Refresh branch stock and retry.', p_expected_branch_qty, v_actual_qty
      USING ERRCODE = '40001';
  END IF;

  -- The existing RPC performs membership/role/device binding checks, enforces
  -- non-negative branch/shop totals, records idempotency and audit log entries.
  RETURN public.adjust_branch_stock_atomic(
    p_shop_id, p_branch_id, p_device_id, p_product_id, p_delta, p_note, p_adjustment_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.adjust_branch_stock_atomic_expected(uuid,uuid,text,uuid,numeric,text,uuid,numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adjust_branch_stock_atomic_expected(uuid,uuid,text,uuid,numeric,text,uuid,numeric) TO authenticated;
