-- Phase 1.5: low-egress, shop-scoped Owner Web daily sales aggregates.
-- The sales trigger keeps the cache aligned with normal POS cloud sync writes.
-- The authenticated RPC validates membership and repairs the requested date window on read.

create table if not exists public.owner_daily_sales (
  shop_id uuid not null references public.shops(id) on delete cascade,
  sale_date date not null,
  completed_sales_count bigint not null default 0 check (completed_sales_count >= 0),
  gross_total numeric(14,2) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (shop_id, sale_date)
);

create index if not exists idx_sales_shop_status_created_at
  on public.sales (shop_id, status, created_at);

alter table public.owner_daily_sales enable row level security;
revoke all on public.owner_daily_sales from anon, authenticated;
grant select on public.owner_daily_sales to authenticated;
drop policy if exists owner_daily_sales_member_read on public.owner_daily_sales;
create policy owner_daily_sales_member_read
  on public.owner_daily_sales
  for select to authenticated
  using (private.is_shop_member(shop_id));

create or replace function private.sync_owner_daily_sales()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  old_day date;
  new_day date;
begin
  if TG_OP <> 'INSERT' then
    old_day := (OLD.created_at at time zone 'Asia/Colombo')::date;
    perform pg_advisory_xact_lock(hashtextextended(OLD.shop_id::text, 0));
    if OLD.status = 'completed' then
      insert into public.owner_daily_sales(shop_id, sale_date, completed_sales_count, gross_total, updated_at)
      values (OLD.shop_id, old_day, -1, -coalesce(OLD.total, 0), now())
      on conflict (shop_id, sale_date) do update
        set completed_sales_count = public.owner_daily_sales.completed_sales_count + excluded.completed_sales_count,
            gross_total = public.owner_daily_sales.gross_total + excluded.gross_total,
            updated_at = now();
      update public.owner_daily_sales
        set completed_sales_count = 0, gross_total = 0, updated_at = now()
        where shop_id = OLD.shop_id and sale_date = old_day
          and completed_sales_count < 0;
    end if;
  end if;

  if TG_OP <> 'DELETE' then
    new_day := (NEW.created_at at time zone 'Asia/Colombo')::date;
    if TG_OP = 'INSERT' or NEW.shop_id is distinct from OLD.shop_id then
      perform pg_advisory_xact_lock(hashtextextended(NEW.shop_id::text, 0));
    end if;
    if NEW.status = 'completed' then
      insert into public.owner_daily_sales(shop_id, sale_date, completed_sales_count, gross_total, updated_at)
      values (NEW.shop_id, new_day, 1, coalesce(NEW.total, 0), now())
      on conflict (shop_id, sale_date) do update
        set completed_sales_count = public.owner_daily_sales.completed_sales_count + excluded.completed_sales_count,
            gross_total = public.owner_daily_sales.gross_total + excluded.gross_total,
            updated_at = now();
    end if;
  end if;

  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end;
$$;

drop trigger if exists trg_sync_owner_daily_sales on public.sales;
create trigger trg_sync_owner_daily_sales
after insert or update of shop_id, status, created_at, total or delete
on public.sales
for each row execute function private.sync_owner_daily_sales();

do $$
declare
  v_shop record;
begin
  for v_shop in select id from public.shops loop
    perform pg_advisory_xact_lock(hashtextextended(v_shop.id::text, 0));
    delete from public.owner_daily_sales where shop_id = v_shop.id;
    insert into public.owner_daily_sales(shop_id, sale_date, completed_sales_count, gross_total, updated_at)
    select s.shop_id,
           (s.created_at at time zone 'Asia/Colombo')::date,
           count(*)::bigint,
           coalesce(sum(s.total), 0),
           now()
    from public.sales s
    where s.shop_id = v_shop.id and s.status = 'completed'
    group by s.shop_id, (s.created_at at time zone 'Asia/Colombo')::date;
  end loop;
end;
$$;

create or replace function public.get_owner_daily_sales(
  p_shop_id uuid,
  p_from date,
  p_to date
)
returns table(sale_date date, completed_sales_count bigint, gross_total numeric)
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
  delete from public.owner_daily_sales
   where shop_id = p_shop_id and sale_date between p_from and p_to;

  insert into public.owner_daily_sales(shop_id, sale_date, completed_sales_count, gross_total, updated_at)
  select s.shop_id,
         (s.created_at at time zone 'Asia/Colombo')::date,
         count(*)::bigint,
         coalesce(sum(s.total), 0),
         now()
  from public.sales s
  where s.shop_id = p_shop_id
    and s.status = 'completed'
    and (s.created_at at time zone 'Asia/Colombo')::date between p_from and p_to
  group by s.shop_id, (s.created_at at time zone 'Asia/Colombo')::date;

  return query
  select a.sale_date, a.completed_sales_count, a.gross_total
  from public.owner_daily_sales a
  where a.shop_id = p_shop_id and a.sale_date between p_from and p_to
  order by a.sale_date;
end;
$$;

revoke all on function public.get_owner_daily_sales(uuid, date, date) from public, anon;
grant execute on function public.get_owner_daily_sales(uuid, date, date) to authenticated;

comment on table public.owner_daily_sales is
  'Shop-scoped daily aggregate of completed sales for low-egress Owner Web dashboards; amounts are gross before partial returns.';
comment on function public.get_owner_daily_sales(uuid, date, date) is
  'Returns daily completed-sale aggregates for an active member shop and repairs the requested aggregate window on read.';
