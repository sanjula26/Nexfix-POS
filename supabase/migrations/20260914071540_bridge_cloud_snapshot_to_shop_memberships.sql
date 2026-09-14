create or replace function private.register_pos_device_impl(p_shop_id text, p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  normalized_shop text := btrim(p_shop_id);
  normalized_device text := btrim(p_device_id);
  membership_role text;
  existing_device_user uuid;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if normalized_shop = '' or length(normalized_shop) > 100 then raise exception 'Invalid shop id'; end if;
  if normalized_device = '' or length(normalized_device) > 200 then raise exception 'Invalid device id'; end if;

  select sm.role into membership_role
  from public.shop_memberships sm
  where sm.shop_id = normalized_shop
    and sm.user_id = uid
    and sm.active = true
  limit 1;

  if membership_role is null then
    raise exception 'User is not an active member of this shop';
  end if;

  insert into public.pos_shops(shop_id, created_by)
  values (normalized_shop, uid)
  on conflict (shop_id) do nothing;

  insert into public.pos_shop_members(shop_id, user_id, role)
  values (
    normalized_shop,
    uid,
    case when membership_role = 'admin' then 'admin'
         when membership_role = 'manager' then 'admin'
         else 'member' end
  )
  on conflict (shop_id, user_id) do update
    set role = excluded.role;

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
$$;

create or replace function private.upsert_pos_snapshot_impl(p_shop_id text, p_device_id text, p_expected_revision bigint, p_state jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  current_revision bigint;
  normalized_shop text := btrim(p_shop_id);
  normalized_device text := btrim(p_device_id);
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if not exists (
    select 1 from public.shop_memberships sm
    where sm.shop_id = normalized_shop and sm.user_id = uid and sm.active = true
  ) then
    raise exception 'User is not an active member of this shop';
  end if;
  if not exists (
    select 1 from public.pos_devices d
    where d.shop_id = normalized_shop and d.device_id = normalized_device and d.user_id = uid
  ) then
    raise exception 'Device is not registered for this user';
  end if;
  if p_state is null or jsonb_typeof(p_state) <> 'object' then raise exception 'Invalid state payload'; end if;
  if p_expected_revision is null or p_expected_revision < 0 then raise exception 'Invalid expected revision'; end if;

  select revision into current_revision
  from public.pos_state_snapshots
  where shop_id = normalized_shop
  for update;
  current_revision := coalesce(current_revision, 0);

  if current_revision <> p_expected_revision then
    return jsonb_build_object('ok', false, 'conflict', true, 'revision', current_revision);
  end if;

  insert into public.pos_state_snapshots(shop_id, state, revision, updated_by, updated_device_id)
  values (normalized_shop, p_state, current_revision + 1, uid, normalized_device)
  on conflict (shop_id) do update set
    state = excluded.state,
    revision = excluded.revision,
    updated_by = excluded.updated_by,
    updated_device_id = excluded.updated_device_id,
    updated_at = now();

  update public.pos_devices
  set last_seen_at = now()
  where shop_id = normalized_shop and device_id = normalized_device;

  return jsonb_build_object('ok', true, 'conflict', false, 'revision', current_revision + 1);
end;
$$;

create or replace function public.register_pos_device(p_shop_id text, p_device_id text)
returns jsonb language sql set search_path = 'public' as $$
  select private.register_pos_device_impl(p_shop_id, p_device_id);
$$;

create or replace function public.upsert_pos_snapshot(p_shop_id text, p_device_id text, p_expected_revision bigint, p_state jsonb)
returns jsonb language sql set search_path = 'public' as $$
  select private.upsert_pos_snapshot_impl(p_shop_id, p_device_id, p_expected_revision, p_state);
$$;

revoke all on function public.register_pos_device(text,text) from public, anon;
revoke all on function public.upsert_pos_snapshot(text,text,bigint,jsonb) from public, anon;
grant execute on function public.register_pos_device(text,text) to authenticated;
grant execute on function public.upsert_pos_snapshot(text,text,bigint,jsonb) to authenticated;
