-- Fix full-return trade-in stock reversal when a sale contains multiple
-- trade-in units for the same product. The old logic decremented one unit
-- per product; this counts every sale-scoped trade-in unit.
do $migration$
declare
  v_def text;
begin
  select pg_get_functiondef('private.process_sale_return_atomic(uuid,uuid,uuid,text,text,text,jsonb)'::regprocedure)
    into v_def;

  v_def := replace(
    v_def,
    $$update public.products p
       set stock=greatest(0,p.stock-1),updated_at=now()
     where p.shop_id=p_shop_id
       and p.id in (
         select iu.product_id from public.inventory_units iu
         where iu.shop_id=p_shop_id and iu.sale_id=v_sale.id and iu.status='in_stock' and iu.note='Trade-in'
       );$$,
    $$update public.products p
       set stock=greatest(0,p.stock-tradeins.qty),updated_at=now()
      from (
        select iu.product_id,count(*)::numeric as qty
        from public.inventory_units iu
        where iu.shop_id=p_shop_id and iu.sale_id=v_sale.id and iu.status='in_stock' and iu.note='Trade-in'
        group by iu.product_id
      ) tradeins
     where p.shop_id=p_shop_id and p.id=tradeins.product_id;$$
  );

  if position('stock=greatest(0,p.stock-tradeins.qty)' in v_def)=0 then
    raise exception 'Expected trade-in reversal block was not found';
  end if;

  execute v_def;
end
$migration$;
