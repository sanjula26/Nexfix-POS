alter table public.pos_devices
  add column if not exists updater_token_hash text,
  add column if not exists updater_token_created_at timestamptz;

create unique index if not exists pos_devices_updater_token_hash_key
  on public.pos_devices (updater_token_hash)
  where updater_token_hash is not null;

create or replace function private.issue_pos_updater_token(
  p_shop_id text,
  p_device_id text
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
  membership_role text;
  registered_user uuid;
  revoked_at timestamptz;
  token text;
  token_hash text;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if normalized_shop = '' or length(normalized_shop) > 100 then raise exception 'Invalid shop id'; end if;
  if normalized_device = '' or length(normalized_device) > 200 then raise exception 'Invalid device id'; end if;

  select sm.role into membership_role
  from public.shop_memberships sm
  where sm.shop_id = normalized_shop::uuid
    and sm.user_id = uid
    and sm.active = true
  limit 1;

  if membership_role is null then
    raise exception 'User is not an active member of this shop';
  end if;
  if membership_role <> 'admin' then
    raise exception 'Only the shop admin can authorize private Windows updates';
  end if;

  select d.user_id, d.revoked_at
    into registered_user, revoked_at
  from public.pos_devices d
  where d.shop_id = normalized_shop
    and d.device_id = normalized_device
  for update;

  if registered_user is null then
    raise exception 'This Windows PC must be registered before update authorization';
  end if;
  if registered_user <> uid then
    raise exception 'POS device is registered to a different cloud account';
  end if;
  if revoked_at is not null then
    raise exception 'This POS device has been revoked and must be re-authorized by support';
  end if;

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
    'token', token
  );
exception
  when invalid_text_representation then
    raise exception 'Invalid shop id';
end;
$function$;

create or replace function public.issue_pos_updater_token(
  p_shop_id text,
  p_device_id text
)
returns jsonb
language sql
security invoker
set search_path = public
as $function$
  select private.issue_pos_updater_token(p_shop_id, p_device_id);
$function$;

revoke execute on function public.issue_pos_updater_token(text,text) from anon;
grant execute on function public.issue_pos_updater_token(text,text) to authenticated;
revoke execute on function private.issue_pos_updater_token(text,text) from anon;
grant execute on function private.issue_pos_updater_token(text,text) to authenticated;
