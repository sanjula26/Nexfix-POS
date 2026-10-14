-- Rotate a Phone Sales bearer token atomically. A failed replacement insert
-- must roll back the old token revocation so the operator never loses both links.
CREATE OR REPLACE FUNCTION public.rotate_phone_sales_token(
  p_user_id uuid,
  p_shop_id uuid,
  p_old_token_hash text,
  p_new_token_hash text,
  p_device_id text DEFAULT NULL,
  p_label text DEFAULT 'Phone Sales'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_old_token_id uuid;
  v_new_token_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_shop_id IS NULL THEN
    RAISE EXCEPTION 'User and shop are required';
  END IF;
  IF p_new_token_hash IS NULL OR p_new_token_hash !~ '^[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION 'Invalid replacement token hash';
  END IF;
  IF p_old_token_hash IS NOT NULL AND p_old_token_hash !~ '^[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION 'Invalid previous token hash';
  END IF;
  IF p_device_id IS NOT NULL AND length(p_device_id)>200 THEN
    RAISE EXCEPTION 'Device label is too long';
  END IF;
  IF length(coalesce(p_label,''))>80 THEN
    RAISE EXCEPTION 'Phone Sales link label is too long';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.shop_memberships m
    WHERE m.shop_id=p_shop_id AND m.user_id=p_user_id AND m.active=true
      AND m.role IN ('admin','manager')
  ) THEN
    RAISE EXCEPTION 'Only an active shop admin or manager can create a phone sales link';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_shop_id::text));

  IF p_old_token_hash IS NOT NULL THEN
    UPDATE public.phone_sales_tokens
    SET revoked_at=now()
    WHERE shop_id=p_shop_id AND token_hash=p_old_token_hash AND revoked_at IS NULL
    RETURNING id INTO v_old_token_id;
    IF v_old_token_id IS NULL THEN
      RAISE EXCEPTION 'Previous phone sales link was not found or is already revoked; no new link was created';
    END IF;
  END IF;

  INSERT INTO public.phone_sales_tokens(token_hash,shop_id,device_id,created_by,label)
  VALUES(p_new_token_hash,p_shop_id,nullif(btrim(coalesce(p_device_id,'')),''),p_user_id,nullif(btrim(coalesce(p_label,'')),''))
  RETURNING id INTO v_new_token_id;

  RETURN jsonb_build_object('ok',true,'id',v_new_token_id,'previous_revoked',p_old_token_hash IS NOT NULL);
END;
$function$;

REVOKE ALL ON FUNCTION public.rotate_phone_sales_token(uuid,uuid,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_phone_sales_token(uuid,uuid,text,text,text,text) TO service_role;
