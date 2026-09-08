-- Finalize the text-shop cloud sync RPCs after the legacy/duplicate migration chain.
-- Keep the existing owner/device schema and security-invoker model; do not
-- reintroduce the later SECURITY DEFINER implementation.

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
  normalized_shop text := btrim(p_shop_id);
  normalized_device text := btrim(p_device_id);
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if normalized_shop = '' or length(normalized_shop) > 100 then
    raise exception 'Invalid shop id';
  end if;
  if normalized_device = '' or length(normalized_device) > 200 then
    raise exception 'Invalid device id';
  end if;

  insert into public.pos_devices (owner_id, shop_id, device_id, last_seen_at)
  values (auth.uid(), normalized_shop, normalized_device, now())
  on conflict (owner_id, shop_id, device_id)
  do update set last_seen_at = now();
end;
$$;

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
  normalized_shop text := btrim(p_shop_id);
  normalized_device text := btrim(p_device_id);
  current_revision bigint;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if normalized_shop = '' or length(normalized_shop) > 100 then
    raise exception 'Invalid shop id';
  end if;
  if normalized_device = '' or length(normalized_device) > 200 then
    raise exception 'Invalid device id';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Invalid expected revision';
  end if;
  if p_state is null or jsonb_typeof(p_state) <> 'object' then
    raise exception 'Invalid state payload';
  end if;

  if not exists (
    select 1
      from public.pos_devices d
     where d.owner_id = auth.uid()
       and d.shop_id = normalized_shop
       and d.device_id = normalized_device
       and d.revoked_at is null
  ) then
    raise exception 'Device is not active for this shop';
  end if;

  select s.revision
    into current_revision
    from public.pos_state_snapshots s
   where s.shop_id = normalized_shop
     and s.owner_id = auth.uid()
   for update;

  current_revision := coalesce(current_revision, 0);

  if current_revision <> p_expected_revision then
    return query select false, true, current_revision;
    return;
  end if;

  insert into public.pos_state_snapshots (
    shop_id, owner_id, state, revision, updated_by, updated_at
  )
  values (
    normalized_shop, auth.uid(), p_state, current_revision + 1, auth.uid(), now()
  )
  on conflict (shop_id) do update
     set state = excluded.state,
         revision = excluded.revision,
         updated_by = excluded.updated_by,
         updated_at = now()
   where public.pos_state_snapshots.owner_id = auth.uid();

  if not found then
    raise exception 'Shop snapshot is owned by another user';
  end if;

  update public.pos_devices
     set last_seen_at = now()
   where owner_id = auth.uid()
     and shop_id = normalized_shop
     and device_id = normalized_device
     and revoked_at is null;

  return query select true, false, current_revision + 1;
end;
$$;

revoke all on function public.register_pos_device(text, text) from public, anon;
revoke all on function public.upsert_pos_snapshot(text, text, bigint, jsonb) from public, anon;
grant execute on function public.register_pos_device(text, text) to authenticated;
grant execute on function public.upsert_pos_snapshot(text, text, bigint, jsonb) to authenticated;
