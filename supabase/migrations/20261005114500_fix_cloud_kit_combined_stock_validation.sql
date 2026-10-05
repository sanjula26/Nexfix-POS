-- Align cloud atomic sale stock validation with local Kit/BOM behavior.
-- A Kit with a BOM consumes components, not the Kit catalog row.
-- Direct component sales and Kit component consumption are aggregated together.
-- This patch is intentionally idempotent: the stock-validation block may already
-- contain the tracked-unit duplicate check added by an earlier migration.

do $patch$
declare
  d text;
  old_block text := $old$
if exists (
  select 1 from (
    select (value->>'product_id')::uuid as product_id,
           sum((value->>'qty')::numeric) as requested_qty
    from jsonb_array_elements(p_lines)
    group by (value->>'product_id')::uuid
  ) req
  join public.products p on p.id=req.product_id and p.shop_id=p_shop_id
  where p.stock < req.requested_qty
) then
  raise exception 'Duplicate product quantities in sale request exceed available stock';
end if;
$old$;
  new_block text := $new$
-- Lock every product whose stock may be consumed, in deterministic order,
-- before validating quantities. This prevents Kit/direct-component races.
perform 1
from public.products cp
where cp.shop_id=p_shop_id
  and cp.id in (
    select r.product_id
    from (
      select (l.value->>'product_id')::uuid as product_id
      from jsonb_array_elements(p_lines) l
      join public.products dp on dp.id=(l.value->>'product_id')::uuid and dp.shop_id=p_shop_id
      where not (coalesce(dp.is_kit,false) and exists (
        select 1 from public.kit_items ki
        where ki.kit_product_id=dp.id and ki.qty>0
      ))
      union
      select ki.component_product_id
      from jsonb_array_elements(p_lines) l
      join public.products kp on kp.id=(l.value->>'product_id')::uuid
        and kp.shop_id=p_shop_id and kp.is_kit=true
      join public.kit_items ki on ki.kit_product_id=kp.id and ki.qty>0
    ) r
  )
order by cp.id
for update;

if exists (
  select 1
  from (
    select r.product_id, sum(r.required_qty) as required_qty
    from (
      select (l.value->>'product_id')::uuid as product_id,
             sum((l.value->>'qty')::numeric) as required_qty
      from jsonb_array_elements(p_lines) l
      join public.products dp on dp.id=(l.value->>'product_id')::uuid and dp.shop_id=p_shop_id
      where not (coalesce(dp.is_kit,false) and exists (
        select 1 from public.kit_items dki
        where dki.kit_product_id=dp.id and dki.qty>0
      ))
      group by (l.value->>'product_id')::uuid
      union all
      select ki.component_product_id as product_id,
             sum(ki.qty * (l.value->>'qty')::numeric) as required_qty
      from jsonb_array_elements(p_lines) l
      join public.products kp on kp.id=(l.value->>'product_id')::uuid
        and kp.shop_id=p_shop_id and kp.is_kit=true
      join public.kit_items ki on ki.kit_product_id=kp.id and ki.qty>0
      group by ki.component_product_id
    ) r
    group by r.product_id
  ) req
  join public.products p on p.id=req.product_id and p.shop_id=p_shop_id
  where p.stock < req.required_qty
) then
  raise exception 'Combined sale quantities exceed available stock';
end if;
$new$;
begin
  select pg_get_functiondef(p.oid) into d
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and p.proname='complete_sale_atomic'
  order by p.oid desc limit 1;
  if d is null then raise exception 'private.complete_sale_atomic not found'; end if;
  if position('Combined sale quantities exceed available stock' in d) > 0 then
    return;
  end if;
  if position(old_block in d)=0 then
    raise exception 'Expected aggregate stock block not found';
  end if;
  d:=replace(d,old_block,new_block);
  execute d;
end
$patch$;