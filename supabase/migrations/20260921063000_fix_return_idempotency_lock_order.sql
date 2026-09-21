-- Make return-id idempotency observe the committed row after the sale lock.
-- Locking the sale first serializes concurrent returns for the same sale.
do $$
declare d text; old text; new text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and p.proname='process_sale_return_atomic' limit 1;
  if d is null then raise exception 'private.process_sale_return_atomic not found'; end if;
  old:=E'  select * into v_existing from public.sale_returns where id=p_return_id and shop_id=p_shop_id;\n  if found then\n    if v_existing.sale_id<>p_sale_id then raise exception ''Return id already belongs to another sale''; end if;\n    return jsonb_build_object(''ok'',true,''already_committed'',true,''return_id'',v_existing.id,''return_no'',v_existing.return_no,''refund_amount'',v_existing.refund_amount,''additional_payment'',v_existing.additional_payment);\n  end if;\n  select * into v_sale from public.sales where id=p_sale_id and shop_id=p_shop_id for update;';
  new:=E'  select * into v_sale from public.sales where id=p_sale_id and shop_id=p_shop_id for update;\n  if not found then raise exception ''Sale not found''; end if;\n  select * into v_existing from public.sale_returns where id=p_return_id and shop_id=p_shop_id;\n  if found then\n    if v_existing.sale_id<>p_sale_id then raise exception ''Return id already belongs to another sale''; end if;\n    return jsonb_build_object(''ok'',true,''already_committed'',true,''return_id'',v_existing.id,''return_no'',v_existing.return_no,''refund_amount'',v_existing.refund_amount,''additional_payment'',v_existing.additional_payment);\n  end if;';
  if position(old in d)=0 then raise exception 'race ordering anchor not found'; end if;
  d:=replace(d,old,new);
  execute d;
end $$;