-- The public trade-in RPC is SECURITY INVOKER and delegates to the private
-- SECURITY DEFINER implementation. Authenticated callers need EXECUTE on the
-- private implementation for the delegation to work. The implementation still
-- validates auth.uid(), active shop membership, product ownership and all
-- trade-in identity constraints before mutating inventory.
grant usage on schema private to authenticated;

grant execute on function private.register_trade_in_atomic(
  uuid, uuid, uuid, uuid, numeric, text, text
) to authenticated;

revoke execute on function private.register_trade_in_atomic(
  uuid, uuid, uuid, uuid, numeric, text, text
) from anon, public;
