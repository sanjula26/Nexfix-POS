-- Partial-credit sales: credit legs indicate the outstanding balance, not cash received.
-- amount_paid and the credit-limit calculation must count only non-credit tenders.
do $$
declare
  v_definition text;
  v_old_spaced text := 'v_amount_paid := v_amount_paid + v_payment_amount;';
  v_new_spaced text := 'if v_payment_method <> ''credit'' then
      v_amount_paid := v_amount_paid + v_payment_amount;
    end if;';
  v_old_compact text := 'v_amount_paid:=v_amount_paid+v_payment_amount;';
  v_new_compact text := 'if v_payment_method<>''credit'' then v_amount_paid:=v_amount_paid+v_payment_amount; end if;';
begin
  select pg_get_functiondef(p.oid)
    into v_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private'
    and p.proname = 'complete_sale_atomic'
  order by p.oid desc
  limit 1;

  if v_definition is null then
    raise exception 'private.complete_sale_atomic was not found';
  end if;

  if position(v_old_spaced in v_definition) > 0 then
    v_definition := replace(v_definition, v_old_spaced, v_new_spaced);
  elsif position(v_old_compact in v_definition) > 0 then
    v_definition := replace(v_definition, v_old_compact, v_new_compact);
  elsif position(v_new_spaced in v_definition) > 0 or position(v_new_compact in v_definition) > 0 then
    return;
  else
    raise exception 'Expected complete_sale_atomic payment-total anchor was not found; refusing unsafe function rewrite';
  end if;

  execute v_definition;
end
$$;
