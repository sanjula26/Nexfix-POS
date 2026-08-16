-- Production security layer for Nexfix POS.
-- Run AFTER the base schema. Review with the Supabase SQL editor before production.
-- No service_role key belongs in the browser.

create or replace function public.current_shop_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.id
  from public.shops s
  where s.id = nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'shop_id', '')::uuid;
$$;

-- A safer shop-membership table. Existing deployments can populate it from
-- their onboarding/admin process before enabling the policies below.
create table if not exists public.shop_members (
  shop_id uuid not null references public.shops(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin','manager','cashier','technician')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (shop_id, user_id)
);

create index if not exists idx_shop_members_user on public.shop_members(user_id, active);

create or replace function public.is_shop_member(target_shop uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.shop_members m
    where m.shop_id = target_shop
      and m.user_id = auth.uid()
      and m.active
  );
$$;

-- SECURITY DEFINER helpers avoid recursive RLS checks when policies inspect membership.
revoke all on function public.is_shop_member(uuid) from public;
grant execute on function public.is_shop_member(uuid) to authenticated;

-- Protect the membership table itself.
alter table public.shop_members enable row level security;
drop policy if exists shop_members_self_read on public.shop_members;
create policy shop_members_self_read on public.shop_members
  for select to authenticated
  using (user_id = auth.uid());

-- Remove broad authenticated policies from the core tenant tables.
drop policy if exists "Authenticated full access profiles" on public.profiles;
drop policy if exists "Authenticated full access shops" on public.shops;

create policy profiles_member_read on public.profiles
  for select to authenticated
  using (id = auth.uid() or exists (
    select 1 from public.shop_members m
    where m.user_id = public.profiles.id
      and m.shop_id in (select current_shop_ids())
      and m.active
  ));

create policy shops_member_read on public.shops
  for select to authenticated
  using (public.is_shop_member(id));

-- Core tenant tables: no cross-shop reads/writes.
do $$
declare
  t text;
begin
  foreach t in array array['products','customers','sales','repairs','inventory_units','purchases','purchase_items','sale_items','sale_payments','quotations','quotation_items','warranty_claims','expenses','day_sessions','audit_log','counters'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_select on public.%I', t);
    execute format('drop policy if exists tenant_insert on public.%I', t);
    execute format('drop policy if exists tenant_update on public.%I', t);
    execute format('drop policy if exists tenant_delete on public.%I', t);
    execute format('create policy tenant_select on public.%I for select to authenticated using (public.is_shop_member(shop_id))', t);
    execute format('create policy tenant_insert on public.%I for insert to authenticated with check (public.is_shop_member(shop_id))', t);
    execute format('create policy tenant_update on public.%I for update to authenticated using (public.is_shop_member(shop_id)) with check (public.is_shop_member(shop_id))', t);
    execute format('create policy tenant_delete on public.%I for delete to authenticated using (public.is_shop_member(shop_id))', t);
  end loop;
end $$;

-- Atomic stock decrement. The row lock prevents two PCs selling the same stock.
create or replace function public.decrement_stock(
  p_shop_id uuid,
  p_product_id uuid,
  p_qty numeric
)
returns numeric
language plpgsql
security invoker
set search_path = public
as $$
declare
  remaining numeric;
begin
  if p_qty <= 0 then raise exception 'Quantity must be greater than zero'; end if;
  if not public.is_shop_member(p_shop_id) then raise exception 'Unauthorized shop'; end if;

  update public.products
     set stock = stock - p_qty,
         updated_at = now()
   where id = p_product_id
     and shop_id = p_shop_id
     and stock >= p_qty
   returning stock into remaining;

  if not found then
    raise exception 'Insufficient stock or product not found';
  end if;
  return remaining;
end;
$$;

grant execute on function public.decrement_stock(uuid, uuid, numeric) to authenticated;

-- Audit writes are append-only from the application side: no update/delete policy is created.
alter table public.audit_log enable row level security;

comment on table public.shop_members is 'Tenant membership used by production RLS. Populate this table during onboarding before enabling cloud writes.';
comment on function public.decrement_stock(uuid, uuid, numeric) is 'Atomic stock decrement with row-level authorization and insufficient-stock protection.';
