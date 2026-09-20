-- Enforce the same customer credit limit in the cloud atomic sale path
-- that the local POS already enforces.
do $$
declare
  d text;
begin
  select pg_get_functiondef(p.oid)
    into d
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private'
    and p.proname = 'complete_sale_atomic'
  limit 1;

  if d is null then
    raise exception 'private.complete_sale_atomic not found';
  end if;

  if position('v_credit_limit numeric(12,2)' in d) = 0 then
    d := replace(
      d,
      'v_balance_due numeric(12,2):=0; v_points_earned integer:=0;',
      'v_balance_due numeric(12,2):=0; v_credit_limit numeric(12,2):=0; v_points_earned integer:=0;'
    );
  end if;

  if position('v_credit_limit:=greatest(coalesce(v_customer.credit_limit,0),0);' in d) = 0 then
    d := replace(
      d,
      'v_balance_due:=case when v_has_credit then greatest(0,v_total-v_amount_paid) else 0 end;',
      'v_credit_limit:=greatest(coalesce(v_customer.credit_limit,0),0); if v_has_credit and p_customer_id is not null and v_credit_limit>0 and coalesce(v_customer.credit_balance,0)+greatest(0,v_total-v_amount_paid)>v_credit_limit then raise exception ''Customer credit limit exceeded''; end if; v_balance_due:=case when v_has_credit then greatest(0,v_total-v_amount_paid) else 0 end;'
    );
  end if;

  if position('Customer credit limit exceeded' in d) = 0 then
    raise exception 'Expected credit validation insertion point was not found';
  end if;

  execute d;
end $$;
