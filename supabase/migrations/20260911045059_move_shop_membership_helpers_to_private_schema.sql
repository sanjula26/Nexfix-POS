-- Keep RLS helper functions out of the public API schema.
-- These functions are still used by RLS policies, so they remain executable by
-- authenticated sessions but are no longer exposed as public RPC endpoints.

create schema if not exists private;

alter function public.is_shop_member(uuid) set schema private;
alter function public.is_shop_admin(uuid) set schema private;
