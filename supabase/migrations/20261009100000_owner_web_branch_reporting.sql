-- Phase 3: Owner Web branch-scoped read-only reporting.
-- All public RPCs are SECURITY INVOKER and validate active shop membership.
-- No service-role credentials or write paths are introduced.
create or replace function public.get_owner_branch_daily_sales(
  p_shop_id uuid,
  p_from date,
  p_to date,
  p_branch_id uuid default null
)
returns table(branch_id uuid, sale_date date, completed_sales_count bigint, gross_total numeric)
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_shop_id is null or p_from is null or p_to is null or p_from > p_to then
    raise exception 'Shop and valid date range are required';
  end if;
  if p_to - p_from > 365 then raise exception 'Date range must be 366 days or less'; end if;
  if not exists (
    select 1 from public.shop_memberships m
    where m.shop_id = p_shop_id and m.user_id = auth.uid() and m.active
  ) then raise exception 'Active shop membership required'; end if;
  if p_branch_id is not null and not exists (
    select 1 from public.branches b
    where b.id = p_branch_id and b.shop_id = p_shop_id and b.active
  ) then raise exception 'Selected branch is unavailable for this shop'; end if;

  return query
  select s.branch_id, (s.created_at at time zone 'Asia/Colombo')::date,
         count(*)::bigint, coalesce(sum(s.total), 0)::numeric
  from public.sales s
  where s.shop_id = p_shop_id
    and s.status = 'completed'
    and (s.created_at at time zone 'Asia/Colombo')::date between p_from and p_to
    and (p_branch_id is null or s.branch_id = p_branch_id)
  group by s.branch_id, (s.created_at at time zone 'Asia/Colombo')::date
  order by (s.created_at at time zone 'Asia/Colombo')::date, s.branch_id;
end;
$function$;
revoke all on function public.get_owner_branch_daily_sales(uuid,date,date,uuid) from public, anon;
grant execute on function public.get_owner_branch_daily_sales(uuid,date,date,uuid) to authenticated;

create or replace function public.get_owner_branch_stock_valuation(
  p_shop_id uuid,
  p_branch_id uuid default null
)
returns table(
  branch_id uuid, branch_name text, product_id uuid, product_name text,
  sku text, qty numeric, cost_unit numeric, selling_unit numeric,
  cost_value numeric, selling_value numeric, potential_profit numeric,
  reorder_level numeric, low_stock boolean
)
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_shop_id is null then raise exception 'Shop is required'; end if;
  if not exists (
    select 1 from public.shop_memberships m
    where m.shop_id = p_shop_id and m.user_id = auth.uid() and m.active
  ) then raise exception 'Active shop membership required'; end if;
  if p_branch_id is not null and not exists (
    select 1 from public.branches b
    where b.id = p_branch_id and b.shop_id = p_shop_id and b.active
  ) then raise exception 'Selected branch is unavailable for this shop'; end if;

  return query
  select b.id, b.name, p.id, p.name, coalesce(p.sku,''), bs.qty,
         coalesce(p.cost,0), coalesce(p.price,0),
         bs.qty * coalesce(p.cost,0), bs.qty * coalesce(p.price,0),
         bs.qty * (coalesce(p.price,0)-coalesce(p.cost,0)),
         coalesce(p.reorder_level,5),
         (coalesce(p.reorder_level,5) > 0 and bs.qty <= coalesce(p.reorder_level,5))
  from public.branch_stock bs
  join public.branches b on b.id=bs.branch_id and b.shop_id=bs.shop_id and b.active
  join public.products p on p.id=bs.product_id and p.shop_id=bs.shop_id and p.active
  where bs.shop_id=p_shop_id and (p_branch_id is null or bs.branch_id=p_branch_id)
  order by b.name, p.name;
end;
$function$;
revoke all on function public.get_owner_branch_stock_valuation(uuid,uuid) from public, anon;
grant execute on function public.get_owner_branch_stock_valuation(uuid,uuid) to authenticated;
