-- The public complete_sale_atomic RPC is SECURITY INVOKER so its caller's
-- EXECUTE privilege must be able to invoke the private SECURITY DEFINER
-- implementation. The private schema is not a Data API exposed schema, and
-- the implementation independently validates auth.uid(), active shop
-- membership, and the allowed sales role before mutating sale data.
grant usage on schema private to authenticated;

grant execute on function private.complete_sale_atomic(
  uuid, uuid, uuid, numeric, numeric, numeric, integer, text, uuid, jsonb, jsonb
) to authenticated;

revoke execute on function private.complete_sale_atomic(
  uuid, uuid, uuid, numeric, numeric, numeric, integer, text, uuid, jsonb, jsonb
) from anon, public;
