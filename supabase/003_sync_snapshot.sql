-- Revisioned cloud snapshot used by the offline sync adapter.
-- Run after the base schema and after production_security.sql.
-- A conflict never overwrites a newer remote revision.

create table if not exists public.pos_state_snapshots (
  shop_id uuid primary key references public.shops(id) on delete cascade,
  revision bigint not null default 0,
  state jsonb not null,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

alter table public.pos_state_snapshots enable row level security;
drop policy if exists snapshot_select on public.pos_state_snapshots;
create policy snapshot_select on public.pos_state_snapshots
  for select to authenticated
  using (public.is_shop_member(shop_id));

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
  next_revision bigint;
begin
  if not public.is_shop_member(p_shop_id) then
    raise exception 'Unauthorized shop';
  end if;

  select s.revision into current_revision
  from public.pos_state_snapshots s
  where s.shop_id = p_shop_id
  for update;

  if current_revision is null then
    current_revision := 0;
  end if;

  if current_revision <> p_expected_revision then
    return query select false, true, current_revision;
    return;
  end if;

  next_revision := current_revision + 1;
  insert into public.pos_state_snapshots(shop_id, revision, state, updated_by, updated_at)
  values (p_shop_id, next_revision, p_state, auth.uid(), now())
  on conflict (shop_id) do update
    set revision = excluded.revision,
        state = excluded.state,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;

  return query select true, false, next_revision;
end;
$$;

grant execute on function public.upsert_pos_snapshot(uuid, text, bigint, jsonb) to authenticated;
