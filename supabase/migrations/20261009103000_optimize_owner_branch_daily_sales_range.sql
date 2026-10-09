-- Phase 3 follow-up: keep the branch/date aggregate predicate sargable for
-- the existing (shop_id, branch_id, created_at) sales index.
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
    and s.created_at >= (p_from::timestamp at time zone 'Asia/Colombo')
    and s.created_at < ((p_to + 1)::timestamp at time zone 'Asia/Colombo')
    and (p_branch_id is null or s.branch_id = p_branch_id)
  group by s.branch_id, (s.created_at at time zone 'Asia/Colombo')::date
  order by (s.created_at at time zone 'Asia/Colombo')::date, s.branch_id;
end;
$function$;
revoke all on function public.get_owner_branch_daily_sales(uuid,date,date,uuid) from public, anon;
grant execute on function public.get_owner_branch_daily_sales(uuid,date,date,uuid) to authenticated;
