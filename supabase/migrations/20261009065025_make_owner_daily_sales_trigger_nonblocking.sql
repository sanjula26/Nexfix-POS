-- Keep the aggregate cache strictly best-effort so cache faults cannot abort POS sales sync.
-- The read RPC repairs any missing/stale requested date window.

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
  begin
    if TG_OP <> 'INSERT' then
      old_day := (OLD.created_at at time zone 'Asia/Colombo')::date;
      perform pg_advisory_xact_lock(hashtextextended(OLD.shop_id::text, 0));
      if OLD.status = 'completed' then
        update public.owner_daily_sales as ods
           set completed_sales_count = greatest(0, ods.completed_sales_count - 1),
               gross_total = case
                 when ods.completed_sales_count <= 1 then 0
                 else ods.gross_total - coalesce(OLD.total, 0)
               end,
               updated_at = now()
         where ods.shop_id = OLD.shop_id and ods.sale_date = old_day;
      end if;
    end if;

    if TG_OP <> 'DELETE' then
      new_day := (NEW.created_at at time zone 'Asia/Colombo')::date;
      if TG_OP = 'INSERT' then
        perform pg_advisory_xact_lock(hashtextextended(NEW.shop_id::text, 0));
      elsif NEW.shop_id is distinct from OLD.shop_id then
        perform pg_advisory_xact_lock(hashtextextended(NEW.shop_id::text, 0));
      end if;
      if NEW.status = 'completed' then
        insert into public.owner_daily_sales(shop_id, sale_date, completed_sales_count, gross_total, updated_at)
        values (NEW.shop_id, new_day, 1, coalesce(NEW.total, 0), now())
        on conflict (shop_id, sale_date) do update
          set completed_sales_count = public.owner_daily_sales.completed_sales_count + 1,
              gross_total = public.owner_daily_sales.gross_total + excluded.gross_total,
              updated_at = now();
      end if;
    end if;
  exception when others then
    raise warning 'Owner daily sales aggregate update failed; read fallback will rebuild it: %', SQLERRM;
  end;

  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end;
$$;
