-- This function is a trigger handler, not an RPC/API function.
-- Keep it callable by PostgreSQL for trigger execution, but not directly by
-- anonymous or authenticated API clients.

REVOKE EXECUTE ON FUNCTION public.prevent_profile_privilege_self_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.prevent_profile_privilege_self_change() FROM anon;
REVOKE EXECUTE ON FUNCTION public.prevent_profile_privilege_self_change() FROM authenticated;
