-- Keep cloud credit enforcement and loyalty accounting aligned with the local POS.
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
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_cashier_name text;
  v_customer_name text := 'Walk-in customer';
  v_counter integer;
  v_bill_no text;
  v_created_at timestamptz := now();
  v_subtotal numeric(12,2) := 0;
  v_line_discount numeric(12,2) := 0;
  v_discount numeric(12,2) := 0;
  v_tax numeric(12,2) := 0;
  v_shipping numeric(12,2) := 0;
  v_points_value numeric(12,2) := 0;
  v_applied_points_value numeric(12,2) := 0;
  v_total numeric(12,2) := 0;
  v_profit numeric(12,2) := 0;
  v_amount_paid numeric(12,2) := 0;
  v_change numeric(12,2) := 0;
  v_balance_due numeric(12,2) := 0;
  v_points_earned integer := 0;
  v_points_redeemed integer := greatest(coalesce(p_points_redeemed, 0), 0);
  v_earn_div integer;
  v_point_value numeric(12,2);
  v_has_credit boolean := false;
  v_existing public.sales;
  v_line jsonb;
  v_payment jsonb;
  v_product public.products;
  v_customer public.customers;
  v_unit_ids uuid[];
  v_qty numeric(12,2);
  v_price numeric(12,2);
  v_line_disc numeric(12,2);
  v_gross numeric(12,2);
  v_cost numeric(12,2);
  v_unit_count integer;
  v_payment_method public.payment_method;
  v_payment_amount numeric(12,2);
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;

  if p_shop_id is null or p_sale_id is null then
    raise exception 'Shop and sale id are required';
  end if;

  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'At least one sale line is required';
  end if;

  if jsonb_typeof(coalesce(p_payments, '[]'::jsonb)) <> 'array' then
    raise exception 'Invalid payment payload';
  end if;

  select m.role
    into v_role
  from public.shop_memberships m
  where m.shop_id = p_shop_id
    and m.user_id = v_uid
    and m.active = true;

  if v_role is null or v_role not in ('admin', 'manager', 'cashier') then
    raise exception 'User is not authorized to complete sales for this shop';
  end if;

  select p.full_name
    into v_cashier_name
  from public.profiles p
  where p.id = v_uid;

  if v_cashier_name is null then
    raise exception 'Cashier profile not found';
  end if;

  -- Idempotency: a retry of an already committed sale must not create a
  -- second bill or decrement stock twice.
  select * into v_existing
  from public.sales
  where id = p_sale_id;

  if found then
    if v_existing.shop_id <> p_shop_id then
      raise exception 'Sale id already belongs to another shop';
    end if;
    return jsonb_build_object(
      'ok', true,
      'already_committed', true,
      'sale_id', v_existing.id,
      'bill_no', v_existing.bill_no,
      'total', v_existing.total
    );
  end if;

  if p_customer_id is not null then
    select c.name
      into v_customer_name
    from public.customers c
    where c.id = p_customer_id
      and c.shop_id = p_shop_id;
    if v_customer_name is null then
      raise exception 'Customer not found for this shop';
    end if;
  end if;

  if p_salesman_id is not null and not exists (
    select 1
    from public.profiles sp
    join public.shop_memberships sm on sm.user_id = sp.id
    where sp.id = p_salesman_id
      and sm.shop_id = p_shop_id
      and sm.active = true
      and sp.active = true
  ) then
    raise exception 'Invalid salesman';
  end if;

  if p_shipping is null or p_shipping < 0 or p_shipping > 100000000 then
    raise exception 'Invalid shipping amount';
  end if;
  if p_discount is null or p_discount < 0 or p_discount > 100000000 then
    raise exception 'Invalid discount amount';
  end if;
  if p_tax_pct is null or p_tax_pct < 0 or p_tax_pct > 100 then
    raise exception 'Invalid tax percentage';
  end if;
  if v_points_redeemed > 0 and p_customer_id is null then
    raise exception 'Points can only be redeemed for a customer';
  end if;

  v_shipping := round(coalesce(p_shipping, 0), 2);

  -- Lock all affected products in deterministic UUID order before changing
  -- stock. This serializes concurrent sales of the same inventory rows.
  perform 1
  from public.products p
  join (
    select distinct (x->>'product_id')::uuid as product_id
    from jsonb_array_elements(p_lines) x
  ) ids on ids.product_id = p.id
  where p.shop_id = p_shop_id
  order by p.id
  for update;

  -- Reject duplicate tracked-unit ids across cart lines before any write.
  if exists (
    select unit_id
    from jsonb_array_elements(p_lines) line
    cross join lateral jsonb_array_elements_text(coalesce(line->'unit_ids', '[]'::jsonb)) raw(unit_text)
    cross join lateral (select raw.unit_text::uuid as unit_id) parsed
    group by unit_id
    having count(*) > 1
  ) then
    raise exception 'The same IMEI/serial unit cannot be sold twice';
  end if;

  -- Re-check every requested line against the now-locked product rows.
  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    if (v_line->>'product_id') is null then
      raise exception 'Sale line is missing product_id';
    end if;

    select * into v_product
    from public.products
    where id = (v_line->>'product_id')::uuid
      and shop_id = p_shop_id
    for update;

    if not found then
      raise exception 'Product not found for this shop';
    end if;

    v_qty := (v_line->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Invalid sale quantity';
    end if;

    if v_product.stock < v_qty then
      raise exception 'Insufficient stock for product %', v_product.name;
    end if;

    if (v_line->>'price') is null then
      v_price := round(v_product.price, 2);
    else
      v_price := round((v_line->>'price')::numeric, 2);
      if v_price < 0 then
        raise exception 'Invalid sale price';
      end if;
      if v_price <> round(v_product.price, 2) and v_role not in ('admin', 'manager') then
        raise exception 'Price override requires manager or admin authorization';
      end if;
    end if;

    v_gross := round(v_price * v_qty, 2);
    v_line_disc := greatest(0, least(coalesce((v_line->>'discount')::numeric, 0), v_gross));
    v_cost := round(coalesce(v_product.cost, 0), 2);

    if (v_product.track_imei or v_product.track_serial) then
      if v_qty <> trunc(v_qty) then
        raise exception 'Tracked product quantity must be a whole number';
      end if;
      v_unit_ids := coalesce(
        array(select value::uuid from jsonb_array_elements_text(coalesce(v_line->'unit_ids', '[]'::jsonb))),
        '{}'::uuid[]
      );
      v_unit_count := coalesce(array_length(v_unit_ids, 1), 0);
      if v_unit_count <> v_qty::integer then
        raise exception 'Tracked product requires one in-stock unit per quantity';
      end if;

      if exists (
        select 1
        from public.inventory_units iu
        where iu.id = any(v_unit_ids)
          and (iu.shop_id <> p_shop_id or iu.product_id <> v_product.id or iu.status <> 'in_stock')
      ) then
        raise exception 'One or more IMEI/serial units are no longer available';
      end if;

      perform 1
      from public.inventory_units iu
      where iu.id = any(v_unit_ids)
      order by iu.id
      for update;

      if (select count(*) from public.inventory_units iu where iu.id = any(v_unit_ids)) <> v_unit_count then
        raise exception 'One or more IMEI/serial units were not found';
      end if;
    else
      v_unit_ids := '{}'::uuid[];
    end if;

    v_subtotal := v_subtotal + v_gross - v_line_disc;
    v_line_discount := v_line_discount + v_line_disc;
    v_profit := v_profit + ((v_price - v_cost) * v_qty) - v_line_disc;
  end loop;

  v_discount := round(least(greatest(p_discount, 0), v_subtotal), 2);
  v_tax := round(((v_subtotal - v_discount) * p_tax_pct) / 100, 2);

  select s.loyalty_earn_div, s.loyalty_point_value
    into v_earn_div, v_point_value
  from public.shops s
  where s.id = p_shop_id;

  if v_earn_div is null then v_earn_div := 1000; end if;
  if v_point_value is null then v_point_value := 20; end if;
  v_earn_div := greatest(v_earn_div, 1);
  v_point_value := greatest(v_point_value, 0);

  if p_customer_id is not null then
    select * into v_customer
    from public.customers
    where id = p_customer_id
      and shop_id = p_shop_id
    for update;
    if not found then
      raise exception 'Customer not found for this shop';
    end if;
    if v_points_redeemed > coalesce(v_customer.loyalty_points, 0) then
      raise exception 'Insufficient loyalty points';
    end if;
  end if;

  v_points_value := round(v_points_redeemed * v_point_value, 2);
  v_applied_points_value := least(v_points_value, greatest(0, v_subtotal - v_discount + v_tax + v_shipping));
  v_total := greatest(0, round(
    v_subtotal - v_discount + v_tax + v_shipping - v_applied_points_value, 2
  ));
  v_points_earned := case when p_customer_id is null then 0 else floor(v_total / v_earn_div)::integer end;
  v_profit := round(v_profit - v_discount - v_applied_points_value + v_shipping, 2);

  for v_payment in select value from jsonb_array_elements(p_payments)
  loop
    if (v_payment->>'method') is null or (v_payment->>'amount') is null then
      raise exception 'Invalid payment leg';
    end if;
    v_payment_method := (v_payment->>'method')::public.payment_method;
    v_payment_amount := round((v_payment->>'amount')::numeric, 2);
    if v_payment_amount <= 0 then
      raise exception 'Payment amount must be positive';
    end if;
    v_amount_paid := v_amount_paid + v_payment_amount;
    v_has_credit := v_has_credit or v_payment_method = 'credit';
  end loop;

  if jsonb_array_length(p_payments) = 0 then
    raise exception 'At least one payment is required';
  end if;

  v_amount_paid := round(v_amount_paid, 2);
  if v_has_credit and p_customer_id is null then
    raise exception 'Credit payment requires a customer';
  end if;
  if not v_has_credit and v_amount_paid < v_total then
    raise exception 'Payment total is less than sale total';
  end if;
  v_balance_due := case when v_has_credit then greatest(0, v_total - v_amount_paid) else 0 end;
  v_change := case when v_has_credit then 0 else greatest(0, v_amount_paid - v_total) end;

  if v_has_credit and p_customer_id is not null and coalesce(v_customer.credit_limit, 0) > 0
     and coalesce(v_customer.credit_balance, 0) + v_balance_due > v_customer.credit_limit then
    raise exception 'Credit limit exceeded';
  end if;

  insert into public.counters(shop_id, bill)
  values (p_shop_id, 0)
  on conflict (shop_id) do nothing;

  update public.counters
  set bill = bill + 1
  where shop_id = p_shop_id
  returning bill into v_counter;

  if v_counter is null then
    raise exception 'Unable to allocate bill number';
  end if;

  v_bill_no := 'NFX-' || to_char(v_created_at at time zone 'UTC', 'YYYYMMDD') || '-' || lpad((v_counter % 10000)::text, 4, '0');

  insert into public.sales (
    id, shop_id, bill_no, customer_id, customer_name, cashier_id, cashier_name,
    salesman_id, subtotal, discount, tax, shipping, total, amount_paid,
    change_amount, profit, points_earned, points_redeemed, status, note, created_at
  ) values (
    p_sale_id, p_shop_id, v_bill_no, p_customer_id, v_customer_name, v_uid,
    v_cashier_name, p_salesman_id, round(v_subtotal,2), v_discount, v_tax,
    v_shipping, v_total, v_amount_paid, v_change, v_profit, v_points_earned,
    v_points_redeemed, 'completed', nullif(btrim(coalesce(p_note,'')), ''), v_created_at
  );

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    select * into v_product
    from public.products
    where id = (v_line->>'product_id')::uuid
      and shop_id = p_shop_id;

    v_qty := (v_line->>'qty')::numeric;
    v_price := round(coalesce((v_line->>'price')::numeric, v_product.price), 2);
    v_gross := round(v_price * v_qty, 2);
    v_line_disc := greatest(0, least(coalesce((v_line->>'discount')::numeric, 0), v_gross));
    v_unit_ids := coalesce(array(select value::uuid from jsonb_array_elements_text(coalesce(v_line->'unit_ids','[]'::jsonb))), '{}'::uuid[]);

    insert into public.sale_items (
      sale_id, product_id, name, qty, price, cost, discount, price_overridden,
      warranty_months, unit_ids
    ) values (
      p_sale_id, v_product.id, v_product.name, v_qty, v_price, v_product.cost,
      v_line_disc, (v_price <> round(v_product.price,2)), v_product.warranty_months,
      v_unit_ids
    );

    update public.products
    set stock = stock - v_qty,
        updated_at = now()
    where id = v_product.id
      and shop_id = p_shop_id;

    if v_product.track_imei or v_product.track_serial then
      update public.inventory_units
      set status = 'sold', sale_id = p_sale_id, sale_bill_no = v_bill_no,
          sold_at = v_created_at,
          warranty_months = v_product.warranty_months,
          warranty_expires_at = case
            when v_product.warranty_months is null or v_product.warranty_months <= 0 then null
            else (v_created_at::date + make_interval(months => v_product.warranty_months))::date
          end
      where id = any(v_unit_ids);
    end if;
  end loop;

  for v_payment in select value from jsonb_array_elements(p_payments)
  loop
    insert into public.sale_payments(sale_id, method, amount)
    values (
      p_sale_id,
      (v_payment->>'method')::public.payment_method,
      round((v_payment->>'amount')::numeric, 2)
    );
  end loop;

  if p_customer_id is not null then
    update public.customers
    set credit_balance = credit_balance + v_balance_due,
        loyalty_points = greatest(0, loyalty_points - v_points_redeemed) + v_points_earned,
        updated_at = now()
    where id = p_customer_id and shop_id = p_shop_id;
  end if;

  insert into public.audit_log(shop_id, user_id, user_email, action, entity, details)
  values (
    p_shop_id, v_uid,
    (select email from public.profiles where id = v_uid),
    'SALE', 'Sale',
    'Atomic sale ' || v_bill_no || ' · Rs. ' || v_total::text
  );

  return jsonb_build_object(
    'ok', true,
    'already_committed', false,
    'sale_id', p_sale_id,
    'bill_no', v_bill_no,
    'subtotal', v_subtotal,
    'discount', v_discount,
    'tax', v_tax,
    'shipping', v_shipping,
    'total', v_total,
    'amount_paid', v_amount_paid,
    'change', v_change,
    'balance_due', v_balance_due,
    'profit', v_profit,
    'points_earned', v_points_earned,
    'points_redeemed', v_points_redeemed
  );
end;
$$;
