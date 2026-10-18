-- Prevent authenticated clients from directly editing customer credit balances or loyalty points.
-- Those financial fields must change only inside trusted SECURITY DEFINER transaction RPCs
-- (atomic sales and returns). Normal customer create/edit sync only needs the non-financial columns.

revoke insert, update on table public.customers from public, anon, authenticated;
-- Table-level REVOKE does not remove separately granted column-level privileges.
-- Explicitly revoke these financial columns as defense in depth against older grants.
revoke insert (credit_balance, loyalty_points), update (credit_balance, loyalty_points)
  on table public.customers from public, anon, authenticated;

grant insert (
  id, shop_id, name, phone, email, nic, address, credit_limit, notes, created_at, updated_at
) on table public.customers to authenticated;

grant update (
  name, phone, email, nic, address, credit_limit, notes, updated_at
) on table public.customers to authenticated;
