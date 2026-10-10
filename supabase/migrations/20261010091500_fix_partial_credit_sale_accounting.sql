-- Keep partial-credit accounting consistent with the POS tender model.
-- A credit payment leg is the outstanding balance, not cash received now.
-- Run the private sale transaction and accounting correction in one database transaction
-- so a failed reconciliation rolls back the entire sale.

create or replace function private.complete_sale_atomic_with_credit_accounting(
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
security definer
set search_path to ''
as $function$
declare
  v_result jsonb;
  v_sale public.sales%rowtype;
  v_received numeric(12,2);
  v_credit_payment numeric(12,2);
  v_expected_due numeric(12,2);
  v_previous_due numeric(12,2);
  v_change numeric(12,2);
begin
  v_result := private.complete_sale_atomic(
    p_shop_id, p_sale_id, p_customer_id, p_shipping, p_discount, p_tax_pct,
    p_points_redeemed, p_note, p_salesman_id, p_lines, p_payments
  );

  if coalesce((v_result->>'ok')::boolean, false) is not true
     or coalesce((v_result->>'already_committed')::boolean, false) then
    return v_result;
  end if;

  select * into v_sale
  from public.sales
  where id = p_sale_id and shop_id = p_shop_id
  for update;

  if not found then
    raise exception 'Sale transaction returned success but the committed sale row is missing';
  end if;

  select
    coalesce(sum(case when sp.method::text <> 'credit' then sp.amount else 0 end), 0),
    coalesce(sum(case when sp.method::text = 'credit' then sp.amount else 0 end), 0)
  into v_received, v_credit_payment
  from public.sale_payments sp
  where sp.sale_id = p_sale_id;

  v_received := round(v_received, 2);
  v_credit_payment := round(v_credit_payment, 2);

  if v_credit_payment > 0 then
    v_expected_due := greatest(0, round(v_sale.total - v_received, 2));
    if abs(v_credit_payment - v_expected_due) > 0.01 then
      raise exception 'Credit amount does not match the remaining bill balance. Recheck received-now and balance-due amounts.';
    end if;
    if v_sale.customer_id is null then
      raise exception 'Select a customer before selling on credit';
    end if;

    -- The previous implementation included the credit leg in amount_paid,
    -- which made the calculated due zero for a fully specified partial-credit bill.
    -- Adjust by the difference so this remains safe if an earlier implementation
    -- already recorded some/all of the due.
    v_previous_due := greatest(0, round(v_sale.total - v_sale.amount_paid, 2));
    v_change := 0;

    update public.sales
    set amount_paid = v_received,
        change_amount = v_change
    where id = p_sale_id and shop_id = p_shop_id;

    update public.customers
    set credit_balance = coalesce(credit_balance, 0) + (v_expected_due - v_previous_due),
        updated_at = now()
    where id = v_sale.customer_id and shop_id = p_shop_id;

    return v_result || jsonb_build_object(
      'amount_paid', v_received,
      'change', v_change,
      'balance_due', v_expected_due
    );
  end if;

  -- For cash/card/bank/mobile bills, all payment legs are actual money received;
  -- preserve the original full-payment and cash-change behavior.
  return v_result;
end;
$function$;

revoke all on function private.complete_sale_atomic_with_credit_accounting(uuid,uuid,uuid,numeric,numeric,numeric,integer,text,uuid,jsonb,jsonb) from public, anon;
grant execute on function private.complete_sale_atomic_with_credit_accounting(uuid,uuid,uuid,numeric,numeric,numeric,integer,text,uuid,jsonb,jsonb) to authenticated;

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
  v_result := private.complete_sale_atomic_with_credit_accounting(
    p_shop_id, p_sale_id, p_customer_id, p_shipping, p_discount, p_tax_pct,
    p_points_redeemed, p_note, p_salesman_id, p_lines, p_payments
  );
  if coalesce((v_result->>'ok')::boolean, false) is not true then
    return v_result;
  end if;

  v_sale_id := (v_result->>'sale_id')::uuid;
  if v_sale_id is null then
    raise exception 'Atomic sale returned no sale id';
  end if;

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

revoke all on function public.complete_sale_atomic(uuid,uuid,uuid,numeric,numeric,numeric,integer,text,uuid,jsonb,jsonb) from public, anon;
grant execute on function public.complete_sale_atomic(uuid,uuid,uuid,numeric,numeric,numeric,integer,text,uuid,jsonb,jsonb) to authenticated;
