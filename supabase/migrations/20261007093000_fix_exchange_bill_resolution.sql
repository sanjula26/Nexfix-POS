-- Make exchange/return bill lookup authoritative and shop-safe.
-- The client must not depend on a direct sales-table SELECT being visible through RLS.
create or replace function private.resolve_sale_return_target(p_bill_no text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_bill_no text := upper(trim(coalesce(p_bill_no, '')));
  v_sale record;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if v_bill_no = '' then raise exception 'Bill number is required'; end if;

  select s.id, s.shop_id, s.bill_no, s.status
    into v_sale
  from public.sales s
  where upper(trim(s.bill_no)) = v_bill_no
    and s.shop_id in (
      select sm.shop_id
      from public.shop_memberships sm
      where sm.user_id = v_uid
        and sm.active = true
        and sm.role in ('admin','manager','cashier')
    )
    and s.status in ('completed','exchanged')
  order by s.created_at desc, s.id desc
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Sale not found');
  end if;

  return jsonb_build_object('ok', true, 'sale_id', v_sale.id, 'shop_id', v_sale.shop_id, 'bill_no', v_sale.bill_no, 'status', v_sale.status);
end;
$function$;

create or replace function public.resolve_sale_return_target(p_bill_no text)
returns jsonb
language sql
security invoker
set search_path to ''
as $wrapper$
  select private.resolve_sale_return_target(p_bill_no);
$wrapper$;

revoke all on function private.resolve_sale_return_target(text) from public, anon;
grant execute on function private.resolve_sale_return_target(text) to authenticated;

revoke all on function public.resolve_sale_return_target(text) from public, anon;
grant execute on function public.resolve_sale_return_target(text) to authenticated;
