-- Nexfix POS: remove browser/API execution privileges from legacy RPCs that
-- are not used by the current offline-first application. Keeping these
-- SECURITY DEFINER functions callable by authenticated clients unnecessarily
-- expands the exposed privilege boundary.
--
-- is_shop_member() and is_shop_admin() intentionally remain executable by
-- authenticated users because they are referenced by RLS policies.

revoke execute on function public.bootstrap_first_shop(text) from public, anon, authenticated;
revoke execute on function public.complete_sale_atomic(
  uuid, uuid, uuid, numeric, numeric, numeric, integer, text, uuid, jsonb, jsonb
) from public, anon, authenticated;
