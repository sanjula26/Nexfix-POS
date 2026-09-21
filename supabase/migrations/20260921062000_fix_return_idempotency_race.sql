-- Re-check return-id idempotency after locking the sale row.
-- This closes the concurrent same-return race: the second transaction waits on
-- the sale lock, then observes the committed return and returns the same result.
do $$
declare d text; anchor text; block text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and p.proname='process_sale_return_atomic' limit 1;
  if d is null then raise exception 'private.process_sale_return_atomic not found'; end if;
  anchor := E'  select * into v_sale from public.sales where id=p_sale_id and shop_id=p_shop_id for update;\n  if not found then raise exception ''Sale not found''; end if;';
  block := E'  select * into v_sale from public.sales where id=p_sale_id and shop_id=p_shop_id for update;\n  if not found then raise exception ''Sale not found''; end if;\n  select * into v_existing from public.sale_returns where id=p_return_id and shop_id=p_shop_id;\n  if found then\n    if v_existing.sale_id<>p_sale_id then raise exception ''Return id already belongs to another sale''; end if;\n    return jsonb_build_object(''ok'',true,''already_committed'',true,''return_id'',v_existing.id,''return_no'',v_existing.return_no,''refund_amount'',v_existing.refund_amount,''additional_payment'',v_existing.additional_payment);\n  end if;';
  if position('return jsonb_build_object(''ok'',true,''already_committed'',true,''return_id'',v_existing.id' in d)=0 then
    d:=replace(d,anchor,block);
  end if;
  execute d;
end $$;