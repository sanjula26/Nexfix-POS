-- Phone Sales reads sales by tenant and creation date. Keep this query indexable
-- as shop history grows; this does not change sale semantics or access control.
create index if not exists idx_sales_shop_created_at
  on public.sales (shop_id, created_at desc);
