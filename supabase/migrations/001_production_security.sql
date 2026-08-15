-- Nexfix POS production security migration
-- Run after supabase/schema.sql. The original schema used broad
-- authenticated=full-access policies; this migration replaces them with
-- shop-scoped access and a controlled bootstrap path.

create table if not exists public.shop_memberships (
  user_id uuid not null references auth.users(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  role text not null default 'cashier' check (role in ('admin','manager','cashier','technician','inventory_manager')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (user_id, shop_id)
);

create index if not exists idx_shop_memberships_shop on public.shop_memberships(shop_id);

alter table public.shop_memberships enable row level security;

create or replace function public.is_shop_member(target_shop uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.shop_memberships m
    where m.user_id = auth.uid()
      and m.shop_id = target_shop
      and m.active = true
  );
$$;

create or replace function public.is_shop_admin(target_shop uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.shop_memberships m
    where m.user_id = auth.uid()
      and m.shop_id = target_shop
      and m.active = true
      and m.role in ('admin','manager')
  );
$$;

-- Only the authenticated user may read their memberships. Admins can manage
-- memberships for their own shop through a server-side function later.
drop policy if exists "members read own" on public.shop_memberships;
create policy "members read own" on public.shop_memberships
  for select to authenticated using (user_id = auth.uid() or is_shop_admin(shop_id));

-- Profiles: users can see/update their own profile; shop admins can read
-- profiles belonging to their shop. Role changes are not exposed as a broad
-- client-side write operation.
drop policy if exists "Authenticated full access profiles" on public.profiles;
create policy "profile self read" on public.profiles
  for select to authenticated using (id = auth.uid());
create policy "profile shop admin read" on public.profiles
  for select to authenticated using (
    exists (select 1 from public.shop_memberships m
            where m.user_id = profiles.id and is_shop_admin(m.shop_id))
  );
create policy "profile self update" on public.profiles
  for update to authenticated using (id = auth.uid())
  with check (id = auth.uid());

-- Shop access is membership scoped.
drop policy if exists "Authenticated full access shops" on public.shops;
create policy "shop member read" on public.shops
  for select to authenticated using (is_shop_member(id));
create policy "shop admin update" on public.shops
  for update to authenticated using (is_shop_admin(id)) with check (is_shop_admin(id));

-- Helper: apply the same shop policy shape to the main business tables.
-- Explicit policies are used instead of a permissive catch-all.

drop policy if exists "Authenticated full access products" on public.products;
create policy "products member read" on public.products
  for select to authenticated using (is_shop_member(shop_id));
create policy "products manager write" on public.products
  for insert to authenticated with check (is_shop_admin(shop_id));
create policy "products manager update" on public.products
  for update to authenticated using (is_shop_admin(shop_id)) with check (is_shop_admin(shop_id));
create policy "products manager delete" on public.products
  for delete to authenticated using (is_shop_admin(shop_id));

-- Tables with shop_id are protected by membership. Child tables are protected
-- through their parent shop relationship.
drop policy if exists "Authenticated full access customers" on public.customers;
create policy "customers member access" on public.customers
  for all to authenticated using (is_shop_member(shop_id)) with check (is_shop_member(shop_id));

drop policy if exists "Authenticated full access sales" on public.sales;
create policy "sales member read" on public.sales
  for select to authenticated using (is_shop_member(shop_id));
create policy "sales member insert" on public.sales
  for insert to authenticated with check (is_shop_member(shop_id));
create policy "sales manager update" on public.sales
  for update to authenticated using (is_shop_admin(shop_id)) with check (is_shop_admin(shop_id));

-- Repairs
drop policy if exists "Authenticated full access repairs" on public.repairs;
create policy "repairs member access" on public.repairs
  for all to authenticated using (is_shop_member(shop_id)) with check (is_shop_member(shop_id));

-- Remaining shop-owned tables.
create policy "suppliers member access" on public.suppliers
  for all to authenticated using (is_shop_member(shop_id)) with check (is_shop_member(shop_id));
create policy "purchases member access" on public.purchases
  for all to authenticated using (is_shop_member(shop_id)) with check (is_shop_member(shop_id));
create policy "quotations member access" on public.quotations
  for all to authenticated using (is_shop_member(shop_id)) with check (is_shop_member(shop_id));
create policy "warranty member access" on public.warranty_claims
  for all to authenticated using (is_shop_member(shop_id)) with check (is_shop_member(shop_id));
create policy "expenses member access" on public.expenses
  for all to authenticated using (is_shop_member(shop_id)) with check (is_shop_member(shop_id));
create policy "sessions member access" on public.day_sessions
  for all to authenticated using (is_shop_member(shop_id)) with check (is_shop_member(shop_id));
create policy "audit member read" on public.audit_log
  for select to authenticated using (is_shop_member(shop_id));

-- Child-table policies.
create policy "purchase items member access" on public.purchase_items
  for all to authenticated using (
    exists (select 1 from public.purchases p where p.id = purchase_items.purchase_id and is_shop_member(p.shop_id))
  ) with check (
    exists (select 1 from public.purchases p where p.id = purchase_items.purchase_id and is_shop_member(p.shop_id))
  );
create policy "sale items member access" on public.sale_items
  for all to authenticated using (
    exists (select 1 from public.sales s where s.id = sale_items.sale_id and is_shop_member(s.shop_id))
  ) with check (
    exists (select 1 from public.sales s where s.id = sale_items.sale_id and is_shop_member(s.shop_id))
  );
create policy "sale payments member access" on public.sale_payments
  for all to authenticated using (
    exists (select 1 from public.sales s where s.id = sale_payments.sale_id and is_shop_member(s.shop_id))
  ) with check (
    exists (select 1 from public.sales s where s.id = sale_payments.sale_id and is_shop_member(s.shop_id))
  );
create policy "repair parts member access" on public.repair_parts
  for all to authenticated using (
    exists (select 1 from public.repairs r where r.id = repair_parts.repair_id and is_shop_member(r.shop_id))
  ) with check (
    exists (select 1 from public.repairs r where r.id = repair_parts.repair_id and is_shop_member(r.shop_id))
  );
create policy "inventory units member access" on public.inventory_units
  for all to authenticated using (is_shop_member(shop_id)) with check (is_shop_member(shop_id));

-- RLS must be enabled for every business table, not only six of them.
alter table public.shop_memberships enable row level security;
alter table public.categories enable row level security;
alter table public.brands enable row level security;
alter table public.kit_items enable row level security;
alter table public.inventory_units enable row level security;
alter table public.suppliers enable row level security;
alter table public.purchases enable row level security;
alter table public.purchase_items enable row level security;
alter table public.sale_items enable row level security;
alter table public.sale_payments enable row level security;
alter table public.quotations enable row level security;
alter table public.quotation_items enable row level security;
alter table public.repair_parts enable row level security;
alter table public.warranty_claims enable row level security;
alter table public.expenses enable row level security;
alter table public.day_sessions enable row level security;
alter table public.audit_log enable row level security;
alter table public.counters enable row level security;

-- Categories/brands are accessed through their shop.
create policy "categories member access" on public.categories
  for all to authenticated using (is_shop_member(shop_id)) with check (is_shop_member(shop_id));
create policy "brands member access" on public.brands
  for all to authenticated using (is_shop_member(shop_id)) with check (is_shop_member(shop_id));

-- Kit items are protected through their kit product's shop.
create policy "kit items member access" on public.kit_items
  for all to authenticated using (
    exists (select 1 from public.products p where p.id = kit_items.kit_product_id and is_shop_member(p.shop_id))
  ) with check (
    exists (select 1 from public.products p where p.id = kit_items.kit_product_id and is_shop_member(p.shop_id))
  );

create policy "quotation items member access" on public.quotation_items
  for all to authenticated using (
    exists (select 1 from public.quotations q where q.id = quotation_items.quotation_id and is_shop_member(q.shop_id))
  ) with check (
    exists (select 1 from public.quotations q where q.id = quotation_items.quotation_id and is_shop_member(q.shop_id))
  );

create policy "counters member access" on public.counters
  for select to authenticated using (is_shop_member(shop_id));

-- Prevent public signup metadata from assigning privileged roles.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'full_name', split_part(coalesce(new.email,''), '@', 1)),
    'cashier'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- First-login bootstrap: the first authenticated user can create the first
-- shop once. It is intentionally limited to an empty database.
create or replace function public.bootstrap_first_shop(shop_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_shop uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if exists (select 1 from public.shops) then raise exception 'Bootstrap already completed'; end if;
  if length(trim(shop_name)) < 2 then raise exception 'Shop name is required'; end if;

  insert into public.shops(name) values (trim(shop_name)) returning id into new_shop;
  insert into public.shop_memberships(user_id, shop_id, role)
    values (auth.uid(), new_shop, 'admin');
  update public.profiles set role = 'admin', updated_at = now() where id = auth.uid();
  insert into public.counters(shop_id) values (new_shop);
  return new_shop;
end;
$$;
revoke all on function public.bootstrap_first_shop(text) from public;
grant execute on function public.bootstrap_first_shop(text) to authenticated;
