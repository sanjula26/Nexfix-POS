drop policy if exists "brands member access" on public.brands;
create policy "brands member read" on public.brands for select to authenticated using ((select private.is_shop_member(shop_id)));
create policy "brands admin write" on public.brands for insert to authenticated with check ((select private.is_shop_admin(shop_id)));
create policy "brands admin update" on public.brands for update to authenticated using ((select private.is_shop_admin(shop_id))) with check ((select private.is_shop_admin(shop_id)));
create policy "brands admin delete" on public.brands for delete to authenticated using ((select private.is_shop_admin(shop_id)));

drop policy if exists "categories member access" on public.categories;
create policy "categories member read" on public.categories for select to authenticated using ((select private.is_shop_member(shop_id)));
create policy "categories admin write" on public.categories for insert to authenticated with check ((select private.is_shop_admin(shop_id)));
create policy "categories admin update" on public.categories for update to authenticated using ((select private.is_shop_admin(shop_id))) with check ((select private.is_shop_admin(shop_id)));
create policy "categories admin delete" on public.categories for delete to authenticated using ((select private.is_shop_admin(shop_id)));

drop policy if exists "kit items member access" on public.kit_items;
create policy "kit items member read" on public.kit_items for select to authenticated using (
  exists (select 1 from public.products p where p.id=kit_product_id and (select private.is_shop_member(p.shop_id)))
  and exists (select 1 from public.products c where c.id=component_product_id and c.shop_id=(select p2.shop_id from public.products p2 where p2.id=kit_product_id))
);
create policy "kit items admin insert" on public.kit_items for insert to authenticated with check (
  exists (select 1 from public.products p where p.id=kit_product_id and (select private.is_shop_admin(p.shop_id)))
  and exists (select 1 from public.products c where c.id=component_product_id and c.shop_id=(select p2.shop_id from public.products p2 where p2.id=kit_product_id))
);
create policy "kit items admin update" on public.kit_items for update to authenticated using (
  exists (select 1 from public.products p where p.id=kit_product_id and (select private.is_shop_admin(p.shop_id)))
) with check (
  exists (select 1 from public.products p where p.id=kit_product_id and (select private.is_shop_admin(p.shop_id)))
  and exists (select 1 from public.products c where c.id=component_product_id and c.shop_id=(select p2.shop_id from public.products p2 where p2.id=kit_product_id))
);
create policy "kit items admin delete" on public.kit_items for delete to authenticated using (
  exists (select 1 from public.products p where p.id=kit_product_id and (select private.is_shop_admin(p.shop_id)))
);
