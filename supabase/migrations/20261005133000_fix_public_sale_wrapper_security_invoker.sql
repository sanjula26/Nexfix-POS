-- Keep the exposed sale RPC as a SECURITY INVOKER wrapper.
-- The private implementation remains SECURITY DEFINER because it is the
-- authoritative atomic transaction boundary and validates shop membership,
-- device authorization, stock and payment invariants itself.
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
) returns jsonb
language sql
security invoker
set search_path to ''
as $function$
  select private.complete_sale_atomic(
    p_shop_id,p_sale_id,p_customer_id,p_shipping,p_discount,p_tax_pct,
    p_points_redeemed,p_note,p_salesman_id,p_lines,p_payments
  )
$function$;

revoke all on function public.complete_sale_atomic(uuid,uuid,uuid,numeric,numeric,numeric,integer,text,uuid,jsonb,jsonb) from public, anon;
grant execute on function public.complete_sale_atomic(uuid,uuid,uuid,numeric,numeric,numeric,integer,text,uuid,jsonb,jsonb) to authenticated;
revoke all on function private.complete_sale_atomic(uuid,uuid,uuid,numeric,numeric,numeric,integer,text,uuid,jsonb,jsonb) from public, anon, authenticated;
