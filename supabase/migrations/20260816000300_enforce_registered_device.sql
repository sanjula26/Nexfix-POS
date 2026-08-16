-- Nexfix POS: enforce device registration at the snapshot write boundary.
-- This migration is intentionally separate from the snapshot table migration because
-- the device registry is created later in migration order.

create or replace function public.upsert_pos_snapshot(
  p_shop_id text,
  p_device_id text,
  p_expected_revision bigint,
  p_state jsonb
)
returns table(ok boolean, conflict boolean, revision bigint)
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_revision bigint;
  current_owner uuid;
  normalized_shop_id text;
  normalized_device_id text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  normalized_shop_id := trim(p_shop_id);
  normalized_device_id := trim(p_device_id);

  if normalized_shop_id is null or length(normalized_shop_id) = 0 or length(normalized_shop_id) > 100 then
    raise exception 'Invalid shop id';
  end if;

  if normalized_device_id is null or length(normalized_device_id) = 0 or length(normalized_device_id) > 200 then
    raise exception 'Invalid device id';
  end if;

  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Invalid expected revision';
  end if;

  if p_state is null then
    raise exception 'State is required';
  end if;

  -- A device must be registered to this authenticated owner/shop before it can write snapshots.
  if not exists (
    select 1
      from public.pos_devices d
     where d.owner_id = auth.uid()
       and d.shop_id = normalized_shop_id
       and d.device_id = normalized_device_id
  ) then
    raise exception 'Device is not registered for this shop';
  end if;

  select s.revision, s.owner_id
    into current_revision, current_owner
    from public.pos_state_snapshots s
   where s.shop_id = normalized_shop_id
   for update;

  if not found then
    insert into public.pos_state_snapshots
      (shop_id, owner_id, state, revision, updated_at, updated_by)
    values
      (normalized_shop_id, auth.uid(), p_state, 1, now(), auth.uid());

    return query select true, false, 1::bigint;
    return;
  end if;

  if current_owner <> auth.uid() then
    raise exception 'Shop access denied';
  end if;

  if current_revision <> p_expected_revision then
    return query select false, true, current_revision;
    return;
  end if;

  update public.pos_state_snapshots
     set state = p_state,
         revision = current_revision + 1,
         updated_at = now(),
         updated_by = auth.uid()
   where shop_id = normalized_shop_id
     and owner_id = auth.uid()
     and revision = p_expected_revision;

  if not found then
    select revision into current_revision
      from public.pos_state_snapshots
     where shop_id = normalized_shop_id;
    return query select false, true, current_revision;
    return;
  end if;

  return query select true, false, (current_revision + 1)::bigint;
end;
$$;

revoke all on function public.upsert_pos_snapshot(text, text, bigint, jsonb) from public;
grant execute on function public.upsert_pos_snapshot(text, text, bigint, jsonb) to authenticated;
