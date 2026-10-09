-- Keep the PostgREST-facing RPC SECURITY INVOKER. Only the private refresh helper
-- needs elevated rights to repair the aggregate cache, and it validates membership itself.

create or replace function private.refresh_owner_daily_sales(
  p_shop_id uuid,
  p_from date,
  p_to date
)
returns void
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_shop_id is null or not private.is_shop_member(p_shop_id) then
    raise exception 'Unauthorized shop' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Invalid date range';
  end if;
  if p_to - p_from > 365 then
    raise exception 'Date range cannot exceed 366 days';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_shop_id::text, 0));
  delete from public.owner_daily_sales as ods
   where ods.shop_id = p_shop_id and ods.sale_date between p_from and p_to;

  insert into public.owner_daily_sales(shop_id, sale_date, completed_sales_count, gross_total, updated_at)
  select s.shop_id,
         (s.created_at at time zone 'Asia/Colombo')::date,
         count(*)::bigint,
         coalesce(sum(s.total), 0),
         now()
  from public.sales s
  where s.shop_id = p_shop_id
    and s.status = 'completed'
    and s.created_at >= (p_from::timestamp at time zone 'Asia/Colombo')
    and s.created_at < ((p_to + 1)::timestamp at time zone 'Asia/Colombo')
  group by s.shop_id, (s.created_at at time zone 'Asia/Colombo')::date;
end;
$$;

revoke all on function private.refresh_owner_daily_sales(uuid, date, date) from public, anon, authenticated;
grant execute on function private.refresh_owner_daily_sales(uuid, date, date) to authenticated;

create or replace function public.get_owner_daily_sales(
  p_shop_id uuid,
  p_from date,
  p_to date
)
returns table(sale_date date, completed_sales_count bigint, gross_total numeric)
language plpgsql
security invoker
set search_path = public, private, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_shop_id is null or not private.is_shop_member(p_shop_id) then
    raise exception 'Unauthorized shop' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Invalid date range';
  end if;
  if p_to - p_from > 365 then
    raise exception 'Date range cannot exceed 366 days';
  end if;

  perform private.refresh_owner_daily_sales(p_shop_id, p_from, p_to);

  return query
  select a.sale_date, a.completed_sales_count, a.gross_total
  from public.owner_daily_sales a
  where a.shop_id = p_shop_id and a.sale_date between p_from and p_to
  order by a.sale_date;
end;
$$;

revoke all on function public.get_owner_daily_sales(uuid, date, date) from public, anon;
grant execute on function public.get_owner_daily_sales(uuid, date, date) to authenticated;
