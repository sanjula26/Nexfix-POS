-- Keep local and cloud payment validation aligned: a credit sale cannot
-- contain payment legs whose total exceeds the sale total.
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

  if position(
    'if v_has_credit and v_amount_paid>v_total then raise exception ''Credit payment total cannot exceed sale total'';'
    in d
  ) = 0 then
    d := replace(
      d,
      'if not v_has_credit and v_amount_paid<v_total then raise exception ''Payment total is less than sale total''; end if;',
      'if v_has_credit and v_amount_paid>v_total then raise exception ''Credit payment total cannot exceed sale total''; end if; if not v_has_credit and v_amount_paid<v_total then raise exception ''Payment total is less than sale total''; end if;'
    );

    if position(
      'if v_has_credit and v_amount_paid>v_total then raise exception ''Credit payment total cannot exceed sale total'';'
      in d
    ) = 0 then
      raise exception 'Expected payment validation block was not found';
    end if;

    execute d;
  end if;
end $$;
