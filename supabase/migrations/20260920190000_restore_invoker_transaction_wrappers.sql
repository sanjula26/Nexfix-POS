-- Restore the public cloud transaction RPCs to their intended invoker-wrapper boundary.
-- The private implementations remain SECURITY DEFINER, search_path='', and are not
-- executable by API roles. Public wrappers run as the caller so RLS applies to the
-- authoritative response reads.

create or replace function public.complete_sale_atomic(
  p_shop_id uuid,
  p_sale_id uuid,
  p_customer_id uuid default null,
  p_shipping numeric default 0,
  p_discount numeric default 0,
  p_tax_pct numeric default 0,
  p_points_redeemed integer default 0,
  p_note text default null,
  p_salesman_id uuid default null,
  p_lines jsonb default '[]'::jsonb,
  p_payments jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_result jsonb;
  v_sale_id uuid;
begin
  v_result := private.complete_sale_atomic(
    p_shop_id,p_sale_id,p_customer_id,p_shipping,p_discount,p_tax_pct,
    p_points_redeemed,p_note,p_salesman_id,p_lines,p_payments
  );
  if coalesce((v_result->>'ok')::boolean, false) is not true then return v_result; end if;
  v_sale_id := (v_result->>'sale_id')::uuid;
  if v_sale_id is null then raise exception 'Atomic sale returned no sale id'; end if;
  return v_result || jsonb_build_object(
    'sale', (select to_jsonb(s) from public.sales s where s.id=v_sale_id and s.shop_id=p_shop_id),
    'items', coalesce((select jsonb_agg(to_jsonb(si) order by si.id) from public.sale_items si where si.sale_id=v_sale_id),'[]'::jsonb),
    'payments', coalesce((select jsonb_agg(to_jsonb(sp) order by sp.id) from public.sale_payments sp where sp.sale_id=v_sale_id),'[]'::jsonb),
    'products', coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from public.products p where p.id in (select si.product_id from public.sale_items si where si.sale_id=v_sale_id) and p.shop_id=p_shop_id),'[]'::jsonb),
    'customer', case when p_customer_id is null then null else (select to_jsonb(c) from public.customers c where c.id=p_customer_id and c.shop_id=p_shop_id) end,
    'units', coalesce((select jsonb_agg(to_jsonb(iu) order by iu.id) from public.inventory_units iu where iu.sale_id=v_sale_id and iu.shop_id=p_shop_id),'[]'::jsonb)
  );
end;
$function$;

create or replace function public.process_sale_return_atomic(
  p_shop_id uuid,p_return_id uuid,p_sale_id uuid,p_reason text,p_mode text,p_payment_method text,p_lines jsonb
)
returns jsonb
language sql
security invoker
set search_path to ''
as $wrapper$
select private.process_sale_return_atomic($1,$2,$3,$4,$5,$6,$7)
$wrapper$;

revoke all on function public.complete_sale_atomic(uuid,uuid,uuid,numeric,numeric,numeric,integer,text,uuid,jsonb,jsonb) from public, anon;
grant execute on function public.complete_sale_atomic(uuid,uuid,uuid,numeric,numeric,numeric,integer,text,uuid,jsonb,jsonb) to authenticated;
revoke all on function public.process_sale_return_atomic(uuid,uuid,uuid,text,text,text,jsonb) from public, anon;
grant execute on function public.process_sale_return_atomic(uuid,uuid,uuid,text,text,text,jsonb) to authenticated;
