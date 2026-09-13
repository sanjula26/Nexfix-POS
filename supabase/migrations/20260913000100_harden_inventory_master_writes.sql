-- Continue the RLS hardening for inventory/master data.
-- Shop membership permits operational reads; stock/master mutations require
-- admin or manager access at the database boundary.

-- Suppliers are master data and must not be deleted/rewritten by cashiers.
drop policy if exists "suppliers member access" on public.suppliers;
create policy "suppliers member read" on public.suppliers
  for select to authenticated using (is_shop_member(shop_id));
create policy "suppliers manager insert" on public.suppliers
  for insert to authenticated with check (is_shop_admin(shop_id));
create policy "suppliers manager update" on public.suppliers
  for update to authenticated using (is_shop_admin(shop_id)) with check (is_shop_admin(shop_id));
create policy "suppliers manager delete" on public.suppliers
  for delete to authenticated using (is_shop_admin(shop_id));

-- Tracked inventory units directly affect stock identity (IMEI/serial).
drop policy if exists "inventory units member access" on public.inventory_units;
create policy "inventory units member read" on public.inventory_units
  for select to authenticated using (is_shop_member(shop_id));
create policy "inventory units manager insert" on public.inventory_units
  for insert to authenticated with check (is_shop_admin(shop_id));
create policy "inventory units manager update" on public.inventory_units
  for update to authenticated using (is_shop_admin(shop_id)) with check (is_shop_admin(shop_id));
create policy "inventory units manager delete" on public.inventory_units
  for delete to authenticated using (is_shop_admin(shop_id));

-- Category/brand master data is also stock-management data.
drop policy if exists "categories member access" on public.categories;
create policy "categories member read" on public.categories
  for select to authenticated using (is_shop_member(shop_id));
create policy "categories manager insert" on public.categories
  for insert to authenticated with check (is_shop_admin(shop_id));
create policy "categories manager update" on public.categories
  for update to authenticated using (is_shop_admin(shop_id)) with check (is_shop_admin(shop_id));
create policy "categories manager delete" on public.categories
  for delete to authenticated using (is_shop_admin(shop_id));

drop policy if exists "brands member access" on public.brands;
create policy "brands member read" on public.brands
  for select to authenticated using (is_shop_member(shop_id));
create policy "brands manager insert" on public.brands
  for insert to authenticated with check (is_shop_admin(shop_id));
create policy "brands manager update" on public.brands
  for update to authenticated using (is_shop_admin(shop_id)) with check (is_shop_admin(shop_id));
create policy "brands manager delete" on public.brands
  for delete to authenticated using (is_shop_admin(shop_id));

-- BOM/kit lines inherit authorization from the kit product's shop.
drop policy if exists "kit items member access" on public.kit_items;
create policy "kit items member read" on public.kit_items
  for select to authenticated using (
    exists (
      select 1 from public.products p
      where p.id = kit_items.kit_product_id
        and is_shop_member(p.shop_id)
    )
  );
create policy "kit items manager insert" on public.kit_items
  for insert to authenticated with check (
    exists (
      select 1 from public.products p
      where p.id = kit_items.kit_product_id
        and is_shop_admin(p.shop_id)
    )
  );
create policy "kit items manager update" on public.kit_items
  for update to authenticated using (
    exists (
      select 1 from public.products p
      where p.id = kit_items.kit_product_id
        and is_shop_admin(p.shop_id)
    )
  ) with check (
    exists (
      select 1 from public.products p
      where p.id = kit_items.kit_product_id
        and is_shop_admin(p.shop_id)
    )
  );
create policy "kit items manager delete" on public.kit_items
  for delete to authenticated using (
    exists (
      select 1 from public.products p
      where p.id = kit_items.kit_product_id
        and is_shop_admin(p.shop_id)
    )
  );
