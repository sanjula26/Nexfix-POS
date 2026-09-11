-- Nexfix POS: add covering indexes for foreign-key columns flagged by the
-- Supabase performance advisor. These indexes improve joins, parent deletes,
-- RLS membership checks and common lookup paths without changing data.

create index if not exists idx_audit_log_shop_id_fk on public.audit_log(shop_id);
create index if not exists idx_audit_log_user_id_fk on public.audit_log(user_id);
create index if not exists idx_categories_parent_id_fk on public.categories(parent_id);
create index if not exists idx_customers_shop_id_fk on public.customers(shop_id);
create index if not exists idx_day_sessions_cashier_id_fk on public.day_sessions(cashier_id);
create index if not exists idx_day_sessions_shop_id_fk on public.day_sessions(shop_id);
create index if not exists idx_expenses_created_by_fk on public.expenses(created_by);
create index if not exists idx_expenses_shop_id_fk on public.expenses(shop_id);
create index if not exists idx_inventory_units_shop_id_fk on public.inventory_units(shop_id);
create index if not exists idx_kit_items_component_product_id_fk on public.kit_items(component_product_id);
create index if not exists idx_pos_shops_created_by_fk on public.pos_shops(created_by);
create index if not exists idx_pos_state_snapshots_updated_by_fk on public.pos_state_snapshots(updated_by);
create index if not exists idx_products_brand_id_fk on public.products(brand_id);
create index if not exists idx_products_category_id_fk on public.products(category_id);
create index if not exists idx_purchase_items_product_id_fk on public.purchase_items(product_id);
create index if not exists idx_purchase_items_purchase_id_fk on public.purchase_items(purchase_id);
create index if not exists idx_purchases_created_by_fk on public.purchases(created_by);
create index if not exists idx_purchases_shop_id_fk on public.purchases(shop_id);
create index if not exists idx_purchases_supplier_id_fk on public.purchases(supplier_id);
create index if not exists idx_quotation_items_product_id_fk on public.quotation_items(product_id);
create index if not exists idx_quotation_items_quotation_id_fk on public.quotation_items(quotation_id);
create index if not exists idx_quotations_converted_sale_id_fk on public.quotations(converted_sale_id);
create index if not exists idx_quotations_created_by_fk on public.quotations(created_by);
create index if not exists idx_quotations_customer_id_fk on public.quotations(customer_id);
create index if not exists idx_quotations_shop_id_fk on public.quotations(shop_id);
create index if not exists idx_repair_parts_product_id_fk on public.repair_parts(product_id);
create index if not exists idx_repair_parts_repair_id_fk on public.repair_parts(repair_id);
create index if not exists idx_repairs_created_by_fk on public.repairs(created_by);
create index if not exists idx_repairs_customer_id_fk on public.repairs(customer_id);
create index if not exists idx_repairs_shop_id_fk on public.repairs(shop_id);
create index if not exists idx_repairs_technician_id_fk on public.repairs(technician_id);
create index if not exists idx_sale_items_product_id_fk on public.sale_items(product_id);
create index if not exists idx_sale_items_sale_id_fk on public.sale_items(sale_id);
create index if not exists idx_sale_payments_sale_id_fk on public.sale_payments(sale_id);
create index if not exists idx_sales_cashier_id_fk on public.sales(cashier_id);
create index if not exists idx_sales_customer_id_fk on public.sales(customer_id);
create index if not exists idx_sales_salesman_id_fk on public.sales(salesman_id);
create index if not exists idx_suppliers_shop_id_fk on public.suppliers(shop_id);
create index if not exists idx_warranty_claims_created_by_fk on public.warranty_claims(created_by);
create index if not exists idx_warranty_claims_customer_id_fk on public.warranty_claims(customer_id);
create index if not exists idx_warranty_claims_sale_id_fk on public.sale_items(product_id);
create index if not exists idx_warranty_claims_shop_id_fk on public.warranty_claims(shop_id);
create index if not exists idx_warranty_claims_unit_id_fk on public.warranty_claims(unit_id);
