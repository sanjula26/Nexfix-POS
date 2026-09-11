-- Nexfix POS: reconcile the earlier snapshot/device migrations with the later
-- pos_* cloud-sync schema. This migration is intentionally additive and is safe
-- for databases that already ran any of the older sync/device migrations.
--
-- Canonical cloud-sync identity:
--   pos_shops.shop_id                 text
--   pos_shop_members(shop_id,user_id)
--   pos_devices(owner_id,shop_id,device_id,revoked_at)
--   pos_state_snapshots.shop_id       text
--
-- The older migrations created some of these tables first with UUID shop IDs
-- or owner_id-only device records. Do not drop existing business data.

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

-- Older device migrations used owner_id; the later schema used user_id.
-- Keep owner_id as the compatibility/source-of-truth column so revocation
-- remains valid on databases that already contain registered devices.
alter table if exists public.pos_devices
  add column if not exists owner_id uuid references auth.users(id) on delete cascade;

alter table if exists public.pos_devices
  add column if not exists revoked_at timestamptz;

-- If the newer column exists, copy it into the canonical compatibility column.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'pos_devices' and column_name = 'user_id'
  ) then
    update public.pos_devices
       set owner_id = coalesce(owner_id, user_id)
     where owner_id is null;
  end if;
end $$;

-- Snapshot tables from the early migrations used UUID shop_id. The application
-- uses a bounded text shop ID, so normalize the snapshot key without changing
-- its actual values. Existing UUID values become their canonical text form.
do $$
declare
  data_type text;
  constraint_name text;
begin
  select c.data_type into data_type
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'pos_state_snapshots'
    and c.column_name = 'shop_id';

  if data_type = 'uuid' then
    for constraint_name in
      select con.conname
      from pg_constraint con
      join pg_attribute a on a.attrelid = con.conrelid
                         and a.attnum = any(con.conkey)
      where con.conrelid = 'public.pos_state_snapshots'::regclass
        and con.contype = 'f'
        and a.attname = 'shop_id'
    loop
      execute format('alter table public.pos_state_snapshots drop constraint %I', constraint_name);
    end loop;

    alter table public.pos_state_snapshots
      alter column shop_id type text using shop_id::text;
  end if;
end $$;

alter table if exists public.pos_state_snapshots
  add column if not exists owner_id uuid references auth.users(id) on delete restrict;

alter table if exists public.pos_state_snapshots
  add column if not exists updated_device_id text;

-- Preserve the old device_id column if present, while filling the canonical
-- updated_device_id field used by the current snapshot writer.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'pos_state_snapshots' and column_name = 'device_id'
  ) then
    update public.pos_state_snapshots
       set updated_device_id = coalesce(nullif(updated_device_id, ''), device_id)
     where updated_device_id is null or updated_device_id = '';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'pos_state_snapshots' and column_name = 'updated_by'
  ) then
    update public.pos_state_snapshots
       set owner_id = coalesce(owner_id, updated_by)
     where owner_id is null;
  end if;
end $$;

update public.pos_devices d
   set owner_id = coalesce(d.owner_id, s.updated_by)
  from public.pos_state_snapshots s
 where d.owner_id is null
   and d.shop_id = s.shop_id;

-- Seed the new tenant registry from already-authorized legacy device/snapshot
-- records. This avoids turning an existing installation into a locked-out DB.
insert into public.pos_shops(shop_id, created_by)
select d.shop_id, min(d.owner_id)
from public.pos_devices d
where d.owner_id is not null
  and length(trim(d.shop_id)) > 0
  and not exists (select 1 from public.pos_shops s where s.shop_id = d.shop_id)
group by d.shop_id;

insert into public.pos_shops(shop_id, created_by)
select s.shop_id, s.owner_id
from public.pos_state_snapshots s
where s.owner_id is not null
  and length(trim(s.shop_id)) > 0
  and not exists (select 1 from public.pos_shops ps where ps.shop_id = s.shop_id);

insert into public.pos_shop_members(shop_id, user_id, role)
select d.shop_id, d.owner_id, 'owner'
from public.pos_devices d
where d.owner_id is not null
  and exists (select 1 from public.pos_shops s where s.shop_id = d.shop_id and s.created_by = d.owner_id)
on conflict (shop_id, user_id) do nothing;

insert into public.pos_shop_members(shop_id, user_id, role)
select s.shop_id, s.owner_id, 'owner'
from public.pos_state_snapshots s
where s.owner_id is not null
on conflict (shop_id, user_id) do nothing;

-- Existing snapshot rows always have a device identifier in the legacy sync
-- design. Empty string is used only for a legacy row where it was absent.
update public.pos_state_snapshots
   set updated_device_id = coalesce(nullif(updated_device_id, ''), 'legacy-device')
 where updated_device_id is null or updated_device_id = '';

-- Rebuild the current device registration boundary using the legacy-compatible
-- owner_id column. A revoked device cannot silently restore itself by logging in.
create or replace function public.register_pos_device(p_shop_id text, p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_shop text := btrim(p_shop_id);
  v_device text := btrim(p_device_id);
  v_owner uuid;
  v_revoked timestamptz;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if v_shop = '' or length(v_shop) > 100 then raise exception 'Invalid shop id'; end if;
  if v_device = '' or length(v_device) > 200 then raise exception 'Invalid device id'; end if;

  if exists (select 1 from public.pos_shops s where s.shop_id = v_shop) then
    if not exists (
      select 1 from public.pos_shop_members m
      where m.shop_id = v_shop and m.user_id = v_user
    ) then
      raise exception 'User is not a member of this shop';
    end if;
  else
    insert into public.pos_shops(shop_id, created_by) values (v_shop, v_user);
    insert into public.pos_shop_members(shop_id, user_id, role)
    values (v_shop, v_user, 'owner');
  end if;

  select d.owner_id, d.revoked_at into v_owner, v_revoked
  from public.pos_devices d
  where d.shop_id = v_shop and d.device_id = v_device
  order by d.id desc nulls last
  limit 1
  for update;

  if v_owner is not null and v_owner <> v_user then
    raise exception 'Device is registered to another user';
  end if;
  if v_revoked is not null then
    raise exception 'Device is revoked; restore it before use';
  end if;

  if v_owner is null then
    insert into public.pos_devices(owner_id, shop_id, device_id, last_seen_at, revoked_at)
    values (v_user, v_shop, v_device, now(), null);
  else
    update public.pos_devices
       set last_seen_at = now()
     where owner_id = v_user and shop_id = v_shop and device_id = v_device;
  end if;

  return jsonb_build_object('ok', true, 'shop_id', v_shop, 'device_id', v_device);
end;
$$;

revoke all on function public.register_pos_device(text,text) from public, anon;
grant execute on function public.register_pos_device(text,text) to authenticated;

-- Current cloud writer. Optimistic revision prevents stale devices from
-- overwriting newer snapshots. The row lock serializes concurrent writers.
create or replace function public.upsert_pos_snapshot(
  p_shop_id text,
  p_device_id text,
  p_expected_revision bigint,
  p_state jsonb
)
returns table(ok boolean, conflict boolean, revision bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_shop text := btrim(p_shop_id);
  v_device text := btrim(p_device_id);
  current_revision bigint;
  current_owner uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if v_shop = '' or length(v_shop) > 100 then raise exception 'Invalid shop id'; end if;
  if v_device = '' or length(v_device) > 200 then raise exception 'Invalid device id'; end if;
  if p_expected_revision is null or p_expected_revision < 0 then raise exception 'Invalid expected revision'; end if;
  if p_state is null or jsonb_typeof(p_state) <> 'object' then raise exception 'Invalid state payload'; end if;

  if not exists (
    select 1 from public.pos_shop_members m
    where m.shop_id = v_shop and m.user_id = v_user
  ) then
    raise exception 'User is not a member of this shop';
  end if;

  if not exists (
    select 1 from public.pos_devices d
    where d.shop_id = v_shop
      and d.device_id = v_device
      and d.owner_id = v_user
      and d.revoked_at is null
  ) then
    raise exception 'Device is not active for this shop';
  end if;

  select s.revision, s.owner_id
    into current_revision, current_owner
    from public.pos_state_snapshots s
   where s.shop_id = v_shop
   for update;

  current_revision := coalesce(current_revision, 0);

  if current_owner is not null and current_owner <> v_user then
    raise exception 'Shop access denied';
  end if;

  if current_revision <> p_expected_revision then
    return query select false, true, current_revision;
    return;
  end if;

  if exists (select 1 from public.pos_state_snapshots where shop_id = v_shop) then
    update public.pos_state_snapshots
       set state = p_state,
           revision = current_revision + 1,
           owner_id = v_user,
           updated_by = v_user,
           updated_device_id = v_device,
           updated_at = now()
     where shop_id = v_shop;
  else
    insert into public.pos_state_snapshots(
      shop_id, state, revision, owner_id, updated_by, updated_device_id, updated_at
    ) values (
      v_shop, p_state, 1, v_user, v_user, v_device, now()
    );
    return query select true, false, 1::bigint;
    return;
  end if;

  update public.pos_devices
     set last_seen_at = now()
   where owner_id = v_user and shop_id = v_shop and device_id = v_device;

  return query select true, false, (current_revision + 1)::bigint;
end;
$$;

revoke all on function public.upsert_pos_snapshot(text,text,bigint,jsonb) from public, anon;
grant execute on function public.upsert_pos_snapshot(text,text,bigint,jsonb) to authenticated;

-- Canonical RLS for the cloud-sync tables. SECURITY DEFINER helpers prevent
-- membership checks from recursively evaluating the membership table policy.
create or replace function public.pos_is_shop_member(p_shop_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.pos_shop_members m
    where m.shop_id = p_shop_id and m.user_id = auth.uid()
  );
$$;

revoke all on function public.pos_is_shop_member(text) from public, anon;
grant execute on function public.pos_is_shop_member(text) to authenticated;

alter table public.pos_shops enable row level security;
alter table public.pos_shop_members enable row level security;
alter table public.pos_devices enable row level security;
alter table public.pos_state_snapshots enable row level security;

-- Remove known permissive policies from previous migrations.
drop policy if exists pos_shops_select_member on public.pos_shops;
drop policy if exists pos_shop_members_select_self on public.pos_shop_members;
drop policy if exists pos_devices_select_member on public.pos_devices;
drop policy if exists "pos devices owner select" on public.pos_devices;
drop policy if exists "pos devices owner insert" on public.pos_devices;
drop policy if exists "pos devices owner update" on public.pos_devices;
drop policy if exists pos_state_snapshots_select_member on public.pos_state_snapshots;
drop policy if exists snapshot_select on public.pos_state_snapshots;
drop policy if exists "snapshot member read" on public.pos_state_snapshots;
drop policy if exists "snapshot member insert" on public.pos_state_snapshots;
drop policy if exists "snapshot member update" on public.pos_state_snapshots;

create policy pos_shops_select_member on public.pos_shops
  for select to authenticated
  using (public.pos_is_shop_member(shop_id));

create policy pos_shop_members_select_self on public.pos_shop_members
  for select to authenticated
  using (user_id = auth.uid());

create policy pos_devices_select_member on public.pos_devices
  for select to authenticated
  using (owner_id = auth.uid() and public.pos_is_shop_member(shop_id));

create policy pos_state_snapshots_select_member on public.pos_state_snapshots
  for select to authenticated
  using (public.pos_is_shop_member(shop_id));

revoke all on table public.pos_shops, public.pos_shop_members, public.pos_devices, public.pos_state_snapshots from anon;
grant select on public.pos_shops, public.pos_shop_members, public.pos_devices, public.pos_state_snapshots to authenticated;

comment on migration is 'Reconciles legacy UUID/owner_id cloud-sync migrations with the current text shop/member/device snapshot model.';
