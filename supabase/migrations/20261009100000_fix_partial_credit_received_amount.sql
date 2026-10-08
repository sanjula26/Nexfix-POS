-- Partial-credit sales: credit legs indicate the outstanding balance, not cash received.
-- amount_paid and the credit-limit calculation must count only non-credit tenders.
do $$
declare
  v_definition text;
  v_old text := 'v_amount_paid := v_amount_paid + v_payment_amount;';
  v_new text := 'if v_payment_method <> ''credit'' then
      v_amount_paid := v_amount_paid + v_payment_amount;
    end if;';
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

  if position(v_old in v_definition) = 0 then
    -- Idempotent deployment: the corrected payment loop is already installed.
    if position(v_new in v_definition) > 0 then
      return;
    end if;
    raise exception 'Expected complete_sale_atomic payment-total anchor was not found; refusing unsafe function rewrite';
  end if;

  v_definition := replace(v_definition, v_old, v_new);
  execute v_definition;
end
$$;
