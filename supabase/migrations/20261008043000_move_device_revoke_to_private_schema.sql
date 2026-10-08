-- Keep the privileged device revocation implementation outside the exposed public schema.
-- The public RPC is an invoker wrapper; the private implementation performs the
-- admin membership check and clears the persistent updater token under RLS bypass.
create or replace function private.revoke_pos_device(
  p_shop_id text,
  p_device_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  uid uuid := auth.uid();
  normalized_shop text := btrim(coalesce(p_shop_id, ''));
  normalized_device text := btrim(coalesce(p_device_id, ''));
  membership_role text;
begin
  if uid is null then
    raise exception 'Authentication required';
  end if;
  if normalized_shop = '' or length(normalized_shop) > 100 then
    raise exception 'Invalid shop id';
  end if;
  if normalized_device = '' or length(normalized_device) > 200 then
    raise exception 'Invalid device id';
  end if;

  begin
    select sm.role
      into membership_role
      from public.shop_memberships sm
     where sm.shop_id = normalized_shop::uuid
       and sm.user_id = uid
       and sm.active = true
     limit 1;
  exception when invalid_text_representation then
    raise exception 'Invalid shop id';
  end;

  if membership_role is null then
    raise exception 'User is not an active member of this shop';
  end if;
  if membership_role <> 'admin' then
    raise exception 'Only a shop admin can revoke POS devices';
  end if;

  update public.pos_devices
     set revoked_at = coalesce(revoked_at, now()),
         updater_token_hash = null,
         updater_token_created_at = null
   where shop_id = normalized_shop
     and device_id = normalized_device;
end;
$function$;

create or replace function public.revoke_pos_device(
  p_shop_id text,
  p_device_id text
)
returns void
language sql
security invoker
set search_path = public
as $function$
  select private.revoke_pos_device(p_shop_id, p_device_id);
$function$;

revoke all on function public.revoke_pos_device(text, text) from public, anon;
grant execute on function public.revoke_pos_device(text, text) to authenticated;
revoke all on function private.revoke_pos_device(text, text) from public, anon;
grant execute on function private.revoke_pos_device(text, text) to authenticated;
