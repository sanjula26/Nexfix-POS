-- The public wrapper must run as its owner to call the private implementation,
-- whose EXECUTE privilege is intentionally not granted to authenticated users.
-- The implementation still validates the admin membership and registered device.
CREATE OR REPLACE FUNCTION public.upsert_pos_snapshot(p_shop_id text, p_device_id text, p_expected_revision bigint, p_state jsonb)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select private.upsert_pos_snapshot_impl(p_shop_id, p_device_id, p_expected_revision, p_state);
$function$;

CREATE OR REPLACE FUNCTION private.upsert_pos_snapshot_impl(p_shop_id text, p_device_id text, p_expected_revision bigint, p_state jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  uid uuid := auth.uid();
  current_revision bigint;
  normalized_shop text := btrim(p_shop_id);
  normalized_device text := btrim(p_device_id);
  safe_state jsonb := p_state;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if not exists (
    select 1 from public.shop_memberships sm
    where sm.shop_id = normalized_shop
      and sm.user_id = uid
      and sm.active = true
      and sm.role = 'admin'
  ) then
    raise exception 'Cloud snapshot publishing requires shop admin access';
  end if;
  if not exists (
    select 1 from public.pos_devices d
    where d.shop_id = normalized_shop
      and d.device_id = normalized_device
      and d.user_id = uid
      and d.revoked_at is null
  ) then
    raise exception 'Device is not registered for this user';
  end if;
  if safe_state is null or jsonb_typeof(safe_state) <> 'object' then raise exception 'Invalid state payload'; end if;
  if p_expected_revision is null or p_expected_revision < 0 then raise exception 'Invalid expected revision'; end if;

  if jsonb_typeof(safe_state->'users') = 'array' then
    safe_state := jsonb_set(
      safe_state,
      '{users}',
      coalesce(
        (select jsonb_agg(jsonb_set(u, '{password}', '""'::jsonb, true))
         from jsonb_array_elements(safe_state->'users') as u),
        '[]'::jsonb
      ),
      true
    );
  end if;
  if jsonb_typeof(safe_state->'settings') = 'object' then
    safe_state := jsonb_set(safe_state, '{settings,adminPinHash}', '""'::jsonb, true);
  end if;

  select revision into current_revision
  from public.pos_state_snapshots
  where shop_id = normalized_shop
  for update;
  current_revision := coalesce(current_revision, 0);

  if current_revision <> p_expected_revision then
    return jsonb_build_object('ok', false, 'conflict', true, 'revision', current_revision);
  end if;

  insert into public.pos_state_snapshots(shop_id, state, revision, updated_by, updated_device_id)
  values (normalized_shop, safe_state, current_revision + 1, uid, normalized_device)
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
$function$;

revoke all on function public.upsert_pos_snapshot(text,text,bigint,jsonb) from public, anon;
grant execute on function public.upsert_pos_snapshot(text,text,bigint,jsonb) to authenticated, service_role;
