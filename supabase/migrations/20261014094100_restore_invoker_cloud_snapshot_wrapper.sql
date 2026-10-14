-- Preserve the SECURITY INVOKER boundary on the public RPC. The private
-- implementation is SECURITY DEFINER but independently validates admin
-- membership, the exact registered device/user/shop, revocation, payload, and
-- revision; authenticated callers need EXECUTE on that checked implementation
-- so the invoker wrapper can delegate without broadening the public endpoint.
CREATE OR REPLACE FUNCTION public.upsert_pos_snapshot(p_shop_id text, p_device_id text, p_expected_revision bigint, p_state jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path TO ''
AS $function$
  select private.upsert_pos_snapshot_impl(p_shop_id, p_device_id, p_expected_revision, p_state);
$function$;

REVOKE ALL ON FUNCTION private.upsert_pos_snapshot_impl(text,text,bigint,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.upsert_pos_snapshot_impl(text,text,bigint,jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.upsert_pos_snapshot(text,text,bigint,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_pos_snapshot(text,text,bigint,jsonb) TO authenticated, service_role;
