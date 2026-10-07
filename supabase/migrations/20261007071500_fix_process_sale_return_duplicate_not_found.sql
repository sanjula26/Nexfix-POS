do $migration$
declare
  v_def text;
  v_fixed text;
begin
  select pg_get_functiondef(p.oid)
    into v_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private'
    and p.proname = 'process_sale_return_atomic'
    and pg_get_function_identity_arguments(p.oid) = 'p_shop_id uuid, p_return_id uuid, p_sale_id uuid, p_reason text, p_mode text, p_payment_method text, p_lines jsonb'
  order by p.oid desc
  limit 1;

  if v_def is null then
    raise exception 'private.process_sale_return_atomic definition not found';
  end if;

  v_fixed := replace(
    v_def,
    E'  if found then\n    if v_existing.sale_id<>p_sale_id then raise exception ''Return id already belongs to another sale''; end if;\n    return jsonb_build_object(''ok'',true,''already_committed'',true,''return_id'',v_existing.id,''return_no'',v_existing.return_no,''refund_amount'',v_existing.refund_amount,''additional_payment'',v_existing.additional_payment);\n  end if;\n  if not found then raise exception ''Sale not found''; end if;\n  if v_sale.status',
    E'  if found then\n    if v_existing.sale_id<>p_sale_id then raise exception ''Return id already belongs to another sale''; end if;\n    return jsonb_build_object(''ok'',true,''already_committed'',true,''return_id'',v_existing.id,''return_no'',v_existing.return_no,''refund_amount'',v_existing.refund_amount,''additional_payment'',v_existing.additional_payment);\n  end if;\n  if v_sale.status'
  );

  if v_fixed = v_def then
    raise exception 'Expected duplicate Sale not found guard was not found; refusing unsafe function rewrite';
  end if;

  execute v_fixed;
end
$migration$;