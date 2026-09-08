-- Nexfix POS production schema baseline.
-- The original supabase/schema.sql was not tracked as a migration, while later
-- migrations assume these relations already exist. This migration makes the
-- production schema reproducible for Supabase migrations.

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null,
  role text not null default 'cashier' check (role in ('admin','manager','cashier','technician')),
  phone text,
  active boolean not null default true,
  commission_pct numeric(5,2) default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.shops (
  id uuid primary key default uuid_generate_v4(), name text not null, tagline text,
  address text, phone text, email text, logo_url text, receipt_footer text,
  tax_rate numeric(5,2) default 0, currency text default 'LKR',
  low_stock_default int default 5, exchange_days int default 7,
  repair_warranty_days int default 30, loyalty_earn_div int default 1000,
  loyalty_point_value numeric(10,2) default 20, settings jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.categories (
  id uuid primary key default uuid_generate_v4(), shop_id uuid references public.shops(id) on delete cascade,
  name text not null, parent_id uuid references public.categories(id), sort_order int default 0,
  unique(shop_id,name)
);
create table if not exists public.brands (
  id uuid primary key default uuid_generate_v4(), shop_id uuid references public.shops(id) on delete cascade,
  name text not null, unique(shop_id,name)
);

create table if not exists public.products (
  id uuid primary key default uuid_generate_v4(), shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null, sku text, barcode text, category_id uuid references public.categories(id), brand_id uuid references public.brands(id),
  description text, cost numeric(12,2) not null default 0, price numeric(12,2) not null default 0,
  stock numeric(12,2) not null default 0, reorder_level numeric(12,2) default 5,
  track_imei boolean default false, track_serial boolean default false, track_expiry boolean default false,
  warranty_months int default 0, is_kit boolean default false, is_service boolean default false,
  active boolean default true, attributes jsonb default '{}'::jsonb, image_url text, supplier_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists idx_products_shop on public.products(shop_id);
create index if not exists idx_products_barcode on public.products(barcode);
create index if not exists idx_products_sku on public.products(sku);

create table if not exists public.kit_items (
  id uuid primary key default uuid_generate_v4(), kit_product_id uuid not null references public.products(id) on delete cascade,
  component_product_id uuid not null references public.products(id), qty numeric(12,2) not null default 1,
  unique(kit_product_id,component_product_id)
);

do $$ begin create type public.unit_status as enum ('in_stock','sold','returned','reserved','defective','in_repair'); exception when duplicate_object then null; end $$;
create table if not exists public.inventory_units (
  id uuid primary key default uuid_generate_v4(), shop_id uuid not null references public.shops(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade, imei text, serial text, expiry_date date,
  status public.unit_status not null default 'in_stock', cost numeric(12,2), purchase_id uuid, sale_id uuid,
  sale_bill_no text, warranty_months int, warranty_expires_at date, note text, created_at timestamptz not null default now(), sold_at timestamptz
);
create index if not exists idx_units_imei on public.inventory_units(imei);
create index if not exists idx_units_serial on public.inventory_units(serial);
create index if not exists idx_units_product on public.inventory_units(product_id);
create index if not exists idx_units_status on public.inventory_units(status);

create table if not exists public.customers (
  id uuid primary key default uuid_generate_v4(), shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null, phone text, email text, nic text, address text,
  credit_balance numeric(12,2) default 0, loyalty_points int default 0, notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists idx_customers_phone on public.customers(phone);

create table if not exists public.suppliers (
  id uuid primary key default uuid_generate_v4(), shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null, contact_person text, phone text, email text, address text, notes text,
  created_at timestamptz not null default now()
);

do $$ begin create type public.purchase_status as enum ('draft','ordered','partial','received','cancelled'); exception when duplicate_object then null; end $$;
create table if not exists public.purchases (
  id uuid primary key default uuid_generate_v4(), shop_id uuid not null references public.shops(id) on delete cascade,
  po_no text not null, supplier_id uuid references public.suppliers(id), supplier_name text,
  status public.purchase_status not null default 'draft', total numeric(12,2) default 0, notes text,
  ordered_at timestamptz, received_at timestamptz, created_by uuid references public.profiles(id), created_at timestamptz not null default now()
);
create table if not exists public.purchase_items (
  id uuid primary key default uuid_generate_v4(), purchase_id uuid not null references public.purchases(id) on delete cascade,
  product_id uuid references public.products(id), name text not null, qty_ordered numeric(12,2) not null,
  qty_received numeric(12,2) default 0, cost numeric(12,2) not null, expiry_date date
);

do $$ begin create type public.sale_status as enum ('completed','refunded','partial_refund','exchanged','void'); exception when duplicate_object then null; end $$;
do $$ begin create type public.payment_method as enum ('cash','card','bank','mobile','credit','points'); exception when duplicate_object then null; end $$;
create table if not exists public.sales (
  id uuid primary key default uuid_generate_v4(), shop_id uuid not null references public.shops(id) on delete cascade,
  bill_no text not null, customer_id uuid references public.customers(id), customer_name text default 'Walk-in customer',
  cashier_id uuid references public.profiles(id), cashier_name text, salesman_id uuid references public.profiles(id),
  subtotal numeric(12,2) not null, discount numeric(12,2) default 0, tax numeric(12,2) default 0,
  shipping numeric(12,2) default 0, total numeric(12,2) not null, amount_paid numeric(12,2) default 0,
  change_amount numeric(12,2) default 0, profit numeric(12,2) default 0, points_earned int default 0,
  points_redeemed int default 0, status public.sale_status not null default 'completed', note text,
  created_at timestamptz not null default now()
);
create table if not exists public.sale_items (
  id uuid primary key default uuid_generate_v4(), sale_id uuid not null references public.sales(id) on delete cascade,
  product_id uuid references public.products(id), name text not null, qty numeric(12,2) not null, price numeric(12,2) not null,
  cost numeric(12,2) not null, discount numeric(12,2) default 0, price_overridden boolean default false,
  warranty_months int, unit_ids uuid[] default '{}'
);
create table if not exists public.sale_payments (
  id uuid primary key default uuid_generate_v4(), sale_id uuid not null references public.sales(id) on delete cascade,
  method public.payment_method not null, amount numeric(12,2) not null
);

create table if not exists public.quotations (
  id uuid primary key default uuid_generate_v4(), shop_id uuid not null references public.shops(id) on delete cascade,
  quote_no text not null, customer_id uuid references public.customers(id), customer_name text, customer_phone text,
  status text not null default 'draft', subtotal numeric(12,2) default 0, discount numeric(12,2) default 0,
  tax numeric(12,2) default 0, total numeric(12,2) default 0, valid_until date, notes text,
  converted_sale_id uuid references public.sales(id), created_by uuid references public.profiles(id), created_at timestamptz not null default now()
);
create table if not exists public.quotation_items (
  id uuid primary key default uuid_generate_v4(), quotation_id uuid not null references public.quotations(id) on delete cascade,
  product_id uuid references public.products(id), name text not null, qty numeric(12,2) not null, price numeric(12,2) not null, discount numeric(12,2) default 0
);

create table if not exists public.repairs (
  id uuid primary key default uuid_generate_v4(), shop_id uuid not null references public.shops(id) on delete cascade,
  job_no text not null, customer_id uuid references public.customers(id), customer_name text not null, customer_phone text,
  device_type text not null, device_brand text, device_model text, imei text, serial text, fault text not null, diagnosis text,
  labor_cost numeric(12,2) default 0, status text not null default 'received', received_at timestamptz not null default now(),
  promised_at timestamptz, completed_at timestamptz, delivered_at timestamptz, technician_id uuid references public.profiles(id),
  technician_name text, warranty_days int default 30, advance_paid numeric(12,2) default 0, notes text,
  created_by uuid references public.profiles(id), created_at timestamptz not null default now()
);
create table if not exists public.repair_parts (
  id uuid primary key default uuid_generate_v4(), repair_id uuid not null references public.repairs(id) on delete cascade,
  product_id uuid references public.products(id), name text not null, qty numeric(12,2) not null default 1, cost numeric(12,2) not null default 0
);
create table if not exists public.warranty_claims (
  id uuid primary key default uuid_generate_v4(), shop_id uuid not null references public.shops(id) on delete cascade,
  claim_no text not null, unit_id uuid references public.inventory_units(id), sale_id uuid references public.sales(id),
  customer_id uuid references public.customers(id), product_name text, imei_or_serial text, issue_description text not null,
  status text not null default 'open', resolution_notes text, created_by uuid references public.profiles(id), created_at timestamptz not null default now(), closed_at timestamptz
);
create table if not exists public.expenses (
  id uuid primary key default uuid_generate_v4(), shop_id uuid not null references public.shops(id) on delete cascade,
  category text not null, note text, amount numeric(12,2) not null, expense_date date not null default current_date,
  created_by uuid references public.profiles(id), created_at timestamptz not null default now()
);
create table if not exists public.day_sessions (
  id uuid primary key default uuid_generate_v4(), shop_id uuid not null references public.shops(id) on delete cascade,
  cashier_id uuid not null references public.profiles(id), cashier_name text, session_date date not null,
  opening numeric(12,2) not null default 0, closing numeric(12,2), closed boolean default false, note text, created_at timestamptz not null default now()
);
create table if not exists public.audit_log (
  id uuid primary key default uuid_generate_v4(), shop_id uuid references public.shops(id), user_id uuid references public.profiles(id),
  user_email text, action text not null, entity text not null, details text, created_at timestamptz not null default now()
);
create index if not exists idx_audit_created on public.audit_log(created_at desc);
create table if not exists public.counters (
  shop_id uuid primary key references public.shops(id) on delete cascade, bill int default 0, po int default 0, quote int default 0, job int default 0, claim int default 0, exchange int default 0
);

-- Required base privileges; later security migrations tighten these policies.
grant usage on schema public to authenticated;
