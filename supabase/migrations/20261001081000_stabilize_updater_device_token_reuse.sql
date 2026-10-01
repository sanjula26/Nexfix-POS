create or replace function private.authorize_pos_updater_device(
  p_shop_id text,
  p_device_id text,
  p_current_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  uid uuid := auth.uid();
  normalized_shop text := btrim(p_shop_id);
  normalized_device text := btrim(p_device_id);
  current_token text := btrim(coalesce(p_current_token, ''));
  membership_role text;
  existing_device_user uuid;
  existing_revoked_at timestamptz;
  existing_token_hash text;
  token text;
  token_hash text;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if normalized_shop = '' or length(normalized_shop) > 100 then raise exception 'Invalid shop id'; end if;
  if normalized_device = '' or length(normalized_device) > 200 then raise exception 'Invalid device id'; end if;
  if length(current_token) > 512 then raise exception 'Invalid updater device token'; end if;

  begin
    select sm.role into membership_role
    from public.shop_memberships sm
    where sm.shop_id = normalized_shop::uuid
      and sm.user_id = uid
      and sm.active = true
    limit 1;
  exception when invalid_text_representation then
    raise exception 'Invalid shop id';
  end;

  if membership_role is null then
    raise exception 'User is not an active member of this shop'; end if;
  if membership_role <> 'admin' then
    raise exception 'Only the shop admin can authorize private Windows updates'; end if;

  insert into public.pos_shops(shop_id, created_by)
  values (normalized_shop, uid)
  on conflict (shop_id) do nothing;

  insert into public.pos_shop_members(shop_id, user_id, role)
  values (normalized_shop, uid, 'admin')
  on conflict (shop_id, user_id) do update
    set role = excluded.role;

  select d.user_id, d.revoked_at, d.updater_token_hash
    into existing_device_user, existing_revoked_at, existing_token_hash
  from public.pos_devices d
  where d.shop_id = normalized_shop
    and d.device_id = normalized_device
  for update;

  if existing_device_user is not null and existing_device_user <> uid then
    raise exception 'POS device is registered to a different cloud account';
  end if;
  if existing_revoked_at is not null then
    raise exception 'This POS device has been revoked and must be re-authorized by support';
  end if;

  if existing_device_user is not null and existing_token_hash is not null and current_token <> '' then
    token_hash := encode(extensions.digest(current_token, 'sha256'), 'hex');
    if token_hash = existing_token_hash then
      update public.pos_devices
      set last_seen_at = now()
      where shop_id = normalized_shop
        and device_id = normalized_device;
      return jsonb_build_object(
        'ok', true,
        'device_id', normalized_device,
        'shop_id', normalized_shop,
        'token', current_token,
        'reused', true
      );
    end if;
  end if;

  insert into public.pos_devices(shop_id, device_id, user_id, last_seen_at)
  values (normalized_shop, normalized_device, uid, now())
  on conflict (shop_id, device_id) do update
    set user_id = excluded.user_id,
        last_seen_at = now(),
        revoked_at = null;

  token := encode(extensions.gen_random_bytes(32), 'hex');
  token_hash := encode(extensions.digest(token, 'sha256'), 'hex');

  update public.pos_devices
  set updater_token_hash = token_hash,
      updater_token_created_at = now(),
      last_seen_at = now()
  where shop_id = normalized_shop
    and device_id = normalized_device;

  return jsonb_build_object(
    'ok', true,
    'device_id', normalized_device,
    'shop_id', normalized_shop,
    'token', token,
    'reused', false
  );
end;
$function$;

create or replace function public.authorize_pos_updater_device(
  p_shop_id text,
  p_device_id text,
  p_current_token text
)
returns jsonb
language sql
security invoker
set search_path = public
as $function$
  select private.authorize_pos_updater_device(p_shop_id, p_device_id, p_current_token);
$function$;

revoke all on function public.authorize_pos_updater_device(text,text,text) from public, anon;
grant execute on function public.authorize_pos_updater_device(text,text,text) to authenticated;
revoke all on function private.authorize_pos_updater_device(text,text,text) from public, anon;
grant execute on function private.authorize_pos_updater_device(text,text,text) to authenticated;
