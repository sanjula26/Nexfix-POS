-- Explicitly remove anonymous RPC access from all security-definer functions.
-- Authenticated execution remains only for functions intentionally exposed to the app.
revoke execute on function public.bootstrap_first_shop(text) from public, anon;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.is_shop_admin(uuid) from public, anon;
revoke execute on function public.is_shop_member(uuid) from public, anon;
revoke execute on function public.update_own_profile(text,text) from public, anon;
revoke execute on function public.complete_sale_atomic(uuid,uuid,uuid,numeric,numeric,numeric,integer,text,uuid,jsonb,jsonb) from public, anon;
grant execute on function public.bootstrap_first_shop(text) to authenticated;
grant execute on function public.is_shop_admin(uuid) to authenticated;
grant execute on function public.is_shop_member(uuid) to authenticated;
grant execute on function public.update_own_profile(text,text) to authenticated;
grant execute on function public.complete_sale_atomic(uuid,uuid,uuid,numeric,numeric,numeric,integer,text,uuid,jsonb,jsonb) to authenticated;
