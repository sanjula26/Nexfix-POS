-- Nexfix POS: authenticated device registry.
-- A device is scoped to the authenticated shop owner and is updated by the
-- sync RPC. The browser/device identifier is not treated as an auth secret.

create table if not exists public.pos_devices (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  shop_id text not null,
  device_id text not null,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint pos_devices_shop_nonempty check (length(trim(shop_id)) > 0),
  constraint pos_devices_device_nonempty check (length(trim(device_id)) > 0),
  constraint pos_devices_owner_shop_device_unique unique (owner_id, shop_id, device_id)
);

create index if not exists pos_devices_owner_shop_idx
  on public.pos_devices(owner_id, shop_id);

alter table public.pos_devices enable row level security;
alter table public.pos_devices force row level security;

drop policy if exists "pos devices owner select" on public.pos_devices;
create policy "pos devices owner select"
  on public.pos_devices for select
  to authenticated
  using (owner_id = auth.uid());

drop policy if exists "pos devices owner insert" on public.pos_devices;
create policy "pos devices owner insert"
  on public.pos_devices for insert
  to authenticated
  with check (owner_id = auth.uid());

drop policy if exists "pos devices owner update" on public.pos_devices;
create policy "pos devices owner update"
  on public.pos_devices for update
  to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

revoke all on public.pos_devices from anon;
grant select, insert, update on public.pos_devices to authenticated;

create or replace function public.register_pos_device(
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

  if p_shop_id is null or length(trim(p_shop_id)) = 0 or length(trim(p_shop_id)) > 100 then
    raise exception 'Invalid shop id';
  end if;

  if p_device_id is null or length(trim(p_device_id)) = 0 or length(trim(p_device_id)) > 200 then
    raise exception 'Invalid device id';
  end if;

  insert into public.pos_devices (owner_id, shop_id, device_id, last_seen_at)
  values (auth.uid(), trim(p_shop_id), trim(p_device_id), now())
  on conflict (owner_id, shop_id, device_id)
  do update set last_seen_at = now();
end;
$$;

revoke all on function public.register_pos_device(text, text) from public;
grant execute on function public.register_pos_device(text, text) to authenticated;
