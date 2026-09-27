create index if not exists idx_phone_sales_tokens_created_by_fk on public.phone_sales_tokens(created_by);
create index if not exists idx_sale_reversal_requests_requested_by_fk on public.sale_reversal_requests(requested_by);
create index if not exists idx_sale_reversal_requests_reviewed_by_fk on public.sale_reversal_requests(reviewed_by);
create index if not exists idx_sale_reversal_requests_sale_id_fk on public.sale_reversal_requests(sale_id);
