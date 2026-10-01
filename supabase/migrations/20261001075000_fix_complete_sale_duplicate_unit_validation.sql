-- Fix the duplicate tracked-unit validation in the atomic cloud sale.
--
-- The validation originally reused the identifier "value" for both the JSON
-- array element and the lateral text element. PostgreSQL resolves that as an
-- ambiguous column reference at runtime. Give the lateral element its own
-- identifier so tracked-unit duplicate validation executes correctly.

do $migration$
declare
  d text;
begin
  select pg_get_functiondef(p.oid) into d
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private'
    and p.proname='complete_sale_atomic'
    and pg_get_function_identity_arguments(p.oid) =
      'p_shop_id uuid, p_sale_id uuid, p_customer_id uuid, p_shipping numeric, p_discount numeric, p_tax_pct numeric, p_points_redeemed integer, p_note text, p_salesman_id uuid, p_lines jsonb, p_payments jsonb';

  if d is null then
    raise exception 'private.complete_sale_atomic not found';
  end if;

  if position('select value::uuid as unit_id, count(*) as cnt' in d)=0 then
    raise exception 'duplicate tracked-unit validation select anchor not found';
  end if;

  d := replace(
    d,
    'select value::uuid as unit_id, count(*) as cnt',
    'select unit_value::uuid as unit_id, count(*) as cnt'
  );

  d := replace(
    d,
    'jsonb_array_elements_text(coalesce(l.value->''unit_ids'',''[]''::jsonb)) value',
    'jsonb_array_elements_text(coalesce(l.value->''unit_ids'',''[]''::jsonb)) as unit_value'
  );

  d := replace(
    d,
    'group by value::uuid',
    'group by unit_value::uuid'
  );

  execute d;
end
$migration$;
