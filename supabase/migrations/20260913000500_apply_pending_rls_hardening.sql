-- Apply the remaining RLS hardening against the current private helper API.
-- Earlier migrations were authored before shop-membership helpers moved to
-- private.*. Keep this as a forward-only compatibility migration.

-- Supplier master data: members may read; admins/managers mutate.
drop policy if exists "suppliers member access" on public.suppliers;
drop policy if exists "suppliers member read" on public.suppliers;
drop policy if exists "suppliers manager insert" on public.suppliers;
drop policy if exists "suppliers manager update" on public.suppliers;
drop policy if exists "suppliers manager delete" on public.suppliers;
create policy "suppliers member read" on public.suppliers
  for select to authenticated using (private.is_shop_member(shop_id));
create policy "suppliers manager insert" on public.suppliers
  for insert to authenticated with check (private.is_shop_admin(shop_id));
create policy "suppliers manager update" on public.suppliers
  for update to authenticated using (private.is_shop_admin(shop_id)) with check (private.is_shop_admin(shop_id));
create policy "suppliers manager delete" on public.suppliers
  for delete to authenticated using (private.is_shop_admin(shop_id));

-- Expenses: members may read; admins/managers mutate.
drop policy if exists "expenses member access" on public.expenses;
drop policy if exists "expenses member read" on public.expenses;
drop policy if exists "expenses manager insert" on public.expenses;
drop policy if exists "expenses manager update" on public.expenses;
drop policy if exists "expenses manager delete" on public.expenses;
create policy "expenses member read" on public.expenses
  for select to authenticated using (private.is_shop_member(shop_id));
create policy "expenses manager insert" on public.expenses
  for insert to authenticated with check (private.is_shop_admin(shop_id));
create policy "expenses manager update" on public.expenses
  for update to authenticated using (private.is_shop_admin(shop_id)) with check (private.is_shop_admin(shop_id));
create policy "expenses manager delete" on public.expenses
  for delete to authenticated using (private.is_shop_admin(shop_id));

-- Tracked inventory units: only admins/managers may mutate stock identity.
drop policy if exists "inventory units member access" on public.inventory_units;
drop policy if exists "inventory units member read" on public.inventory_units;
drop policy if exists "inventory units manager insert" on public.inventory_units;
drop policy if exists "inventory units manager update" on public.inventory_units;
drop policy if exists "inventory units manager delete" on public.inventory_units;
create policy "inventory units member read" on public.inventory_units
  for select to authenticated using (private.is_shop_member(shop_id));
create policy "inventory units manager insert" on public.inventory_units
  for insert to authenticated with check (private.is_shop_admin(shop_id));
create policy "inventory units manager update" on public.inventory_units
  for update to authenticated using (private.is_shop_admin(shop_id)) with check (private.is_shop_admin(shop_id));
create policy "inventory units manager delete" on public.inventory_units
  for delete to authenticated using (private.is_shop_admin(shop_id));

-- Direct sale/child writes must not bypass the authoritative atomic sale path.
drop policy if exists "sales member insert" on public.sales;
create policy "sales manager insert" on public.sales
  for insert to authenticated with check (private.is_shop_admin(shop_id));

drop policy if exists "sale items member access" on public.sale_items;
drop policy if exists "sale items member read" on public.sale_items;
drop policy if exists "sale items manager insert" on public.sale_items;
drop policy if exists "sale items manager update" on public.sale_items;
drop policy if exists "sale items manager delete" on public.sale_items;
create policy "sale items member read" on public.sale_items
  for select to authenticated using (exists (select 1 from public.sales s where s.id = sale_items.sale_id and private.is_shop_member(s.shop_id)));
create policy "sale items manager insert" on public.sale_items
  for insert to authenticated with check (exists (select 1 from public.sales s where s.id = sale_items.sale_id and private.is_shop_admin(s.shop_id)));
create policy "sale items manager update" on public.sale_items
  for update to authenticated using (exists (select 1 from public.sales s where s.id = sale_items.sale_id and private.is_shop_admin(s.shop_id))) with check (exists (select 1 from public.sales s where s.id = sale_items.sale_id and private.is_shop_admin(s.shop_id)));
create policy "sale items manager delete" on public.sale_items
  for delete to authenticated using (exists (select 1 from public.sales s where s.id = sale_items.sale_id and private.is_shop_admin(s.shop_id)));

drop policy if exists "sale payments member access" on public.sale_payments;
drop policy if exists "sale payments member read" on public.sale_payments;
drop policy if exists "sale payments manager insert" on public.sale_payments;
drop policy if exists "sale payments manager update" on public.sale_payments;
drop policy if exists "sale payments manager delete" on public.sale_payments;
create policy "sale payments member read" on public.sale_payments
  for select to authenticated using (exists (select 1 from public.sales s where s.id = sale_payments.sale_id and private.is_shop_member(s.shop_id)));
create policy "sale payments manager insert" on public.sale_payments
  for insert to authenticated with check (exists (select 1 from public.sales s where s.id = sale_payments.sale_id and private.is_shop_admin(s.shop_id)));
create policy "sale payments manager update" on public.sale_payments
  for update to authenticated using (exists (select 1 from public.sales s where s.id = sale_payments.sale_id and private.is_shop_admin(s.shop_id))) with check (exists (select 1 from public.sales s where s.id = sale_payments.sale_id and private.is_shop_admin(s.shop_id)));
create policy "sale payments manager delete" on public.sale_payments
  for delete to authenticated using (exists (select 1 from public.sales s where s.id = sale_payments.sale_id and private.is_shop_admin(s.shop_id)));

-- Prevent ordinary users from changing authorization-bearing profile fields.
create or replace function public.prevent_profile_privilege_self_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then return new; end if;
  if new.role is distinct from old.role
     or new.active is distinct from old.active
     or new.commission_pct is distinct from old.commission_pct then
    if not exists (
      select 1 from public.shop_memberships m
      where m.user_id = auth.uid()
        and m.active = true
        and m.role in ('admin', 'manager')
    ) then
      raise exception 'Only a shop admin or manager may change profile authorization fields';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists protect_profile_privilege_fields on public.profiles;
create trigger protect_profile_privilege_fields
before update on public.profiles
for each row execute function public.prevent_profile_privilege_self_change();
