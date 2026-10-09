-- Phase 4: shop-scoped, read-only customer credit reconciliation for Owner Web.
-- No settlement ledger is assumed; compare customer credit balances with completed
-- invoices' outstanding amounts recorded as total - amount_paid.
create or replace function public.get_owner_credit_customers(p_shop_id uuid)
returns table(
  customer_id uuid,
  customer_name text,
  phone text,
  email text,
  credit_balance numeric,
  open_invoice_balance numeric,
  reconciled boolean,
  updated_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_shop_id is null then
    raise exception 'Shop is required';
  end if;
  if not exists (
    select 1
    from public.shop_memberships m
    where m.shop_id = p_shop_id
      and m.user_id = auth.uid()
      and m.active
  ) then
    raise exception 'Active shop membership required';
  end if;

  return query
  select
    c.id,
    c.name,
    c.phone,
    c.email,
    coalesce(c.credit_balance, 0)::numeric,
    coalesce(sum(greatest(s.total - coalesce(s.amount_paid, 0), 0)), 0)::numeric,
    abs(coalesce(c.credit_balance, 0) - coalesce(sum(greatest(s.total - coalesce(s.amount_paid, 0), 0)), 0)) < 0.01,
    c.updated_at
  from public.customers c
  left join public.sales s
    on s.shop_id = c.shop_id
   and s.customer_id = c.id
   and s.status::text = 'completed'
  where c.shop_id = p_shop_id
  group by c.id, c.name, c.phone, c.email, c.credit_balance, c.updated_at
  having coalesce(c.credit_balance, 0) > 0
      or coalesce(sum(greatest(s.total - coalesce(s.amount_paid, 0), 0)), 0) > 0
  order by coalesce(c.credit_balance, 0) desc, c.name;
end;
$function$;

revoke all on function public.get_owner_credit_customers(uuid) from public, anon;
grant execute on function public.get_owner_credit_customers(uuid) to authenticated;
