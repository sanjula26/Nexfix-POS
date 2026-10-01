-- Fix the cloud sale RPC boundary.
--
-- The public RPC is the only Data API entry point. The implementation remains in
-- private and remains SECURITY DEFINER. The public wrapper must also be
-- SECURITY DEFINER so it can invoke the private implementation without granting
-- authenticated users EXECUTE on the private function.
--
-- private.complete_sale_atomic validates auth.uid(), active shop membership, and
-- the allowed sales role before it creates or returns a sale. search_path remains
-- pinned to an empty value.

alter function public.complete_sale_atomic(
  uuid, uuid, uuid, numeric, numeric, numeric, integer, text, uuid, jsonb, jsonb
) security definer;

alter function public.complete_sale_atomic(
  uuid, uuid, uuid, numeric, numeric, numeric, integer, text, uuid, jsonb, jsonb
) set search_path = '';

revoke all on function public.complete_sale_atomic(
  uuid, uuid, uuid, numeric, numeric, numeric, integer, text, uuid, jsonb, jsonb
) from public, anon;

grant execute on function public.complete_sale_atomic(
  uuid, uuid, uuid, numeric, numeric, numeric, integer, text, uuid, jsonb, jsonb
) to authenticated;
