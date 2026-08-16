create table if not exists public.pos_shops (
  shop_id text primary key,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.pos_shop_members (
  shop_id text not null references public.pos_shops(shop_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  primary key (shop_id, user_id)
);

create table if not exists public.pos_devices (
  shop_id text not null references public.pos_shops(shop_id) on delete cascade,
  device_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (shop_id, device_id)
);

create table if not exists public.pos_state_snapshots (
  shop_id text primary key references public.pos_shops(shop_id) on delete cascade,
  state jsonb not null,
  revision bigint not null default 0 check (revision >= 0),
  updated_by uuid not null references auth.users(id) on delete restrict,
  updated_device_id text not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_pos_shop_members_user on public.pos_shop_members(user_id);
create index if not exists idx_pos_devices_user on public.pos_devices(user_id);

alter table public.pos_shops enable row level security;
alter table public.pos_shop_members enable row level security;
alter table public.pos_devices enable row level security;
alter table public.pos_state_snapshots enable row level security;

drop policy if exists pos_shops_select_member on public.pos_shops;
create policy pos_shops_select_member on public.pos_shops for select to authenticated using (
  exists (select 1 from public.pos_shop_members m where m.shop_id = pos_shops.shop_id and m.user_id = auth.uid())
);

drop policy if exists pos_shop_members_select_self on public.pos_shop_members;
create policy pos_shop_members_select_self on public.pos_shop_members for select to authenticated using (user_id = auth.uid());

drop policy if exists pos_devices_select_member on public.pos_devices;
create policy pos_devices_select_member on public.pos_devices for select to authenticated using (
  exists (select 1 from public.pos_shop_members m where m.shop_id = pos_devices.shop_id and m.user_id = auth.uid())
);

drop policy if exists pos_state_snapshots_select_member on public.pos_state_snapshots;
create policy pos_state_snapshots_select_member on public.pos_state_snapshots for select to authenticated using (
  exists (select 1 from public.pos_shop_members m where m.shop_id = pos_state_snapshots.shop_id and m.user_id = auth.uid())
);

create or replace function public.register_pos_device(p_shop_id text, p_device_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); normalized_shop text := btrim(p_shop_id); normalized_device text := btrim(p_device_id);
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if normalized_shop = '' or length(normalized_shop) > 100 then raise exception 'Invalid shop id'; end if;
  if normalized_device = '' or length(normalized_device) > 200 then raise exception 'Invalid device id'; end if;
  insert into public.pos_shops(shop_id, created_by) values (normalized_shop, uid) on conflict (shop_id) do nothing;
  insert into public.pos_shop_members(shop_id, user_id, role)
  values (normalized_shop, uid, case when exists (select 1 from public.pos_shops s where s.shop_id = normalized_shop and s.created_by = uid) then 'owner' else 'member' end)
  on conflict (shop_id, user_id) do nothing;
  if not exists (select 1 from public.pos_shop_members m where m.shop_id = normalized_shop and m.user_id = uid) then raise exception 'User is not a member of this shop'; end if;
  insert into public.pos_devices(shop_id, device_id, user_id) values (normalized_shop, normalized_device, uid)
  on conflict (shop_id, device_id) do update set user_id = excluded.user_id, last_seen_at = now();
  return jsonb_build_object('ok', true, 'shop_id', normalized_shop, 'device_id', normalized_device);
end; $$;

create or replace function public.upsert_pos_snapshot(p_shop_id text, p_device_id text, p_expected_revision bigint, p_state jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); current_revision bigint; normalized_shop text := btrim(p_shop_id); normalized_device text := btrim(p_device_id);
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if not exists (select 1 from public.pos_shop_members m where m.shop_id = normalized_shop and m.user_id = uid) then raise exception 'User is not a member of this shop'; end if;
  if not exists (select 1 from public.pos_devices d where d.shop_id = normalized_shop and d.device_id = normalized_device and d.user_id = uid) then raise exception 'Device is not registered for this user'; end if;
  if p_state is null or jsonb_typeof(p_state) <> 'object' then raise exception 'Invalid state payload'; end if;
  if p_expected_revision is null or p_expected_revision < 0 then raise exception 'Invalid expected revision'; end if;
  select revision into current_revision from public.pos_state_snapshots where shop_id = normalized_shop for update;
  current_revision := coalesce(current_revision, 0);
  if current_revision <> p_expected_revision then return jsonb_build_object('ok', false, 'conflict', true, 'revision', current_revision); end if;
  insert into public.pos_state_snapshots(shop_id, state, revision, updated_by, updated_device_id)
  values (normalized_shop, p_state, current_revision + 1, uid, normalized_device)
  on conflict (shop_id) do update set state = excluded.state, revision = excluded.revision, updated_by = excluded.updated_by, updated_device_id = excluded.updated_device_id, updated_at = now();
  update public.pos_devices set last_seen_at = now() where shop_id = normalized_shop and device_id = normalized_device;
  return jsonb_build_object('ok', true, 'conflict', false, 'revision', current_revision + 1);
end; $$;

revoke all on function public.register_pos_device(text,text) from public, anon;
revoke all on function public.upsert_pos_snapshot(text,text,bigint,jsonb) from public, anon;
grant execute on function public.register_pos_device(text,text) to authenticated;
grant execute on function public.upsert_pos_snapshot(text,text,bigint,jsonb) to authenticated;

revoke all on table public.pos_shops, public.pos_shop_members, public.pos_devices, public.pos_state_snapshots from anon;
grant select on public.pos_shops, public.pos_shop_members, public.pos_devices, public.pos_state_snapshots to authenticated;