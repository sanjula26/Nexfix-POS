-- Prevent duplicate product lines from bypassing aggregate stock validation,
-- and prevent the same tracked IMEI/serial from being sold twice in one atomic sale.
do $$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and p.proname='complete_sale_atomic' limit 1;
  if d is null then raise exception 'private.complete_sale_atomic not found'; end if;
  if position('Duplicate product quantities in sale request exceed available stock' in d)=0 then
    d:=replace(d,
      'for v_line in select value from jsonb_array_elements(p_lines) loop',
      $ins$
if exists (
  select 1 from (
    select (value->>'product_id')::uuid as product_id, sum((value->>'qty')::numeric) as requested_qty
    from jsonb_array_elements(p_lines) group by (value->>'product_id')::uuid
  ) req join public.products p on p.id=req.product_id and p.shop_id=p_shop_id
  where p.stock < req.requested_qty
) then
  raise exception 'Duplicate product quantities in sale request exceed available stock';
end if;
if exists (
  select 1 from (
    select value::uuid as unit_id, count(*) as cnt
    from jsonb_array_elements(p_lines) l
    cross join lateral jsonb_array_elements_text(coalesce(l.value->'unit_ids','[]'::jsonb)) value
    group by value::uuid having count(*) > 1
  ) dup
) then
  raise exception 'An IMEI/serial unit cannot be sold more than once in the same sale';
end if;
for v_line in select value from jsonb_array_elements(p_lines) loop
$ins$);
  end if;
  if position('An IMEI/serial unit cannot be sold more than once in the same sale' in d)=0 then raise exception 'Sale validation insertion failed'; end if;
  execute d;
end $$;