-- Ensure a final partial return is treated as a full return before shipping/trade-in restoration.
do $$
declare d text; old text; new text;
begin
  select pg_get_functiondef(p.oid) into d
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and p.proname='process_sale_return_atomic' limit 1;
  if d is null then raise exception 'private.process_sale_return_atomic not found'; end if;
  old := E'  v_full_return:=v_remaining_lines=0;';
  new := E'  select count(*) into v_remaining_lines
  from public.sale_items si
  where si.sale_id=v_sale.id
    and greatest(0,si.qty-(select coalesce(sum(ri.qty),0) from public.sale_return_items ri join public.sale_returns r on r.id=ri.return_id where ri.sale_item_id=si.id and r.shop_id=p_shop_id)) >
        coalesce((select sum((pl.value->>''qty'')::numeric) from jsonb_array_elements(p_lines) pl where (pl.value->>''sale_item_id'')::uuid=si.id),0);
  v_full_return:=v_remaining_lines=0;';
  if position(old in d)=0 then raise exception 'full-return anchor not found'; end if;
  if position('coalesce((select sum((pl.value->>''qty'')::numeric)' in d)>0 then
    raise exception 'full-return guard already present';
  end if;
  d:=replace(d,old,new);
  execute d;
end $$;