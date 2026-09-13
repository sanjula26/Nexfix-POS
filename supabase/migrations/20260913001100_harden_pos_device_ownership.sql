-- A registered POS device is bound to the user who registered it.
-- A different shop member must not be able to take over that device id.
CREATE OR REPLACE FUNCTION private.register_pos_device_impl(p_shop_id text, p_device_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  uid uuid := auth.uid();
  normalized_shop text := btrim(p_shop_id);
  normalized_device text := btrim(p_device_id);
  created_new_shop boolean := false;
  existing_device_user uuid;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if normalized_shop = '' or length(normalized_shop) > 100 then raise exception 'Invalid shop id'; end if;
  if normalized_device = '' or length(normalized_device) > 200 then raise exception 'Invalid device id'; end if;

  begin
    insert into public.pos_shops(shop_id, created_by)
    values (normalized_shop, uid);
    created_new_shop := true;
  exception when unique_violation then
    created_new_shop := false;
  end;

  if created_new_shop then
    insert into public.pos_shop_members(shop_id, user_id, role)
    values (normalized_shop, uid, 'owner');
  elsif not exists (
    select 1 from public.pos_shop_members m
    where m.shop_id = normalized_shop and m.user_id = uid
  ) then
    raise exception 'User is not a member of this shop';
  end if;

  select d.user_id into existing_device_user
  from public.pos_devices d
  where d.shop_id = normalized_shop and d.device_id = normalized_device
  for update;

  if existing_device_user is not null and existing_device_user <> uid then
    raise exception 'POS device is already registered to another user';
  end if;

  insert into public.pos_devices(shop_id, device_id, user_id)
  values (normalized_shop, normalized_device, uid)
  on conflict (shop_id, device_id) do update
    set user_id = excluded.user_id, last_seen_at = now();

  return jsonb_build_object('ok', true, 'shop_id', normalized_shop, 'device_id', normalized_device);
end;
$function$;
