-- Return the complete committed sale on an idempotent retry.
-- This lets the POS reconcile a sale after a crash/network interruption
-- that happened after the cloud transaction committed.
do $patch$
declare
  d text;
  old_block text := $old$select * into v_existing from public.sales s where s.id=p_sale_id; if found then if v_existing.shop_id<>p_shop_id then raise exception 'Sale id already belongs to another shop'; end if; return jsonb_build_object('ok',true,'already_committed',true,'sale_id',v_existing.id,'bill_no',v_existing.bill_no,'total',v_existing.total); end if;$old$;
  new_block text := $new$select * into v_existing from public.sales s where s.id=p_sale_id;
if found then
  if v_existing.shop_id<>p_shop_id then
    raise exception 'Sale id already belongs to another shop';
  end if;
  return jsonb_build_object(
    'ok',true,'already_committed',true,
    'sale_id',v_existing.id,'bill_no',v_existing.bill_no,'total',v_existing.total,
    'sale',to_jsonb(v_existing),
    'items',coalesce((select jsonb_agg(to_jsonb(si) order by si.id) from public.sale_items si where si.sale_id=v_existing.id),'[]'::jsonb),
    'payments',coalesce((select jsonb_agg(to_jsonb(sp) order by sp.id) from public.sale_payments sp where sp.sale_id=v_existing.id),'[]'::jsonb),
    'products',coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from public.products p where p.shop_id=p_shop_id and p.id in (select si.product_id from public.sale_items si where si.sale_id=v_existing.id)),'[]'::jsonb),
    'customer',case when v_existing.customer_id is null then null else (select to_jsonb(c) from public.customers c where c.id=v_existing.customer_id and c.shop_id=p_shop_id) end,
    'units',coalesce((select jsonb_agg(to_jsonb(iu) order by iu.id) from public.inventory_units iu where iu.shop_id=p_shop_id and iu.sale_id=v_existing.id),'[]'::jsonb)
  );
end if;$new$;
begin
  select pg_get_functiondef(p.oid) into d
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and p.proname='complete_sale_atomic'
  order by p.oid desc limit 1;
  if d is null then raise exception 'private.complete_sale_atomic not found'; end if;
  if position(old_block in d)=0 then raise exception 'Existing-sale idempotency block not found'; end if;
  d:=replace(d,old_block,new_block);
  execute d;
end
$patch$;
