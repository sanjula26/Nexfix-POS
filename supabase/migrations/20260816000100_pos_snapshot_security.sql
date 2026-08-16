-- Nexfix POS: secure multi-device snapshot storage.
-- The same authenticated Supabase account can use the shop from multiple devices.
-- A snapshot is owned by the first authenticated user that creates it; other users
-- cannot read or modify that shop snapshot until a future membership model is added.

create table if not exists public.pos_state_snapshots (
  shop_id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  state jsonb not null,
  revision bigint not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id) on delete restrict,
  constraint pos_state_snapshots_revision_nonnegative check (revision >= 0)
);

create index if not exists pos_state_snapshots_owner_idx
  on public.pos_state_snapshots(owner_id);

alter table public.pos_state_snapshots enable row level security;
alter table public.pos_state_snapshots force row level security;

drop policy if exists "pos snapshots owner select" on public.pos_state_snapshots;
create policy "pos snapshots owner select"
  on public.pos_state_snapshots for select
  to authenticated
  using (owner_id = auth.uid());

drop policy if exists "pos snapshots owner insert" on public.pos_state_snapshots;
create policy "pos snapshots owner insert"
  on public.pos_state_snapshots for insert
  to authenticated
  with check (owner_id = auth.uid() and updated_by = auth.uid());

drop policy if exists "pos snapshots owner update" on public.pos_state_snapshots;
create policy "pos snapshots owner update"
  on public.pos_state_snapshots for update
  to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid() and updated_by = auth.uid());

revoke all on public.pos_state_snapshots from anon;
grants select, insert, update on public.pos_state_snapshots to authenticated;

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
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_shop_id is null or length(trim(p_shop_id)) = 0 then
    raise exception 'Shop id is required';
  end if;

  if p_device_id is null or length(trim(p_device_id)) = 0 then
    raise exception 'Device id is required';
  end if;

  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Invalid expected revision';
  end if;

  if p_state is null then
    raise exception 'State is required';
  end if;

  select s.revision, s.owner_id
    into current_revision, current_owner
    from public.pos_state_snapshots s
   where s.shop_id = trim(p_shop_id)
   for update;

  if not found then
    insert into public.pos_state_snapshots
      (shop_id, owner_id, state, revision, updated_at, updated_by)
    values
      (trim(p_shop_id), auth.uid(), p_state, 1, now(), auth.uid());

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
   where shop_id = trim(p_shop_id)
     and owner_id = auth.uid()
     and revision = p_expected_revision;

  if not found then
    select revision into current_revision
      from public.pos_state_snapshots
     where shop_id = trim(p_shop_id);
    return query select false, true, current_revision;
    return;
  end if;

  return query select true, false, (current_revision + 1)::bigint;
end;
$$;

revoke all on function public.upsert_pos_snapshot(text, text, bigint, jsonb) from public;
grant execute on function public.upsert_pos_snapshot(text, text, bigint, jsonb) to authenticated;
