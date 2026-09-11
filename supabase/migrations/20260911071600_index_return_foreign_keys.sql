create index if not exists idx_sale_return_items_product_id_fk on public.sale_return_items(product_id);
create index if not exists idx_sale_returns_created_by_fk on public.sale_returns(created_by);
create index if not exists idx_sale_returns_sale_id_fk on public.sale_returns(sale_id);
