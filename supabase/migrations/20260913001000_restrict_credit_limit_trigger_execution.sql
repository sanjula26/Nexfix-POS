-- Trigger-only SECURITY DEFINER function. It is invoked by PostgreSQL as part
-- of the trigger and must not be callable by API roles directly.
REVOKE EXECUTE ON FUNCTION private.enforce_customer_credit_limit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION private.enforce_customer_credit_limit() FROM anon;
REVOKE EXECUTE ON FUNCTION private.enforce_customer_credit_limit() FROM authenticated;
