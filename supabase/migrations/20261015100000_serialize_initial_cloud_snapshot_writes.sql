-- Serialize snapshot writes even when the shop has no snapshot row yet.
-- SELECT ... FOR UPDATE cannot lock a missing row, so concurrent first writes
-- could both observe revision 0 and overwrite one another. A transaction-scoped
-- advisory lock keyed by normalized shop ID closes that first-write race. The
-- existing admin-membership, device ownership/revocation, payload sanitization,
-- and optimistic revision checks remain unchanged.

CREATE OR REPLACE FUNCTION private.upsert_pos_snapshot_impl(
  p_shop_id text,
  p_device_id text,
  p_expected_revision bigint,
  p_state jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  uid uuid := auth.uid();
  current_revision bigint;
  normalized_shop text := btrim(p_shop_id);
  normalized_device text := btrim(p_device_id);
  safe_state jsonb := p_state;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.shop_memberships sm
    WHERE sm.shop_id = normalized_shop
      AND sm.user_id = uid
      AND sm.active = true
      AND sm.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Cloud snapshot publishing requires shop admin access';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.pos_devices d
    WHERE d.shop_id = normalized_shop
      AND d.device_id = normalized_device
      AND d.user_id = uid
      AND d.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Device is not registered for this user';
  END IF;

  IF safe_state IS NULL OR jsonb_typeof(safe_state) <> 'object' THEN
    RAISE EXCEPTION 'Invalid state payload';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION 'Invalid expected revision';
  END IF;

  -- Lock by shop before reading revision. This also serializes the initial
  -- write when pos_state_snapshots has no row to lock yet.
  PERFORM pg_advisory_xact_lock(hashtextextended(normalized_shop, 0));

  IF jsonb_typeof(safe_state->'users') = 'array' THEN
    safe_state := jsonb_set(
      safe_state,
      '{users}',
      COALESCE(
        (
          SELECT jsonb_agg(jsonb_set(u, '{password}', '\"\"'::jsonb, true))
          FROM jsonb_array_elements(safe_state->'users') AS u
        ),
        '[]'::jsonb
      ),
      true
    );
  END IF;

  IF jsonb_typeof(safe_state->'settings') = 'object' THEN
    safe_state := jsonb_set(safe_state, '{settings,adminPinHash}', '\"\"'::jsonb, true);
  END IF;

  SELECT revision
  INTO current_revision
  FROM public.pos_state_snapshots
  WHERE shop_id = normalized_shop
  FOR UPDATE;

  current_revision := COALESCE(current_revision, 0);

  IF current_revision <> p_expected_revision THEN
    RETURN jsonb_build_object('ok', false, 'conflict', true, 'revision', current_revision);
  END IF;

  INSERT INTO public.pos_state_snapshots(shop_id, state, revision, updated_by, updated_device_id)
  VALUES (normalized_shop, safe_state, current_revision + 1, uid, normalized_device)
  ON CONFLICT (shop_id) DO UPDATE SET
    state = EXCLUDED.state,
    revision = EXCLUDED.revision,
    updated_by = EXCLUDED.updated_by,
    updated_device_id = EXCLUDED.updated_device_id,
    updated_at = now();

  UPDATE public.pos_devices
  SET last_seen_at = now()
  WHERE shop_id = normalized_shop
    AND device_id = normalized_device;

  RETURN jsonb_build_object('ok', true, 'conflict', false, 'revision', current_revision + 1);
END;
$function$;

-- The public SECURITY DEFINER wrapper is the client entry point. Keep the
-- private implementation unavailable to authenticated/anon/public callers.
REVOKE ALL ON FUNCTION private.upsert_pos_snapshot_impl(text,text,bigint,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.upsert_pos_snapshot_impl(text,text,bigint,jsonb) TO service_role;
