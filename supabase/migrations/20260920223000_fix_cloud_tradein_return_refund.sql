-- Keep cloud sale returns consistent with local refunds when a sale contains a trade-in.
do $$
declare d text; old text; new text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and p.proname='process_sale_return_atomic' limit 1;
  if d is null then raise exception 'private.process_sale_return_atomic not found'; end if;
  old := E'  v_shipping_refund numeric := 0;\n  v_returned_merch numeric := 0;';
  new := E'  v_shipping_refund numeric := 0;\n  v_returned_merch numeric := 0;\n  v_tradein_total numeric := 0;\n  v_allocated_tradein numeric := 0;';
  if position(old in d)=0 then raise exception 'return declaration anchor not found'; end if;
  d := replace(d,old,new);
  old := E'  if v_sale.status not in (''completed'',''exchanged'') then raise exception ''Sale is not eligible for return''; end if;';
  new := old || E'\n  select coalesce(sum(iu.cost),0) into v_tradein_total\n  from public.inventory_units iu\n  where iu.shop_id=p_shop_id and iu.sale_id=v_sale.id and iu.status=''in_stock'' and iu.note=''Trade-in'';';
  if position(old in d)=0 then raise exception 'sale status anchor not found'; end if;
  d := replace(d,old,new);
  old := E'  v_refund:=greatest(0,round((v_taxable_returned+v_tax_refund+v_shipping_refund)::numeric,2));';
  new := E'  v_allocated_tradein:=case when v_sale_subtotal>0 then least(v_tradein_total, v_tradein_total*(v_returned_merch/v_sale_subtotal)) else 0 end;\n  v_refund:=greatest(0,round((v_taxable_returned+v_tax_refund+v_shipping_refund-v_allocated_tradein)::numeric,2));';
  if position(old in d)=0 then raise exception 'refund formula anchor not found'; end if;
  d := replace(d,old,new);
  execute d;
end $$;