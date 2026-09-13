-- Sales are created through the authoritative atomic RPC. Prevent direct
-- client-side inserts/edits from bypassing totals, stock and payment rules.

drop policy if exists "sales member insert" on public.sales;
create policy "sales manager insert" on public.sales
  for insert to authenticated with check (is_shop_admin(shop_id));

-- Keep sale history readable to shop members, but make direct mutation an
-- admin/manager operation. The atomic sale/return RPCs remain the controlled
-- operational path for cashiers.
drop policy if exists "sale items member access" on public.sale_items;
create policy "sale items member read" on public.sale_items
  for select to authenticated using (
    exists (
      select 1 from public.sales s
      where s.id = sale_items.sale_id
        and is_shop_member(s.shop_id)
    )
  );
create policy "sale items manager insert" on public.sale_items
  for insert to authenticated with check (
    exists (
      select 1 from public.sales s
      where s.id = sale_items.sale_id
        and is_shop_admin(s.shop_id)
    )
  );
create policy "sale items manager update" on public.sale_items
  for update to authenticated using (
    exists (
      select 1 from public.sales s
      where s.id = sale_items.sale_id
        and is_shop_admin(s.shop_id)
    )
  ) with check (
    exists (
      select 1 from public.sales s
      where s.id = sale_items.sale_id
        and is_shop_admin(s.shop_id)
    )
  );
create policy "sale items manager delete" on public.sale_items
  for delete to authenticated using (
    exists (
      select 1 from public.sales s
      where s.id = sale_items.sale_id
        and is_shop_admin(s.shop_id)
    )
  );

drop policy if exists "sale payments member access" on public.sale_payments;
create policy "sale payments member read" on public.sale_payments
  for select to authenticated using (
    exists (
      select 1 from public.sales s
      where s.id = sale_payments.sale_id
        and is_shop_member(s.shop_id)
    )
  );
create policy "sale payments manager insert" on public.sale_payments
  for insert to authenticated with check (
    exists (
      select 1 from public.sales s
      where s.id = sale_payments.sale_id
        and is_shop_admin(s.shop_id)
    )
  );
create policy "sale payments manager update" on public.sale_payments
  for update to authenticated using (
    exists (
      select 1 from public.sales s
      where s.id = sale_payments.sale_id
        and is_shop_admin(s.shop_id)
    )
  ) with check (
    exists (
      select 1 from public.sales s
      where s.id = sale_payments.sale_id
        and is_shop_admin(s.shop_id)
    )
  );
create policy "sale payments manager delete" on public.sale_payments
  for delete to authenticated using (
    exists (
      select 1 from public.sales s
      where s.id = sale_payments.sale_id
        and is_shop_admin(s.shop_id)
    )
  );
