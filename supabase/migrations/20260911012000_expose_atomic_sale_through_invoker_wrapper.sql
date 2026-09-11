-- Keep the privileged transactional sale implementation private while exposing
-- only a SECURITY INVOKER RPC to PostgREST. The private function performs the
-- stock/unit/payment mutations atomically; the public wrapper is the browser
-- entry point and does not itself run with elevated privileges.

create schema if not exists private;

alter function public.complete_sale_atomic(
  uuid, uuid, uuid, numeric, numeric, numeric, integer, text, uuid, jsonb, jsonb
) set schema private;

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
language sql
security invoker
set search_path to ''
as $$
  select private.complete_sale_atomic(
    p_shop_id,
    p_sale_id,
    p_customer_id,
    p_shipping,
    p_discount,
    p_tax_pct,
    p_points_redeemed,
    p_note,
    p_salesman_id,
    p_lines,
    p_payments
  );
$$;

revoke all on function public.complete_sale_atomic(
  uuid, uuid, uuid, numeric, numeric, numeric, integer, text, uuid, jsonb, jsonb
) from public, anon;

grant execute on function public.complete_sale_atomic(
  uuid, uuid, uuid, numeric, numeric, numeric, integer, text, uuid, jsonb, jsonb
) to authenticated;

grant execute on function private.complete_sale_atomic(
  uuid, uuid, uuid, numeric, numeric, numeric, integer, text, uuid, jsonb, jsonb
) to authenticated;
