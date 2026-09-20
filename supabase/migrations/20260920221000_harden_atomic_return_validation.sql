-- Prevent duplicate sale-item lines from bypassing return quantity validation.
do $$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and p.proname='process_sale_return_atomic' limit 1;
  if d is null then raise exception 'private.process_sale_return_atomic not found'; end if;
  if position('Duplicate sale item ids are not allowed in one return request' in d)=0 then
    d:=replace(d,
      'if jsonb_typeof(coalesce(p_lines,''[]''::jsonb)) <> ''array'' or jsonb_array_length(p_lines)=0 then raise exception ''Return lines are required''; end if;',
      $ins$
if jsonb_typeof(coalesce(p_lines,'[]'::jsonb)) <> 'array' or jsonb_array_length(p_lines)=0 then raise exception 'Return lines are required'; end if;
if exists (
  select 1 from (
    select value->>'sale_item_id' as sale_item_id, count(*) as cnt
    from jsonb_array_elements(p_lines) group by value->>'sale_item_id' having count(*) > 1
  ) dup
) then
  raise exception 'Duplicate sale item ids are not allowed in one return request';
end if;
$ins$);
  end if;
  if position('Duplicate sale item ids are not allowed in one return request' in d)=0 then raise exception 'Return validation insertion failed'; end if;
  execute d;
end $$;