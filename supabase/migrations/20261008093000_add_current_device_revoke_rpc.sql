-- Nexfix POS: owner-scoped current device revocation for private updater access.
-- Production pos_devices uses user_id (not owner_id).

create or replace function public.revoke_pos_device(
  p_shop_id text,
  p_device_id text
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if length(trim(coalesce(p_shop_id,''))) = 0 or length(trim(p_shop_id)) > 100 then raise exception 'Invalid shop id'; end if;
  if length(trim(coalesce(p_device_id,''))) = 0 or length(trim(p_device_id)) > 200 then raise exception 'Invalid device id'; end if;
  update public.pos_devices
     set revoked_at = coalesce(revoked_at, now())
   where user_id = auth.uid()
     and shop_id = trim(p_shop_id)
     and device_id = trim(p_device_id);
end;
$$;

revoke all on function public.revoke_pos_device(text, text) from public;
grant execute on function public.revoke_pos_device(text, text) to authenticated;
