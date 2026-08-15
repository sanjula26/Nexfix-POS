-- Nexfix POS cloud snapshot synchronization
-- Safe to apply after the base schema. This migration is intentionally
-- isolated so it can be reviewed/applied independently.

create table if not exists public.pos_state_snapshots (
  shop_id uuid primary key references public.shops(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  revision bigint not null default 0 check (revision >= 0),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

alter table public.pos_state_snapshots enable row level security;

create index if not exists idx_pos_state_snapshots_updated
  on public.pos_state_snapshots(updated_at desc);

-- Access is limited to authenticated users who belong to the shop.
-- The helper uses profiles.shop_id when available; legacy installations
-- without that column should add their shop-membership policy separately.
drop policy if exists "snapshot_select_authenticated" on public.pos_state_snapshots;
create policy "snapshot_select_authenticated"
on public.pos_state_snapshots
for select
to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and (to_jsonb(p) ->> 'shop_id') = shop_id::text
      and coalesce(p.active, true)
  )
);

-- The browser must not directly update the snapshot. All writes go through
-- the guarded RPC below so the revision check is atomic.
drop policy if exists "snapshot_no_direct_insert" on public.pos_state_snapshots;
drop policy if exists "snapshot_no_direct_update" on public.pos_state_snapshots;
drop policy if exists "snapshot_no_direct_delete" on public.pos_state_snapshots;

create or replace function public.upsert_pos_snapshot(
  p_shop_id uuid,
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
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_state is null or jsonb_typeof(p_state) <> 'object' then
    raise exception 'state must be a JSON object';
  end if;

  -- Do not trust a client-supplied shop id unless the authenticated profile
  -- is actually associated with that shop.
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and (to_jsonb(p) ->> 'shop_id') = p_shop_id::text
      and coalesce(p.active, true)
  ) then
    raise exception 'not authorized for shop';
  end if;

  select s.revision
    into current_revision
    from public.pos_state_snapshots s
   where s.shop_id = p_shop_id
   for update;

  if current_revision is null then
    if coalesce(p_expected_revision, 0) <> 0 then
      return query select false, true, 0::bigint;
      return;
    end if;

    insert into public.pos_state_snapshots(shop_id, state, revision, updated_by)
    values (p_shop_id, p_state, 1, auth.uid());
    return query select true, false, 1::bigint;
    return;
  end if;

  if p_expected_revision <> current_revision then
    return query select false, true, current_revision;
    return;
  end if;

  update public.pos_state_snapshots
     set state = p_state,
         revision = current_revision + 1,
         updated_by = auth.uid(),
         updated_at = now()
   where shop_id = p_shop_id;

  return query select true, false, (current_revision + 1)::bigint;
end;
$$;

revoke all on function public.upsert_pos_snapshot(uuid, text, bigint, jsonb) from public;
grant execute on function public.upsert_pos_snapshot(uuid, text, bigint, jsonb) to authenticated;

comment on table public.pos_state_snapshots is
  'Optimistic-concurrency cloud snapshot used only for controlled state synchronization; transactional sales/stock remain authoritative operations.';
