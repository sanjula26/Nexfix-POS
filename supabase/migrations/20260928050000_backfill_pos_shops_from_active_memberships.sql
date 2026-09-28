-- Keep legacy POS cloud-sync tables compatible with the newer shop_memberships source of truth.
-- Some existing shops were created after shop_memberships was introduced and therefore
-- have no corresponding pos_shops row. pos_devices has a foreign key to pos_shops.
insert into public.pos_shops (shop_id, created_by)
select distinct on (sm.shop_id)
  sm.shop_id::text,
  sm.user_id
from public.shop_memberships sm
where sm.active = true
order by
  sm.shop_id,
  case sm.role when 'admin' then 0 when 'manager' then 1 else 2 end,
  sm.created_at nulls last,
  sm.user_id
on conflict (shop_id) do nothing;
