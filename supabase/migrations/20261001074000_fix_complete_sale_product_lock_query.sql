-- Fix the product-lock query used by the atomic cloud sale.
--
-- PostgreSQL does not allow FOR UPDATE on a SELECT whose target query contains
-- DISTINCT. The previous join used SELECT DISTINCT over p_lines and then applied
-- FOR UPDATE to the outer query, which made every cloud sale fail before stock
-- validation. Keep the de-duplicated product IDs in an IN subquery so the outer
-- SELECT remains lockable.

do $migration$
declare
  d text;
  old_sql text := 'for v_product in select p.* from public.products p join (select distinct (x->>''product_id'')::uuid product_id from jsonb_array_elements(p_lines) x) ids on ids.product_id=p.id where p.shop_id=p_shop_id order by p.id for update loop null; end loop;';
  new_sql text := 'for v_product in select p.* from public.products p where p.shop_id=p_shop_id and p.id in (select (x->>''product_id'')::uuid from jsonb_array_elements(p_lines) x) order by p.id for update loop null; end loop;';
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

  if position(old_sql in d) = 0 then
    raise exception 'complete_sale_atomic product-lock anchor not found';
  end if;

  execute replace(d, old_sql, new_sql);
end
$migration$;
