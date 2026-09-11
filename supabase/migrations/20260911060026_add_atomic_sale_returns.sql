-- Atomic sale return / refund persistence tables.
create table if not exists public.sale_returns (
  id uuid primary key default uuid_generate_v4(),
  shop_id uuid not null references public.shops(id),
  sale_id uuid not null references public.sales(id),
  return_no text not null,
  mode text not null check (mode in ('refund','replace')),
  reason text not null default '',
  refund_amount numeric not null default 0 check (refund_amount >= 0),
  additional_payment numeric not null default 0 check (additional_payment >= 0),
  payment_method text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (shop_id, return_no)
);

create table if not exists public.sale_return_items (
  id uuid primary key default uuid_generate_v4(),
  return_id uuid not null references public.sale_returns(id),
  sale_item_id uuid not null references public.sale_items(id),
  product_id uuid not null references public.products(id),
  qty numeric not null check (qty > 0),
  amount numeric not null default 0 check (amount >= 0),
  unit_ids uuid[] not null default '{}'::uuid[]
);

alter table public.sale_returns enable row level security;
alter table public.sale_return_items enable row level security;
revoke all on table public.sale_returns from anon, authenticated;
revoke all on table public.sale_return_items from anon, authenticated;
