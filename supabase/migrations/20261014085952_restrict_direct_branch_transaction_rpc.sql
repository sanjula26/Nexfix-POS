-- Restrict direct access to branch transaction implementations.
--
-- POS clients must enter through the device-bound wrappers, which validate
-- the registered device-to-branch assignment before calling these functions.
-- Leaving these SECURITY DEFINER implementations directly executable by
-- authenticated users would allow a member to skip the device-binding check.
revoke all on function public.complete_sale_atomic_for_branch(uuid,uuid,uuid,uuid,numeric,numeric,numeric,integer,text,uuid,jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.receive_purchase_atomic_for_branch(uuid,uuid,uuid,text,jsonb) from public, anon, authenticated;

-- Keep the explicit device-bound entry points available to signed-in POS clients.
grant execute on function public.complete_sale_atomic_for_device_branch(uuid,uuid,text,uuid,uuid,numeric,numeric,numeric,integer,text,uuid,jsonb,jsonb) to authenticated;
grant execute on function public.receive_purchase_atomic_for_device_branch(uuid,uuid,text,uuid,jsonb) to authenticated;
