create or replace function private.resolve_sale_return_items(
  p_shop_id uuid,
  p_sale_id uuid,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_result jsonb := '[]'::jsonb;
  v_line jsonb;
  v_product_id uuid;
  v_qty numeric;
  v_unit_ids uuid[];
  v_row record;
  v_available numeric;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if p_shop_id is null or p_sale_id is null then raise exception 'Missing return identifiers'; end if;
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'Return lines are required';
  end if;

  if not exists (
    select 1 from public.shop_memberships sm
    where sm.shop_id = p_shop_id and sm.user_id = v_uid and sm.active = true
      and sm.role in ('admin','manager','cashier')
  ) then raise exception 'Active shop membership required'; end if;

  if not exists (select 1 from public.sales s where s.id = p_sale_id and s.shop_id = p_shop_id and s.status in ('completed','exchanged')) then
    raise exception 'Sale is not available for return';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    v_product_id := nullif(v_line->>'product_id','')::uuid;
    v_qty := (v_line->>'qty')::numeric;
    v_unit_ids := case when jsonb_typeof(v_line->'unit_ids') = 'array' then array(select x::uuid from jsonb_array_elements_text(v_line->'unit_ids') x) else '{}'::uuid[] end;
    if v_product_id is null or v_qty is null or v_qty <= 0 then raise exception 'Invalid return line'; end if;

    v_row := null;
    if cardinality(v_unit_ids) > 0 then
      select si.id, si.product_id, si.qty, si.unit_ids into v_row
      from public.sale_items si
      where si.sale_id = p_sale_id and si.product_id = v_product_id
        and exists (select 1 from unnest(si.unit_ids) u where u = any(v_unit_ids))
      order by si.id
      limit 1;
    else
      select si.id, si.product_id, si.qty, si.unit_ids into v_row
      from public.sale_items si
      where si.sale_id = p_sale_id and si.product_id = v_product_id
      order by si.id
      limit 1;
    end if;
    if v_row.id is null then raise exception 'Cloud sale item could not be matched'; end if;

    select greatest(0, v_row.qty - coalesce(sum(sri.qty),0)) into v_available
    from public.sale_return_items sri
    join public.sale_returns sr on sr.id = sri.return_id
    where sri.sale_item_id = v_row.id and sr.sale_id = p_sale_id;
    if v_available < v_qty then raise exception 'Return quantity exceeds remaining quantity'; end if;

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'sale_item_id', v_row.id,
      'qty', v_qty,
      'unit_ids', case when cardinality(v_unit_ids) > 0 then to_jsonb(v_unit_ids) else '[]'::jsonb end
    ));
  end loop;
  return v_result;
end;
$$;

revoke all on function private.resolve_sale_return_items(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function private.resolve_sale_return_items(uuid,uuid,jsonb) to authenticated;

create or replace function public.resolve_sale_return_items(
  p_shop_id uuid,
  p_sale_id uuid,
  p_lines jsonb
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.resolve_sale_return_items(p_shop_id, p_sale_id, p_lines);
$$;

revoke all on function public.resolve_sale_return_items(uuid,uuid,jsonb) from public, anon;
grant execute on function public.resolve_sale_return_items(uuid,uuid,jsonb) to authenticated;
