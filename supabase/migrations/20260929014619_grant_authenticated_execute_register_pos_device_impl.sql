-- The public invoker wrapper calls this private SECURITY DEFINER implementation.
-- Keep EXECUTE available to authenticated callers so the wrapper can register
-- devices after membership has been validated inside the definer function.
grant execute on function private.register_pos_device_impl(text, text) to authenticated;
