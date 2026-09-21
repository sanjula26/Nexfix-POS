-- Harden return unit validation so a tracked unit cannot be returned twice in one request.
do $$
declare d text; old text; new text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and p.proname='process_sale_return_atomic' limit 1;
  if d is null then raise exception 'private.process_sale_return_atomic not found'; end if;
  old := E'      v_unit_ids:=array(select x::uuid from jsonb_array_elements_text(v_line->''unit_ids'') x);\n      foreach v_id in array v_unit_ids loop';
  new := E'      v_unit_ids:=array(select x::uuid from jsonb_array_elements_text(v_line->''unit_ids'') x);\n      if cardinality(v_unit_ids) <> (select count(distinct u) from unnest(v_unit_ids) u) then raise exception ''Duplicate tracked unit ids are not allowed''; end if;\n      foreach v_id in array v_unit_ids loop';
  if position(old in d)=0 then raise exception 'process tracked-unit anchor not found'; end if;
  if position('Duplicate tracked unit ids are not allowed' in d)=0 then d:=replace(d,old,new); end if;
  execute d;
end $$;

do $$
declare d text; old text; new text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and p.proname='resolve_sale_return_items' limit 1;
  if d is null then raise exception 'private.resolve_sale_return_items not found'; end if;
  old := E'    if v_product_id is null or v_qty is null or v_qty <= 0 then raise exception ''Invalid return line''; end if;';
  new := E'    if v_product_id is null or v_qty is null or v_qty <= 0 then raise exception ''Invalid return line''; end if;\n    if cardinality(v_requested_units) > 0 and cardinality(v_requested_units) <> floor(v_qty)::int then raise exception ''Tracked return requires exactly one unit id per returned quantity''; end if;\n    if cardinality(v_requested_units) <> (select count(distinct u) from unnest(v_requested_units) u) then raise exception ''Duplicate tracked unit ids are not allowed''; end if;';
  if position(old in d)=0 then raise exception 'resolve line validation anchor not found'; end if;
  if position('Tracked return requires exactly one unit id per returned quantity' in d)=0 then d:=replace(d,old,new); end if;
  execute d;
end $$;