-- Harden supplier-return read access and foreign-key indexes.

create index if not exists purchase_returns_purchase_id_idx
  on public.purchase_returns(purchase_id);

create index if not exists purchase_return_items_product_id_idx
  on public.purchase_return_items(product_id);

drop policy if exists "purchase returns member read" on public.purchase_returns;
create policy "purchase returns member read"
  on public.purchase_returns
  for select
  to authenticated
  using (private.is_shop_member(shop_id));

drop policy if exists "purchase return items member read" on public.purchase_return_items;
create policy "purchase return items member read"
  on public.purchase_return_items
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.purchase_returns r
      where r.id = purchase_return_items.return_id
        and private.is_shop_member(r.shop_id)
    )
  );

drop policy if exists "purchase return units member read" on public.purchase_return_units;
create policy "purchase return units member read"
  on public.purchase_return_units
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.purchase_return_items ri
      join public.purchase_returns r on r.id = ri.return_id
      where ri.id = purchase_return_units.return_item_id
        and private.is_shop_member(r.shop_id)
    )
  );