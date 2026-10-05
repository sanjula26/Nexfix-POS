-- Keep cloud atomic sales aligned with local Kit/BOM inventory behavior.
-- Kit products with a BOM consume component stock; the kit catalog row is not decremented.
do $migration$
declare
  d text;
  old1 text := 'if v_product.stock<v_qty then raise exception ''Insufficient stock for product %'',v_product.name; end if;';
  new1 text := 'if coalesce(v_product.is_kit,false) and exists (select 1 from public.kit_items ki where ki.kit_product_id=v_product.id and ki.qty>0) then if exists (select 1 from public.kit_items ki join public.products cp on cp.id=ki.component_product_id and cp.shop_id=p_shop_id where ki.kit_product_id=v_product.id and cp.stock < ki.qty * v_qty) then raise exception ''Insufficient component stock for kit %'',v_product.name; end if; elsif v_product.stock<v_qty then raise exception ''Insufficient stock for product %'',v_product.name; end if;';
  old2 text := 'update public.products set stock=stock-v_qty,updated_at=now() where id=v_product.id and shop_id=p_shop_id;';
  new2 text := 'if not (coalesce(v_product.is_kit,false) and exists (select 1 from public.kit_items ki where ki.kit_product_id=v_product.id and ki.qty>0)) then update public.products set stock=stock-v_qty,updated_at=now() where id=v_product.id and shop_id=p_shop_id; end if;';
  old3 text := 'for v_payment in select value from jsonb_array_elements(p_payments) loop insert into public.sale_payments(sale_id,method,amount) values(p_sale_id,(v_payment->>''method'')::public.payment_method,round((v_payment->>''amount'')::numeric,2)); end loop;';
  new3 text := 'for v_payment in select value from jsonb_array_elements(p_payments) loop insert into public.sale_payments(sale_id,method,amount) values(p_sale_id,(v_payment->>''method'')::public.payment_method,round((v_payment->>''amount'')::numeric,2)); end loop; if exists (select 1 from jsonb_array_elements(p_lines) l join public.kit_items ki on ki.kit_product_id=(l.value->>''product_id'')::uuid join public.products kp on kp.id=ki.kit_product_id and kp.shop_id=p_shop_id and kp.is_kit=true) then update public.products cp set stock=cp.stock-req.required_qty,updated_at=now() from (select ki.component_product_id,sum(ki.qty*(l.value->>''qty'')::numeric) as required_qty from jsonb_array_elements(p_lines) l join public.kit_items ki on ki.kit_product_id=(l.value->>''product_id'')::uuid join public.products kp on kp.id=ki.kit_product_id and kp.shop_id=p_shop_id and kp.is_kit=true group by ki.component_product_id) req where cp.id=req.component_product_id and cp.shop_id=p_shop_id; end if;';
begin
  select pg_get_functiondef(p.oid) into d
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and p.proname='complete_sale_atomic'
  order by p.oid desc limit 1;
  if d is null then raise exception 'private.complete_sale_atomic not found'; end if;
  if position(old1 in d)=0 then raise exception 'Kit stock validation anchor not found'; end if;
  if position(old2 in d)=0 then raise exception 'Kit product stock update anchor not found'; end if;
  if position(old3 in d)=0 then raise exception 'Payment loop anchor not found'; end if;
  d:=replace(d,old1,new1);
  d:=replace(d,old2,new2);
  d:=replace(d,old3,new3);
  execute d;
end
$migration$;
