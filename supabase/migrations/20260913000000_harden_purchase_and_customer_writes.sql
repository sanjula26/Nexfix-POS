-- Harden destructive and stock-affecting cloud writes.
-- UI permissions are not a security boundary; direct Supabase writes must
-- enforce the same shop-admin boundary at RLS level.

-- Purchases affect inventory/cost and must be managed by shop admins/managers.
drop policy if exists "purchases member access" on public.purchases;
create policy "purchases member read" on public.purchases
  for select to authenticated using (is_shop_member(shop_id));
create policy "purchases manager insert" on public.purchases
  for insert to authenticated with check (is_shop_admin(shop_id));
create policy "purchases manager update" on public.purchases
  for update to authenticated using (is_shop_admin(shop_id)) with check (is_shop_admin(shop_id));
create policy "purchases manager delete" on public.purchases
  for delete to authenticated using (is_shop_admin(shop_id));

-- Purchase line mutations are restricted to the same shop-admin boundary.
drop policy if exists "purchase items member access" on public.purchase_items;
create policy "purchase items member read" on public.purchase_items
  for select to authenticated using (
    exists (
      select 1 from public.purchases p
      where p.id = purchase_items.purchase_id
        and is_shop_member(p.shop_id)
    )
  );
create policy "purchase items manager insert" on public.purchase_items
  for insert to authenticated with check (
    exists (
      select 1 from public.purchases p
      where p.id = purchase_items.purchase_id
        and is_shop_admin(p.shop_id)
    )
  );
create policy "purchase items manager update" on public.purchase_items
  for update to authenticated using (
    exists (
      select 1 from public.purchases p
      where p.id = purchase_items.purchase_id
        and is_shop_admin(p.shop_id)
    )
  ) with check (
    exists (
      select 1 from public.purchases p
      where p.id = purchase_items.purchase_id
        and is_shop_admin(p.shop_id)
    )
  );
create policy "purchase items manager delete" on public.purchase_items
  for delete to authenticated using (
    exists (
      select 1 from public.purchases p
      where p.id = purchase_items.purchase_id
        and is_shop_admin(p.shop_id)
    )
  );

-- Customers may be created/edited by shop members for normal POS operation,
-- but destructive deletion is an admin/manager operation.
drop policy if exists "customers member access" on public.customers;
create policy "customers member read" on public.customers
  for select to authenticated using (is_shop_member(shop_id));
create policy "customers member insert" on public.customers
  for insert to authenticated with check (is_shop_member(shop_id));
create policy "customers member update" on public.customers
  for update to authenticated using (is_shop_member(shop_id)) with check (is_shop_member(shop_id));
create policy "customers manager delete" on public.customers
  for delete to authenticated using (is_shop_admin(shop_id));
