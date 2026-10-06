-- Public transaction RPCs are SECURITY INVOKER wrappers so their response reads
-- continue to obey the caller's RLS context. Their private implementations are
-- SECURITY DEFINER transaction boundaries with their own auth/shop/device/role
-- validation. Because an invoker wrapper executes nested functions as the
-- caller, authenticated must have EXECUTE on these private implementations.
--
-- The private schema is not exposed through the Supabase Data API, so these
-- grants do not create a browser-callable private RPC surface.
grant usage on schema private to authenticated;

grant execute on function private.process_sale_return_atomic(
  uuid, uuid, uuid, text, text, text, jsonb
) to authenticated;

grant execute on function private.receive_purchase_atomic(
  uuid, uuid, text, jsonb
) to authenticated;

grant execute on function private.process_purchase_return_atomic(
  uuid, uuid, uuid, text, text, jsonb, jsonb
) to authenticated;

grant execute on function private.process_repair_delivery_atomic(
  uuid, uuid, text, jsonb
) to authenticated;

revoke execute on function private.process_sale_return_atomic(
  uuid, uuid, uuid, text, text, text, jsonb
) from anon, public;

revoke execute on function private.receive_purchase_atomic(
  uuid, uuid, text, jsonb
) from anon, public;

revoke execute on function private.process_purchase_return_atomic(
  uuid, uuid, uuid, text, text, jsonb, jsonb
) from anon, public;

revoke execute on function private.process_repair_delivery_atomic(
  uuid, uuid, text, jsonb
) from anon, public;
