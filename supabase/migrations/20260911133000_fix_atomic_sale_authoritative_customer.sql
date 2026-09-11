CREATE OR REPLACE FUNCTION public.complete_sale_atomic(p_shop_id uuid, p_sale_id uuid, p_customer_id uuid DEFAULT NULL, p_shipping numeric DEFAULT 0, p_discount numeric DEFAULT 0, p_tax_pct numeric DEFAULT 0, p_points_redeemed integer DEFAULT 0, p_note text DEFAULT NULL, p_salesman_id uuid DEFAULT NULL, p_lines jsonb DEFAULT '[]'::jsonb, p_payments jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $$
declare
  v_result jsonb;
  v_sale_id uuid;
  v_committed_customer_id uuid;
begin
  v_result := private.complete_sale_atomic(
    p_shop_id,p_sale_id,p_customer_id,p_shipping,p_discount,p_tax_pct,
    p_points_redeemed,p_note,p_salesman_id,p_lines,p_payments
  );
  if coalesce((v_result->>'ok')::boolean,false) is not true then return v_result; end if;
  v_sale_id := (v_result->>'sale_id')::uuid;
  if v_sale_id is null then raise exception 'Atomic sale returned no sale id'; end if;
  select s.customer_id into v_committed_customer_id
  from public.sales s where s.id=v_sale_id and s.shop_id=p_shop_id;
  return v_result || jsonb_build_object(
    'sale',(select to_jsonb(s) from public.sales s where s.id=v_sale_id and s.shop_id=p_shop_id),
    'items',coalesce((select jsonb_agg(to_jsonb(si) order by si.id) from public.sale_items si where si.sale_id=v_sale_id),'[]'::jsonb),
    'payments',coalesce((select jsonb_agg(to_jsonb(sp) order by sp.id) from public.sale_payments sp where sp.sale_id=v_sale_id),'[]'::jsonb),
    'products',coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from public.products p where p.id in (select si.product_id from public.sale_items si where si.sale_id=v_sale_id) and p.shop_id=p_shop_id),'[]'::jsonb),
    'customer',case when v_committed_customer_id is null then null else (select to_jsonb(c) from public.customers c where c.id=v_committed_customer_id and c.shop_id=p_shop_id) end,
    'units',coalesce((select jsonb_agg(to_jsonb(iu) order by iu.id) from public.inventory_units iu where iu.sale_id=v_sale_id and iu.shop_id=p_shop_id),'[]'::jsonb)
  );
end;
$$;
