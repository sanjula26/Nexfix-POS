-- Phase 2.1: additive branch model and single-branch compatibility backfill.
-- Stock remains in products.stock as the legacy-compatible total during rollout.
-- branch_stock mirrors products.stock while a shop has exactly one branch; the
-- Phase 2 sale/GRN/transfer RPCs will become authoritative before enabling multi-branch operations.

create table if not exists public.branches (
  id uuid primary key default extensions.uuid_generate_v4(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null,
  code text not null,
  active boolean not null default true,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint branches_name_nonempty check (length(btrim(name)) > 0),
  constraint branches_code_nonempty check (length(btrim(code)) > 0),
  constraint branches_shop_id_id_unique unique (shop_id, id),
  constraint branches_shop_code_unique unique (shop_id, code)
);

create unique index if not exists branches_one_default_per_shop
  on public.branches(shop_id) where is_default;

insert into public.branches(shop_id, name, code, active, is_default)
select s.id, 'Main', 'MAIN', true, true
from public.shops s
where not exists (select 1 from public.branches b where b.shop_id = s.id and b.is_default)
on conflict (shop_id, code) do update
set is_default = true, active = true, updated_at = now();

-- Composite ownership keys prevent cross-shop branch/product references.
create unique index if not exists products_shop_id_id_unique on public.products(shop_id, id);

create table if not exists public.branch_stock (
  shop_id uuid not null,
  branch_id uuid not null,
  product_id uuid not null,
  qty numeric(12,2) not null default 0,
  updated_at timestamptz not null default now(),
  constraint branch_stock_qty_nonnegative check (qty >= 0),
  constraint branch_stock_branch_fk foreign key (shop_id, branch_id)
    references public.branches(shop_id, id) on delete cascade,
  constraint branch_stock_product_fk foreign key (shop_id, product_id)
    references public.products(shop_id, id) on delete cascade,
  constraint branch_stock_branch_product_unique unique (branch_id, product_id)
);

insert into public.branch_stock(shop_id, branch_id, product_id, qty)
select p.shop_id, b.id, p.id, p.stock
from public.products p
join public.branches b on b.shop_id = p.shop_id and b.is_default
on conflict (branch_id, product_id) do update
set qty = excluded.qty, updated_at = now();

alter table public.sales add column if not exists branch_id uuid;
alter table public.expenses add column if not exists branch_id uuid;
alter table public.day_sessions add column if not exists branch_id uuid;
alter table public.purchases add column if not exists branch_id uuid;
alter table public.inventory_units add column if not exists branch_id uuid;

update public.sales s set branch_id = b.id
from public.branches b where b.shop_id = s.shop_id and b.is_default and s.branch_id is null;
update public.expenses e set branch_id = b.id
from public.branches b where b.shop_id = e.shop_id and b.is_default and e.branch_id is null;
update public.day_sessions d set branch_id = b.id
from public.branches b where b.shop_id = d.shop_id and b.is_default and d.branch_id is null;
update public.purchases p set branch_id = b.id
from public.branches b where b.shop_id = p.shop_id and b.is_default and p.branch_id is null;
update public.inventory_units u set branch_id = b.id
from public.branches b where b.shop_id = u.shop_id and b.is_default and u.branch_id is null;

alter table public.sales alter column branch_id set not null;
alter table public.expenses alter column branch_id set not null;
alter table public.day_sessions alter column branch_id set not null;
alter table public.purchases alter column branch_id set not null;
alter table public.inventory_units alter column branch_id set not null;

alter table public.sales add constraint sales_branch_shop_fk
  foreign key (shop_id, branch_id) references public.branches(shop_id, id);
alter table public.expenses add constraint expenses_branch_shop_fk
  foreign key (shop_id, branch_id) references public.branches(shop_id, id);
alter table public.day_sessions add constraint day_sessions_branch_shop_fk
  foreign key (shop_id, branch_id) references public.branches(shop_id, id);
alter table public.purchases add constraint purchases_branch_shop_fk
  foreign key (shop_id, branch_id) references public.branches(shop_id, id);
alter table public.inventory_units add constraint inventory_units_branch_shop_fk
  foreign key (shop_id, branch_id) references public.branches(shop_id, id);

create index if not exists sales_shop_branch_created_at_idx on public.sales(shop_id, branch_id, created_at desc);
create index if not exists expenses_shop_branch_date_idx on public.expenses(shop_id, branch_id, expense_date desc);
create index if not exists day_sessions_shop_branch_date_idx on public.day_sessions(shop_id, branch_id, session_date desc);
create index if not exists purchases_shop_branch_created_at_idx on public.purchases(shop_id, branch_id, created_at desc);
create index if not exists inventory_units_shop_branch_status_idx on public.inventory_units(shop_id, branch_id, status);

create or replace function private.assign_default_branch_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_branch_shop uuid;
begin
  if new.branch_id is null then
    select b.id into new.branch_id
    from public.branches b
    where b.shop_id = new.shop_id and b.is_default and b.active
    limit 1;
  end if;
  if new.branch_id is null then
    raise exception 'Branch is required and this shop has no active default branch';
  end if;
  select b.shop_id into v_branch_shop
  from public.branches b
  where b.id = new.branch_id and b.active;
  if v_branch_shop is null or v_branch_shop <> new.shop_id then
    raise exception 'Selected branch does not belong to this shop or is inactive';
  end if;
  return new;
end;
$function$;

revoke all on function private.assign_default_branch_id() from public, anon, authenticated;

drop trigger if exists sales_assign_branch on public.sales;
create trigger sales_assign_branch before insert or update of shop_id, branch_id on public.sales
for each row execute function private.assign_default_branch_id();
drop trigger if exists expenses_assign_branch on public.expenses;
create trigger expenses_assign_branch before insert or update of shop_id, branch_id on public.expenses
for each row execute function private.assign_default_branch_id();
drop trigger if exists day_sessions_assign_branch on public.day_sessions;
create trigger day_sessions_assign_branch before insert or update of shop_id, branch_id on public.day_sessions
for each row execute function private.assign_default_branch_id();
drop trigger if exists purchases_assign_branch on public.purchases;
create trigger purchases_assign_branch before insert or update of shop_id, branch_id on public.purchases
for each row execute function private.assign_default_branch_id();
drop trigger if exists inventory_units_assign_branch on public.inventory_units;
create trigger inventory_units_assign_branch before insert or update of shop_id, branch_id on public.inventory_units
for each row execute function private.assign_default_branch_id();

-- During the single-branch compatibility phase, legacy stock writes stay mirrored.
-- Once a second branch exists, branch-aware transactional RPCs must update branch_stock
-- and products.stock as the shop-wide total; this trigger then deliberately stops mirroring.
create or replace function private.mirror_single_branch_stock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_branch public.branches;
begin
  if tg_op = 'UPDATE' and new.stock is not distinct from old.stock then
    return new;
  end if;
  select b.* into v_branch
  from public.branches b
  where b.shop_id = new.shop_id and b.active
  order by b.is_default desc, b.created_at
  limit 1;
  if v_branch.id is not null and
     (select count(*) from public.branches b where b.shop_id = new.shop_id and b.active) = 1 then
    insert into public.branch_stock(shop_id, branch_id, product_id, qty, updated_at)
    values (new.shop_id, v_branch.id, new.id, new.stock, now())
    on conflict (branch_id, product_id) do update
      set qty = excluded.qty, updated_at = now();
  end if;
  return new;
end;
$function$;

revoke all on function private.mirror_single_branch_stock() from public, anon, authenticated;
drop trigger if exists products_mirror_single_branch_stock on public.products;
create trigger products_mirror_single_branch_stock
after insert or update of stock on public.products
for each row execute function private.mirror_single_branch_stock();

alter table public.branches enable row level security;
alter table public.branch_stock enable row level security;

drop policy if exists "branches member read" on public.branches;
create policy "branches member read" on public.branches
for select to authenticated using (private.is_shop_member(shop_id));
drop policy if exists "branches admin manage" on public.branches;
create policy "branches admin manage" on public.branches
for all to authenticated
using (private.is_shop_admin(shop_id))
with check (private.is_shop_admin(shop_id));

drop policy if exists "branch stock member read" on public.branch_stock;
create policy "branch stock member read" on public.branch_stock
for select to authenticated using (private.is_shop_member(shop_id));
drop policy if exists "branch stock admin manage" on public.branch_stock;
create policy "branch stock admin manage" on public.branch_stock
for all to authenticated
using (private.is_shop_admin(shop_id))
with check (private.is_shop_admin(shop_id));

grant select on public.branches, public.branch_stock to authenticated;
grant insert, update, delete on public.branches, public.branch_stock to authenticated;

-- Branch transfers are documents now; completion RPC is added after POS branch
-- binding so stock can never be moved through an incomplete client-side workflow.
create table if not exists public.stock_transfers (
  id uuid primary key default extensions.uuid_generate_v4(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  from_branch_id uuid not null,
  to_branch_id uuid not null,
  status text not null default 'draft' check (status in ('draft','completed','cancelled')),
  note text,
  created_by uuid not null default auth.uid() references auth.users(id),
  completed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  idempotency_key text,
  constraint stock_transfers_different_branches check (from_branch_id <> to_branch_id),
  constraint stock_transfers_idempotency_unique unique (shop_id, idempotency_key),
  constraint stock_transfers_from_branch_fk foreign key (shop_id, from_branch_id)
    references public.branches(shop_id, id),
  constraint stock_transfers_to_branch_fk foreign key (shop_id, to_branch_id)
    references public.branches(shop_id, id)
);

create table if not exists public.stock_transfer_lines (
  id uuid primary key default extensions.uuid_generate_v4(),
  transfer_id uuid not null references public.stock_transfers(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  product_id uuid not null,
  qty numeric(12,2) not null check (qty > 0),
  created_at timestamptz not null default now(),
  constraint stock_transfer_lines_product_fk foreign key (shop_id, product_id)
    references public.products(shop_id, id)
);

alter table public.stock_transfers enable row level security;
alter table public.stock_transfer_lines enable row level security;

drop policy if exists "stock transfers member read" on public.stock_transfers;
create policy "stock transfers member read" on public.stock_transfers
for select to authenticated using (private.is_shop_member(shop_id));
drop policy if exists "stock transfers admin manage" on public.stock_transfers;
create policy "stock transfers admin manage" on public.stock_transfers
for all to authenticated using (private.is_shop_admin(shop_id))
with check (private.is_shop_admin(shop_id));

drop policy if exists "stock transfer lines member read" on public.stock_transfer_lines;
create policy "stock transfer lines member read" on public.stock_transfer_lines
for select to authenticated using (private.is_shop_member(shop_id));
drop policy if exists "stock transfer lines admin manage" on public.stock_transfer_lines;
create policy "stock transfer lines admin manage" on public.stock_transfer_lines
for all to authenticated using (private.is_shop_admin(shop_id))
with check (private.is_shop_admin(shop_id));

grant select on public.stock_transfers, public.stock_transfer_lines to authenticated;
grant insert, update, delete on public.stock_transfers, public.stock_transfer_lines to authenticated;

-- Owner Web remains intentionally shop-level for Phase 1 compatibility.
comment on table public.branch_stock is
  'Phase 2 branch stock. Legacy products.stock remains the shop total during compatibility rollout; branch-aware sale/GRN/transfer RPCs must be deployed before creating additional active branches.';
comment on column public.owner_daily_sales.shop_id is
  'Shop-level aggregate retained for Owner Web Phase 1 backward compatibility; branch_id is intentionally not added in Phase 2.';
