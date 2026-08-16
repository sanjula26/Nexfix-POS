-- Nexfix POS: server-side device revocation.
-- A revoked device remains registered for auditability but cannot write snapshots.

alter table public.pos_devices
  add column if not exists revoked_at timestamptz;

create index if not exists pos_devices_active_idx
  on public.pos_devices(owner_id, shop_id, revoked_at);

create or replace function public.register_pos_device(
  p_shop_id text,
  p_device_id text
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  normalized_shop text;
  normalized_device text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  normalized_shop := trim(p_shop_id);
  normalized_device := trim(p_device_id);
  if normalized_shop is null or length(normalized_shop) = 0 or length(normalized_shop) > 100 then raise exception 'Invalid shop id'; end if;
  if normalized_device is null or length(normalized_device) = 0 or length(normalized_device) > 200 then raise exception 'Invalid device id'; end if;

  insert into public.pos_devices (owner_id, shop_id, device_id, last_seen_at, revoked_at)
  values (auth.uid(), normalized_shop, normalized_device, now(), null)
  on conflict (owner_id, shop_id, device_id)
  do update set last_seen_at = now();
end;
$$;

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
  update public.pos_devices
     set revoked_at = coalesce(revoked_at, now())
   where owner_id = auth.uid()
     and shop_id = trim(p_shop_id)
     and device_id = trim(p_device_id);
end;
$$;

create or replace function public.restore_pos_device(
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
  update public.pos_devices
     set revoked_at = null,
         last_seen_at = now()
   where owner_id = auth.uid()
     and shop_id = trim(p_shop_id)
     and device_id = trim(p_device_id);
end;
$$;

revoke all on function public.revoke_pos_device(text, text) from public;
grant execute on function public.revoke_pos_device(text, text) to authenticated;
revoke all on function public.restore_pos_device(text, text) from public;
grant execute on function public.restore_pos_device(text, text) to authenticated;

-- Recreate the write boundary so only an active (non-revoked) registered device can sync.
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
  normalized_shop text;
  normalized_device text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  normalized_shop := trim(p_shop_id);
  normalized_device := trim(p_device_id);
  if normalized_shop is null or length(normalized_shop) = 0 or length(normalized_shop) > 100 then raise exception 'Invalid shop id'; end if;
  if normalized_device is null or length(normalized_device) = 0 or length(normalized_device) > 200 then raise exception 'Invalid device id'; end if;
  if p_expected_revision is null or p_expected_revision < 0 then raise exception 'Invalid expected revision'; end if;
  if p_state is null then raise exception 'State is required'; end if;

  if not exists (
    select 1 from public.pos_devices d
     where d.owner_id = auth.uid()
       and d.shop_id = normalized_shop
       and d.device_id = normalized_device
       and d.revoked_at is null
  ) then
    raise exception 'Device is not active for this shop';
  end if;

  update public.pos_devices
     set last_seen_at = now()
   where owner_id = auth.uid()
     and shop_id = normalized_shop
     and device_id = normalized_device
     and revoked_at is null;

  select s.revision, s.owner_id into current_revision, current_owner
    from public.pos_state_snapshots s
   where s.shop_id = normalized_shop
   for update;

  if not found then
    insert into public.pos_state_snapshots
      (shop_id, owner_id, state, revision, updated_at, updated_by)
    values (normalized_shop, auth.uid(), p_state, 1, now(), auth.uid());
    return query select true, false, 1::bigint;
    return;
  end if;

  if current_owner <> auth.uid() then raise exception 'Shop access denied'; end if;
  if current_revision <> p_expected_revision then
    return query select false, true, current_revision;
    return;
  end if;

  update public.pos_state_snapshots
     set state = p_state,
         revision = current_revision + 1,
         updated_at = now(),
         updated_by = auth.uid()
   where shop_id = normalized_shop
     and owner_id = auth.uid()
     and revision = p_expected_revision;

  if not found then
    select revision into current_revision from public.pos_state_snapshots where shop_id = normalized_shop;
    return query select false, true, current_revision;
    return;
  end if;

  return query select true, false, (current_revision + 1)::bigint;
end;
$$;

revoke all on function public.upsert_pos_snapshot(text, text, bigint, jsonb) from public;
grant execute on function public.upsert_pos_snapshot(text, text, bigint, jsonb) to authenticated;
