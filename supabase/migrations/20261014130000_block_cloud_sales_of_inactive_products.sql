-- Enforce product active status at the authoritative cloud transaction boundary.
-- The UI check improves feedback, but direct/stale clients must not be able to
-- sell a product after an admin has deactivated it.
do $$
declare
  d text;
  loop_text text := 'for v_line in select value from jsonb_array_elements(p_lines) loop';
  loop_pos integer;
  not_found_pos integer;
  end_if_pos integer;
  insert_pos integer;
  marker text := 'Product is inactive and cannot be sold';
begin
  select pg_get_functiondef(p.oid) into d
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname = 'complete_sale_atomic'
  limit 1;

  if d is null then
    raise exception 'private.complete_sale_atomic not found; inactive-product sale guard was not installed';
  end if;
  if position(marker in d) > 0 then
    return;
  end if;

  loop_pos := position(loop_text in d);
  if loop_pos = 0 then
    raise exception 'Sale validation loop not found; inactive-product sale guard was not installed';
  end if;

  not_found_pos := position(
    'raise exception ''Product not found for this shop'';'
    in substring(d from loop_pos)
  );
  if not_found_pos = 0 then
    raise exception 'Product existence check not found in sale validation loop';
  end if;

  not_found_pos := loop_pos + not_found_pos - 1;
  end_if_pos := position('end if;' in substring(d from not_found_pos));
  if end_if_pos = 0 then
    raise exception 'Product existence check terminator not found';
  end if;
  insert_pos := not_found_pos + end_if_pos - 1 + length('end if;');

  d := left(d, insert_pos)
    || E'\n\n    if not coalesce(v_product.active, true) then\n'
    || E'      raise exception ''Product is inactive and cannot be sold'';\n'
    || '    end if;'
    || substring(d from insert_pos + 1);

  execute d;
end $$;
