-- Fix loyalty accounting for replacement returns: replacements have no cash refund,
-- so the private return function cannot use refund_amount as the loyalty ratio.
create or replace function public.process_sale_return_atomic(
  p_shop_id uuid,
  p_return_id uuid,
  p_sale_id uuid,
  p_reason text,
  p_mode text,
  p_payment_method text,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_days integer;
  v_created timestamptz;
  v_result jsonb;
  v_customer_id uuid;
  v_points_earned integer := 0;
  v_points_redeemed integer := 0;
  v_sale_total numeric := 0;
  v_sale_subtotal numeric := 0;
  v_sale_discount numeric := 0;
  v_post_discount numeric := 0;
  v_returned_merch numeric := 0;
  v_allocated_discount numeric := 0;
  v_taxable_returned numeric := 0;
  v_tax_refund numeric := 0;
  v_returned_value numeric := 0;
  v_returned_ratio numeric := 0;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;

  select exchange_days into v_days
    from public.shops
   where id = p_shop_id;

  if v_days is null then raise exception 'Shop not found'; end if;

  select created_at into v_created
    from public.sales
   where id = p_sale_id
     and shop_id = p_shop_id;

  if v_created is null then raise exception 'Sale not found'; end if;

  if v_created < now() - make_interval(days => greatest(v_days,0)) then
    raise exception 'Sale is outside the exchange policy window';
  end if;

  v_result := private.process_sale_return_atomic(
    p_shop_id,
    p_return_id,
    p_sale_id,
    p_reason,
    p_mode,
    p_payment_method,
    p_lines
  );

  -- Replacement returns have no cash refund, so the private return function
  -- intentionally leaves the loyalty balance unchanged. Reverse the earned
  -- points and restore redeemed points here, proportionally to the returned
  -- value, so replacement and refund paths have the same loyalty accounting.
  if p_mode = 'replace' then
    select
      s.customer_id,
      coalesce(s.points_earned, 0),
      coalesce(s.points_redeemed, 0),
      greatest(0, coalesce(s.total, 0)),
      greatest(0, coalesce(s.subtotal, 0)),
      least(greatest(0, coalesce(s.discount, 0)), greatest(0, coalesce(s.subtotal, 0))),
      coalesce(s.tax, 0)
    into
      v_customer_id,
      v_points_earned,
      v_points_redeemed,
      v_sale_total,
      v_sale_subtotal,
      v_sale_discount,
      v_tax_refund
    from public.sales s
    where s.id = p_sale_id
      and s.shop_id = p_shop_id;

    if v_customer_id is not null then
      select coalesce(sum(
        greatest(
          0,
          round(
            (si.price * sri.qty
              - coalesce(si.discount, 0) * (sri.qty / nullif(si.qty, 0)))::numeric,
            2
          )
        )
      ), 0)
      into v_returned_merch
      from public.sale_return_items sri
      join public.sale_items si on si.id = sri.sale_item_id
      where sri.return_id = p_return_id;

      v_post_discount := greatest(0, v_sale_subtotal - v_sale_discount);
      v_allocated_discount := least(
        v_sale_discount,
        v_returned_merch * case
          when v_sale_subtotal > 0 then v_sale_discount / v_sale_subtotal
          else 0
        end
      );
      v_taxable_returned := greatest(0, v_returned_merch - v_allocated_discount);
      v_tax_refund := case
        when v_post_discount > 0
          then round(v_tax_refund * (v_taxable_returned / v_post_discount), 2)
        else 0
      end;
      v_returned_value := greatest(0, round(v_taxable_returned + v_tax_refund, 2));
      v_returned_ratio := case
        when v_sale_total > 0 then least(1, v_returned_value / v_sale_total)
        else 1
      end;

      update public.customers
         set loyalty_points = greatest(
           0,
           coalesce(loyalty_points, 0)
             - least(v_points_earned, round(v_points_earned * v_returned_ratio))
             + least(v_points_redeemed, round(v_points_redeemed * v_returned_ratio))
         ),
         updated_at = now()
       where id = v_customer_id
         and shop_id = p_shop_id;
    end if;
  end if;

  return v_result;
end;
$function$;
