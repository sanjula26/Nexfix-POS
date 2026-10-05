-- Phone Sales R2 cache manifest foundation.
-- R2 remains a cache/archive layer; Supabase sales stay authoritative.
create table if not exists public.phone_sales_cache_manifests (
  shop_id uuid not null references public.shops(id) on delete cascade,
  sales_date date not null,
  object_key text not null,
  generated_at timestamptz not null default now(),
  latest_sale_created_at timestamptz,
  sale_count integer not null default 0,
  payload_sha256 text,
  payload_bytes bigint,
  schema_version integer not null default 1,
  primary key (shop_id, sales_date)
);

create index if not exists phone_sales_cache_manifests_generated_idx
  on public.phone_sales_cache_manifests (generated_at desc);

alter table public.phone_sales_cache_manifests enable row level security;

revoke all on public.phone_sales_cache_manifests from anon, authenticated;
grant select, insert, update, delete on public.phone_sales_cache_manifests to service_role;
