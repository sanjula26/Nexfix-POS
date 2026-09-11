-- Least-privilege hardening: the browser never uses the anonymous role for POS tables.
-- RLS remains the authorization boundary for authenticated users.
revoke all on table public.audit_log, public.brands, public.categories, public.counters,
  public.customers, public.day_sessions, public.expenses, public.inventory_units,
  public.kit_items, public.products, public.profiles, public.purchase_items,
  public.purchases, public.quotation_items, public.quotations, public.repair_parts,
  public.repairs, public.sale_items, public.sale_payments, public.sales,
  public.sale_return_items, public.sale_returns, public.shop_memberships,
  public.shops, public.suppliers, public.warranty_claims from anon;
