-- Nexfix POS: server-side device revocation.
-- A revoked device remains registered for auditability but cannot write snapshots.
-- Re-registering a device does not automatically clear a revocation.

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
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  normalized_shop := trim(p_shop_id);
  normalized_device := trim(p_device_id);

  if normalized_shop is null or length(normalized_shop) = 0 or length(normalized_shop) > 100 then
    raise exception 'Invalid shop id';
  end if;

  if normalized_device is null or length(normalized_device) = 0 or length(normalized_device) > 200 then
    raise exception 'Invalid device id';
  end if;

  insert into public.pos_devices (owner_id, shop_id, device_id, last_seen_at)
  values (auth.uid(), normalized_shop, normalized_device, now())
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
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update public.pos_devices
     set revoked_at = coalesce(revoked_at, now())
   where owner_id = auth.uid()
     and shop_id = trim(p_shop_id)
     and device_id = trim(p_device_id);
end;
$$;

revoke all on function public.revoke_pos_device(text, text) from public;
grant execute on function public.revoke_pos_device(text, text) to authenticated;
