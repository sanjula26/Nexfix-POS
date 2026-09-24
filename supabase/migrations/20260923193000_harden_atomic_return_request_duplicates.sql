-- Harden atomic returns against duplicate line/unit replay inside a single request.
-- The existing return RPC already locks the sale and each sale item. This adds
-- request-level validation so the same sale item or tracked unit cannot be
-- returned twice before the transaction's write phase begins.

do $$
declare
  d text;
  marker text := '  if v_role is null or v_role not in (''admin'',''manager'',''cashier'') then raise exception ''Active shop membership required''; end if;';
  block text := $ins$
  if exists (
    select 1
    from (
      select value->>'sale_item_id' as sale_item_id, count(*) as cnt
      from jsonb_array_elements(p_lines) value
      group by value->>'sale_item_id'
      having count(*) > 1
    ) duplicate_lines
  ) then
    raise exception 'A sale item can appear only once in a return request';
  end if;

  if exists (
    select 1
    from (
      select unit_id, count(*) as cnt
      from (
        select jsonb_array_elements_text(coalesce(value->'unit_ids','[]'::jsonb)) as unit_id
        from jsonb_array_elements(p_lines) value
      ) requested_units
      group by unit_id
      having count(*) > 1
    ) duplicate_units
  ) then
    raise exception 'The same IMEI/serial unit cannot be returned twice';
  end if;
$ins$;
begin
  select pg_get_functiondef('private.process_sale_return_atomic(uuid,uuid,uuid,text,text,text,jsonb)'::regprocedure)
    into d;

  if d is null then
    raise exception 'private.process_sale_return_atomic not found';
  end if;

  if position('A sale item can appear only once in a return request' in d) = 0 then
    if position(marker in d) = 0 then
      raise exception 'Return authorization marker not found';
    end if;
    d := replace(d, marker, marker || E'\n' || block);
  end if;

  execute d;
end $$;
