-- Durable sync infrastructure. This stores full local snapshots as a safe
-- transition layer while the POS moves to row-level transactional sync.
-- Production multi-PC writes should use row-level business transactions;
-- snapshot writes use optimistic concurrency and NEVER overwrite a newer
-- remote revision silently.

create table if not exists public.pos_state_snapshots (
  shop_id uuid primary key references public.shops(id) on delete cascade,
  revision bigint not null default 0,
  device_id text not null,
  state jsonb not null,
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now()
);

alter table public.pos_state_snapshots enable row level security;

create policy "snapshot member read" on public.pos_state_snapshots
  for select to authenticated using (is_shop_member(shop_id));

create policy "snapshot member insert" on public.pos_state_snapshots
  for insert to authenticated with check (is_shop_member(shop_id) and updated_by = auth.uid());

create policy "snapshot member update" on public.pos_state_snapshots
  for update to authenticated
  using (is_shop_member(shop_id))
  with check (is_shop_member(shop_id) and updated_by = auth.uid());

create or replace function public.upsert_pos_snapshot(
  p_shop_id uuid,
  p_device_id text,
  p_expected_revision bigint,
  p_state jsonb
)
returns table(ok boolean, revision bigint, conflict boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_revision bigint;
  next_revision bigint;
begin
  if auth.uid() is null or not is_shop_member(p_shop_id) then
    raise exception 'Not authorized for shop';
  end if;

  select s.revision into current_revision
  from public.pos_state_snapshots s
  where s.shop_id = p_shop_id
  for update;

  if current_revision is null then
    if p_expected_revision <> 0 then
      return query select false, 0::bigint, true;
      return;
    end if;
    next_revision := 1;
    insert into public.pos_state_snapshots(shop_id, revision, device_id, state, updated_by)
    values (p_shop_id, next_revision, p_device_id, p_state, auth.uid());
    return query select true, next_revision, false;
    return;
  end if;

  if current_revision <> p_expected_revision then
    return query select false, current_revision, true;
    return;
  end if;

  next_revision := current_revision + 1;
  update public.pos_state_snapshots
  set revision = next_revision,
      device_id = p_device_id,
      state = p_state,
      updated_by = auth.uid(),
      updated_at = now()
  where shop_id = p_shop_id;

  return query select true, next_revision, false;
end;
$$;

revoke all on function public.upsert_pos_snapshot(uuid,text,bigint,jsonb) from public;
grant execute on function public.upsert_pos_snapshot(uuid,text,bigint,jsonb) to authenticated;
