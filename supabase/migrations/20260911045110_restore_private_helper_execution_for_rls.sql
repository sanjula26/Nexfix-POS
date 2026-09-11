-- RLS policies call these helper functions in the private schema.
-- Keep execution available to authenticated sessions while explicitly denying
-- anonymous execution.

grant usage on schema private to authenticated;
grant execute on function private.is_shop_member(uuid) to authenticated;
grant execute on function private.is_shop_admin(uuid) to authenticated;
revoke execute on function private.is_shop_member(uuid) from anon;
revoke execute on function private.is_shop_admin(uuid) from anon;
