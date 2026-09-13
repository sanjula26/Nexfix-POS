-- Harden financial/master-data writes that were still member-writable.
-- UI permission checks are not a security boundary; direct Supabase writes
-- must enforce the same shop-admin boundary at RLS level.

-- Supplier master data is administrative data. Members may read it, but only
-- shop admins/managers may create, edit, or delete suppliers.
drop policy if exists "suppliers member access" on public.suppliers;
create policy "suppliers member read" on public.suppliers
  for select to authenticated using (is_shop_member(shop_id));
create policy "suppliers manager insert" on public.suppliers
  for insert to authenticated with check (is_shop_admin(shop_id));
create policy "suppliers manager update" on public.suppliers
  for update to authenticated using (is_shop_admin(shop_id)) with check (is_shop_admin(shop_id));
create policy "suppliers manager delete" on public.suppliers
  for delete to authenticated using (is_shop_admin(shop_id));

-- Expenses directly affect shop financial records. Keep read access for shop
-- members, while restricting all mutations to admins/managers.
drop policy if exists "expenses member access" on public.expenses;
create policy "expenses member read" on public.expenses
  for select to authenticated using (is_shop_member(shop_id));
create policy "expenses manager insert" on public.expenses
  for insert to authenticated with check (is_shop_admin(shop_id));
create policy "expenses manager update" on public.expenses
  for update to authenticated using (is_shop_admin(shop_id)) with check (is_shop_admin(shop_id));
create policy "expenses manager delete" on public.expenses
  for delete to authenticated using (is_shop_admin(shop_id));
