-- Keep replacement returns proportional to the returned merchandise value when reversing loyalty points.
-- The public RPC is an invoker wrapper; loyalty accounting belongs in the private transaction function.
do $$
declare
  d text;
begin
  select pg_get_functiondef(p.oid) into d
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private'
    and p.proname = 'process_sale_return_atomic'
  limit 1;

  if d is null then raise exception 'private.process_sale_return_atomic not found'; end if;

  if position('p_mode=''replace'' then case when coalesce(v_sale.total,0)>0 then least(1, greatest(0,round(v_taxable_returned+v_tax_refund,2))/v_sale.total) else 1 end' in d) = 0 then
    d := replace(
      d,
      'v_returned_ratio:=case when coalesce(v_sale.total,0)>0 then least(1,v_refund/v_sale.total) else 1 end;',
      'v_returned_ratio:=case when p_mode=''replace'' then case when coalesce(v_sale.total,0)>0 then least(1, greatest(0,round(v_taxable_returned+v_tax_refund,2))/v_sale.total) else 1 end else case when coalesce(v_sale.total,0)>0 then least(1,v_refund/v_sale.total) else 1 end end;'
    );
  end if;

  if position('p_mode=''replace'' then case when coalesce(v_sale.total,0)>0 then least(1, greatest(0,round(v_taxable_returned+v_tax_refund,2))/v_sale.total) else 1 end' in d) = 0 then
    raise exception 'Expected replacement loyalty ratio insertion point was not found';
  end if;

  execute d;
end $$;