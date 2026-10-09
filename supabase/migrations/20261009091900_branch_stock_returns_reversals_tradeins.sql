CREATE OR REPLACE FUNCTION private.process_sale_return_atomic(p_shop_id uuid, p_return_id uuid, p_sale_id uuid, p_reason text, p_mode text, p_payment_method text, p_lines jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_sale public.sales%rowtype;
  v_existing public.sale_returns%rowtype;
  v_return_no text;
  v_refund numeric := 0;
  v_additional numeric := 0;
  v_sale_subtotal numeric := 0;
  v_sale_discount numeric := 0;
  v_post_discount numeric := 0;
  v_tax_refund numeric := 0;
  v_shipping_refund numeric := 0;
  v_returned_merch numeric := 0;
  v_tradein_total numeric := 0;
  v_allocated_tradein numeric := 0;
  v_allocated_discount numeric := 0;
  v_taxable_returned numeric := 0;
  v_full_return boolean := false;
  v_returned_ratio numeric := 0;
  v_points_reverse integer := 0;
  v_points_restore integer := 0;
  v_credit_due numeric := 0;
  v_credit_reduction numeric := 0;
  v_line jsonb;
  v_sale_item public.sale_items%rowtype;
  v_qty numeric;
  v_prior numeric;
  v_available numeric;
  v_amount numeric;
  v_unit_ids uuid[];
  v_id uuid;
  v_remaining numeric;
  v_remaining_lines integer := 0;
  v_total_lines integer := 0;
  v_branch_id uuid;
  v_active_branches integer := 1;
  v_branch_qty numeric;
  v_total_qty numeric;
  v_product public.products%rowtype;
  v_tradein_products uuid[] := '{}'::uuid[];
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if p_shop_id is null or p_return_id is null or p_sale_id is null then raise exception 'Missing return identifiers'; end if;
  if p_mode not in ('refund','replace') then raise exception 'Invalid return mode'; end if;
  
if jsonb_typeof(coalesce(p_lines,'[]'::jsonb)) <> 'array' or jsonb_array_length(p_lines)=0 then raise exception 'Return lines are required'; end if;
if exists (
  select 1
  from (
    select value->>'sale_item_id' as sale_item_id, count(*) as cnt
    from jsonb_array_elements(p_lines)
    group by value->>'sale_item_id'
    having count(*) > 1
  ) dup
) then
  raise exception 'Duplicate sale item ids are not allowed in one return request';
end if;

  select role into v_role from public.shop_memberships where shop_id=p_shop_id and user_id=v_uid and active=true limit 1;
  if v_role is null or v_role not in ('admin','manager','cashier') then raise exception 'Active shop membership required'; end if;

  if exists (
    select 1
    from (
      select value->>'sale_item_id' as sale_item_id, count(*) as cnt
      from jsonb_array_elements(p_lines) value
      group by value->>'sale_item_id'
      having count(*) > 1
    ) duplicate_lines
  ) then
    raise exception 'A sale item can appear only once in a return request';
  end if;

  if exists (
    select 1
    from (
      select unit_id, count(*) as cnt
      from (
        select jsonb_array_elements_text(coalesce(value->'unit_ids','[]'::jsonb)) as unit_id
        from jsonb_array_elements(p_lines) value
      ) requested_units
      group by unit_id
      having count(*) > 1
    ) duplicate_units
  ) then
    raise exception 'The same IMEI/serial unit cannot be returned twice';
  end if;

  select * into v_sale from public.sales where id=p_sale_id and shop_id=p_shop_id for update;
  if not found then raise exception 'Sale not found'; end if;
  v_branch_id := coalesce(v_sale.branch_id,(select b.id from public.branches b where b.shop_id=p_shop_id and b.is_default limit 1));
  if v_branch_id is null then raise exception 'Sale branch is not configured'; end if;
  select count(*) into v_active_branches from public.branches b where b.shop_id=p_shop_id and b.active;
  select * into v_existing from public.sale_returns where id=p_return_id and shop_id=p_shop_id;
  if found then
    if v_existing.sale_id<>p_sale_id then raise exception 'Return id already belongs to another sale'; end if;
    return jsonb_build_object('ok',true,'already_committed',true,'return_id',v_existing.id,'return_no',v_existing.return_no,'refund_amount',v_existing.refund_amount,'additional_payment',v_existing.additional_payment);
  end if;
  if v_sale.status not in ('completed','exchanged') then raise exception 'Sale is not eligible for return'; end if;
  select coalesce(array_agg(distinct iu.product_id),'{}'::uuid[]) into v_tradein_products
  from public.inventory_units iu where iu.shop_id=p_shop_id and iu.sale_id=v_sale.id and iu.status='in_stock' and iu.note='Trade-in';
  select coalesce(sum(iu.cost),0) into v_tradein_total
  from public.inventory_units iu where iu.shop_id=p_shop_id and iu.sale_id=v_sale.id and iu.status='in_stock' and iu.note='Trade-in';
  select count(*) into v_total_lines from public.sale_items where sale_id=v_sale.id;
  if v_total_lines=0 then raise exception 'Sale has no items'; end if;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_id:=(v_line->>'sale_item_id')::uuid; v_qty:=(v_line->>'qty')::numeric;
    if v_qty is null or v_qty<=0 then raise exception 'Invalid return quantity'; end if;
    select * into v_sale_item from public.sale_items where id=v_id and sale_id=v_sale.id for update;
    if not found then raise exception 'Sale item not found'; end if;
    select coalesce(sum(ri.qty),0) into v_prior from public.sale_return_items ri join public.sale_returns r on r.id=ri.return_id where ri.sale_item_id=v_id and r.shop_id=p_shop_id;
    v_available:=v_sale_item.qty-v_prior;
    if v_qty>v_available then raise exception 'Return quantity exceeds remaining quantity'; end if;
    v_amount:=greatest(0,round((v_sale_item.price*v_qty-coalesce(v_sale_item.discount,0)*(v_qty/nullif(v_sale_item.qty,0)))::numeric,2));
    v_returned_merch:=v_returned_merch+v_amount;
    if coalesce(array_length(v_sale_item.unit_ids,1),0)>0 then
      if coalesce(jsonb_array_length(v_line->'unit_ids'),0)<>v_qty::integer then raise exception 'Tracked return requires exact unit ids'; end if;
      v_unit_ids:=array(select x::uuid from jsonb_array_elements_text(v_line->'unit_ids') x);
      if cardinality(v_unit_ids) <> (select count(distinct u) from unnest(v_unit_ids) u) then raise exception 'Duplicate tracked unit ids are not allowed'; end if;
      foreach v_id in array v_unit_ids loop
        perform 1 from public.inventory_units where id=v_id and shop_id=p_shop_id and product_id=v_sale_item.product_id and status='sold' and sale_id=v_sale.id for update;
        if not found then raise exception 'Tracked unit is not currently sold on this sale'; end if;
      end loop;
    elsif coalesce(jsonb_array_length(v_line->'unit_ids'),0)<>0 then raise exception 'Untracked sale item cannot return tracked unit ids'; end if;
  end loop;
  v_sale_subtotal:=greatest(0,coalesce(v_sale.subtotal,0));
  v_sale_discount:=least(greatest(0,coalesce(v_sale.discount,0)),v_sale_subtotal);
  v_post_discount:=greatest(0,v_sale_subtotal-v_sale_discount);
  v_allocated_discount:=least(v_sale_discount,v_returned_merch*case when v_sale_subtotal>0 then v_sale_discount/v_sale_subtotal else 0 end);
  v_taxable_returned:=greatest(0,v_returned_merch-v_allocated_discount);
  v_tax_refund:=case when v_post_discount>0 then round(coalesce(v_sale.tax,0)*(v_taxable_returned/v_post_discount),2) else 0 end;
  select count(*) into v_remaining_lines from public.sale_items si where si.sale_id=v_sale.id and (si.qty-(select coalesce(sum(ri.qty),0) from public.sale_return_items ri join public.sale_returns r on r.id=ri.return_id where ri.sale_item_id=si.id and r.shop_id=p_shop_id))>0;
  select count(*) into v_remaining_lines
  from public.sale_items si
  where si.sale_id=v_sale.id
    and greatest(0,si.qty-(select coalesce(sum(ri.qty),0) from public.sale_return_items ri join public.sale_returns r on r.id=ri.return_id where ri.sale_item_id=si.id and r.shop_id=p_shop_id)) >
        coalesce((select sum((pl.value->>'qty')::numeric) from jsonb_array_elements(p_lines) pl where (pl.value->>'sale_item_id')::uuid=si.id),0);
  v_full_return:=v_remaining_lines=0;
  if v_full_return then v_shipping_refund:=greatest(0,coalesce(v_sale.shipping,0)); end if;
  v_allocated_tradein:=case when v_sale_subtotal>0 then least(v_tradein_total, v_tradein_total*(v_returned_merch/v_sale_subtotal)) else 0 end;
  v_refund:=greatest(0,round((v_taxable_returned+v_tax_refund+v_shipping_refund-v_allocated_tradein)::numeric,2));
  if p_mode='replace' then v_refund:=0; v_additional:=0; end if;
  select coalesce(exchange,0)+1 into v_remaining from public.counters where shop_id=p_shop_id for update;
  insert into public.counters(shop_id,exchange) values(p_shop_id,coalesce(v_remaining,1)::integer) on conflict(shop_id) do update set exchange=excluded.exchange;
  update public.counters set exchange=greatest(exchange,coalesce(v_remaining,1)::integer) where shop_id=p_shop_id;
  v_return_no:='EX-'||lpad(coalesce(v_remaining,1)::integer::text,4,'0');
  insert into public.sale_returns(id,shop_id,sale_id,return_no,mode,reason,refund_amount,additional_payment,payment_method,created_by)
  values(p_return_id,p_shop_id,p_sale_id,v_return_no,p_mode,left(coalesce(p_reason,''),500),v_refund,v_additional,p_payment_method,v_uid);
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_id:=(v_line->>'sale_item_id')::uuid; v_qty:=(v_line->>'qty')::numeric;
    select * into v_sale_item from public.sale_items where id=v_id and sale_id=v_sale.id;
    v_amount:=greatest(0,round((v_sale_item.price*v_qty-coalesce(v_sale_item.discount,0)*(v_qty/nullif(v_sale_item.qty,0)))::numeric,2));
    v_unit_ids:=case when coalesce(jsonb_array_length(v_line->'unit_ids'),0)>0 then array(select x::uuid from jsonb_array_elements_text(v_line->'unit_ids') x) else '{}'::uuid[] end;
    insert into public.sale_return_items(return_id,sale_item_id,product_id,qty,amount,unit_ids) values(p_return_id,v_id,v_sale_item.product_id,v_qty,v_amount,v_unit_ids);
    update public.products set stock=stock+v_qty,updated_at=now() where id=v_sale_item.product_id and shop_id=p_shop_id;
    foreach v_id in array v_unit_ids loop update public.inventory_units set status='in_stock',sale_id=null,sale_bill_no=null,sold_at=null,branch_id=v_branch_id where id=v_id and shop_id=p_shop_id; end loop;
    select * into v_product from public.products p where p.id=v_sale_item.product_id and p.shop_id=p_shop_id;
    if coalesce(v_product.track_imei,false) or coalesce(v_product.track_serial,false) then
      select count(*)::numeric into v_branch_qty from public.inventory_units iu where iu.shop_id=p_shop_id and iu.product_id=v_sale_item.product_id and iu.branch_id=v_branch_id and iu.status='in_stock';
      insert into public.branch_stock(shop_id,branch_id,product_id,qty,updated_at) values(p_shop_id,v_branch_id,v_sale_item.product_id,v_branch_qty,now()) on conflict(branch_id,product_id) do update set qty=excluded.qty,updated_at=now();
    elsif v_active_branches>1 then
      insert into public.branch_stock(shop_id,branch_id,product_id,qty,updated_at) values(p_shop_id,v_branch_id,v_sale_item.product_id,v_qty,now()) on conflict(branch_id,product_id) do update set qty=public.branch_stock.qty+excluded.qty,updated_at=now();
    else
      select p.stock into v_branch_qty from public.products p where p.id=v_sale_item.product_id and p.shop_id=p_shop_id;
      insert into public.branch_stock(shop_id,branch_id,product_id,qty,updated_at) values(p_shop_id,v_branch_id,v_sale_item.product_id,v_branch_qty,now()) on conflict(branch_id,product_id) do update set qty=excluded.qty,updated_at=now();
    end if;
    select coalesce(sum(bs.qty),0) into v_total_qty from public.branch_stock bs where bs.shop_id=p_shop_id and bs.product_id=v_sale_item.product_id;
    update public.products set stock=v_total_qty,updated_at=now() where id=v_sale_item.product_id and shop_id=p_shop_id;
  end loop;
  if v_full_return then
    update public.products p
       set stock=greatest(0,p.stock-tradeins.qty),updated_at=now()
      from (
        select iu.product_id,count(*)::numeric as qty
        from public.inventory_units iu
        where iu.shop_id=p_shop_id and iu.sale_id=v_sale.id and iu.status='in_stock' and iu.note='Trade-in'
        group by iu.product_id
      ) tradeins
     where p.shop_id=p_shop_id and p.id=tradeins.product_id;
    update public.inventory_units set status='returned',sale_id=null,sale_bill_no=null,sold_at=null where shop_id=p_shop_id and sale_id=v_sale.id and status='in_stock' and note='Trade-in';
    foreach v_id in array v_tradein_products loop
      select count(*)::numeric into v_branch_qty from public.inventory_units iu where iu.shop_id=p_shop_id and iu.product_id=v_id and iu.branch_id=v_branch_id and iu.status='in_stock';
      insert into public.branch_stock(shop_id,branch_id,product_id,qty,updated_at) values(p_shop_id,v_branch_id,v_id,v_branch_qty,now()) on conflict(branch_id,product_id) do update set qty=excluded.qty,updated_at=now();
      select coalesce(sum(bs.qty),0) into v_total_qty from public.branch_stock bs where bs.shop_id=p_shop_id and bs.product_id=v_id;
      update public.products set stock=v_total_qty,updated_at=now() where id=v_id and shop_id=p_shop_id;
    end loop;
  end if;
  if v_sale.customer_id is not null then
    v_credit_due:=greatest(0,coalesce(v_sale.total,0)-coalesce(v_sale.amount_paid,0));
    v_credit_reduction:=least(v_credit_due,v_refund);
    v_returned_ratio:=case when p_mode='replace' then case when coalesce(v_sale.total,0)>0 then least(1, greatest(0,round(v_taxable_returned+v_tax_refund,2))/v_sale.total) else 1 end else case when coalesce(v_sale.total,0)>0 then least(1,v_refund/v_sale.total) else 1 end end;
    v_points_reverse:=least(coalesce(v_sale.points_earned,0),round(coalesce(v_sale.points_earned,0)*v_returned_ratio));
    v_points_restore:=least(coalesce(v_sale.points_redeemed,0),round(coalesce(v_sale.points_redeemed,0)*v_returned_ratio));
    update public.customers set credit_balance=greatest(0,coalesce(credit_balance,0)-v_credit_reduction),loyalty_points=greatest(0,coalesce(loyalty_points,0)-v_points_reverse+v_points_restore),updated_at=now() where id=v_sale.customer_id and shop_id=p_shop_id;
  end if;
  select count(*) into v_remaining_lines from public.sale_items si where si.sale_id=v_sale.id and (si.qty-(select coalesce(sum(ri.qty),0) from public.sale_return_items ri join public.sale_returns r on r.id=ri.return_id where ri.sale_item_id=si.id and r.shop_id=p_shop_id))>0;
  update public.sales set status=case when v_remaining_lines=0 then 'refunded'::public.sale_status else 'completed'::public.sale_status end where id=v_sale.id;
  insert into public.audit_log(shop_id,user_id,user_email,action,entity,details) select p_shop_id,v_uid,u.email,'REFUND','Sale','Return '||v_return_no||' · bill '||v_sale.bill_no||' · Rs. '||v_refund from auth.users u where u.id=v_uid;
  return jsonb_build_object('ok',true,'already_committed',false,'return_id',p_return_id,'return_no',v_return_no,'refund_amount',v_refund,'additional_payment',v_additional,'sale_id',v_sale.id);
end;
$function$
;

CREATE OR REPLACE FUNCTION private.process_purchase_return_atomic(p_shop_id uuid, p_return_id uuid, p_purchase_id uuid, p_device_id text, p_reason text, p_purchase jsonb, p_lines jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_purchase public.purchases%rowtype;
  v_existing public.purchase_returns%rowtype;
  v_line jsonb;
  v_item_idx integer;
  v_product_id uuid;
  v_qty numeric;
  v_cost numeric;
  v_unit_ids uuid[];
  v_unit_id uuid;
  v_product public.products%rowtype;
  v_total numeric := 0;
  v_return_item_id uuid;
  v_dn_seq bigint;
  v_dn_no text;
  v_email text;
  v_available numeric;
  v_returned numeric;
  v_item_returned numeric;
  v_source_qty numeric;
  v_tracked boolean;
  v_branch_id uuid;
  v_active_branches integer := 1;
  v_device_branch uuid;
  v_expected_branch_qty numeric;
  v_total_qty numeric;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if p_shop_id is null or p_return_id is null or p_purchase_id is null then
    raise exception 'Missing supplier return identifiers';
  end if;
  if p_purchase is null or jsonb_typeof(p_purchase) <> 'object'
     or jsonb_typeof(coalesce(p_purchase->'items','[]'::jsonb)) <> 'array' then
    raise exception 'Invalid GRN payload';
  end if;
  if length(btrim(coalesce(p_device_id,''))) = 0 or length(p_device_id) > 200 then
    raise exception 'Invalid device id';
  end if;
  if length(btrim(coalesce(p_reason,''))) = 0 or length(p_reason) > 500 then
    raise exception 'Return reason is required';
  end if;
  if jsonb_typeof(coalesce(p_lines,'[]'::jsonb)) <> 'array' or jsonb_array_length(p_lines)=0 then
    raise exception 'Return lines are required';
  end if;

  if not exists (
    select 1 from public.shop_memberships m
    where m.shop_id=p_shop_id and m.user_id=v_uid and m.active=true
      and m.role in ('admin','manager','inventory_manager')
  ) then
    raise exception 'User is not authorized to create supplier returns';
  end if;

  if not exists (
    select 1 from public.pos_devices d
    where d.shop_id=p_shop_id::text and d.device_id=btrim(p_device_id)
      and d.user_id=v_uid and d.revoked_at is null
  ) then
    raise exception 'POS device is not registered to this user for this shop';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('purchase-return:'||p_shop_id::text, 0));

  select * into v_purchase
  from public.purchases
  where id=p_purchase_id and shop_id=p_shop_id
  for update;
  if not found then raise exception 'GRN not found'; end if;
  v_branch_id := coalesce(v_purchase.branch_id,(select b.id from public.branches b where b.shop_id=p_shop_id and b.is_default limit 1));
  if v_branch_id is null then raise exception 'GRN branch is not configured'; end if;
  select count(*) into v_active_branches from public.branches b where b.shop_id=p_shop_id and b.active;
  if v_active_branches>1 then
    select d.branch_id into v_device_branch from public.pos_device_branches d where d.shop_id=p_shop_id and d.device_id=btrim(p_device_id) limit 1;
    if v_device_branch is null or v_device_branch<>v_branch_id then raise exception 'This POS device is not assigned to the GRN branch'; end if;
  end if;
  if v_purchase.status <> 'received' then raise exception 'GRN must be processed before a supplier return'; end if;

  select * into v_existing
  from public.purchase_returns
  where id=p_return_id and shop_id=p_shop_id;
  if found then
    if v_existing.purchase_id <> p_purchase_id then
      raise exception 'Return id already belongs to another GRN';
    end if;
    return jsonb_build_object(
      'ok',true,'already_committed',true,'return_id',v_existing.id,
      'return_no',v_existing.dn_no,'total',v_existing.total,'purchase_id',v_existing.purchase_id
    );
  end if;

  if exists (
    select 1
    from (
      select (x->>'product_id')::uuid as product_id, (x->>'cost')::numeric as cost, count(*) as n
      from jsonb_array_elements(p_lines) x
      group by (x->>'product_id')::uuid, (x->>'cost')::numeric
      having count(*) > 1
    ) d
  ) then
    raise exception 'Duplicate product/cost lines are not allowed in one supplier return';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_item_idx := (v_line->>'item_idx')::integer;
    v_product_id := (v_line->>'product_id')::uuid;
    v_qty := (v_line->>'qty')::numeric;
    v_cost := (v_line->>'cost')::numeric;

    if v_item_idx < 0 or v_item_idx >= jsonb_array_length(coalesce(p_purchase->'items','[]'::jsonb)) then
      raise exception 'Return item index is outside the source GRN';
    end if;

    v_source_qty := (p_purchase->'items'->v_item_idx->>'qty')::numeric;
    if (p_purchase->'items'->v_item_idx->>'productId')::uuid <> v_product_id
       or (p_purchase->'items'->v_item_idx->>'cost')::numeric <> v_cost then
      raise exception 'Supplier return line does not match the selected GRN item';
    end if;
    if v_source_qty is null or v_source_qty <= 0 or v_source_qty <> trunc(v_source_qty) then
      raise exception 'Invalid source GRN quantity';
    end if;
    if v_qty <= 0 or v_qty <> trunc(v_qty) then raise exception 'Return quantity must be a positive whole number'; end if;
    if v_cost < 0 or v_cost <> v_cost then raise exception 'Invalid return cost'; end if;

    select coalesce(sum(pri.qty),0)
      into v_item_returned
    from public.purchase_return_items pri
    join public.purchase_returns pr on pr.id=pri.return_id
    where pr.shop_id=p_shop_id
      and pr.purchase_id=p_purchase_id
      and pri.item_idx=v_item_idx;

    if v_qty > greatest(0,v_source_qty-v_item_returned) then
      raise exception 'Supplier return quantity exceeds the remaining quantity for this GRN line';
    end if;

    select coalesce(sum(pi.qty_received),0)
      into v_available
    from public.purchase_items pi
    where pi.purchase_id=p_purchase_id
      and pi.product_id=v_product_id
      and pi.cost=v_cost;

    select coalesce(sum(pri.qty),0)
      into v_returned
    from public.purchase_return_items pri
    join public.purchase_returns pr on pr.id=pri.return_id
    where pr.shop_id=p_shop_id
      and pr.purchase_id=p_purchase_id
      and pri.product_id=v_product_id
      and pri.cost=v_cost;

    if v_qty > greatest(0,v_available-v_returned) then
      raise exception 'Supplier return quantity exceeds the remaining received quantity';
    end if;

    select * into v_product
    from public.products
    where id=v_product_id and shop_id=p_shop_id
    for update;
    if not found then raise exception 'Return product does not belong to this shop'; end if;
    if v_product.stock < v_qty then raise exception 'Insufficient stock for supplier return'; end if;

    v_tracked := coalesce(v_product.track_imei,false) or coalesce(v_product.track_serial,false);
    v_unit_ids := array(select x::uuid from jsonb_array_elements_text(coalesce(v_line->'unit_ids','[]'::jsonb)) x);

    if v_tracked then
      if cardinality(v_unit_ids) <> v_qty then raise exception 'Tracked supplier return must select exactly one unit per returned quantity'; end if;
      if cardinality(v_unit_ids) <> (select count(distinct x) from unnest(v_unit_ids) x) then raise exception 'Duplicate tracked unit ids are not allowed'; end if;

      foreach v_unit_id in array v_unit_ids loop
        perform 1 from public.inventory_units u
        where u.id=v_unit_id and u.shop_id=p_shop_id and u.product_id=v_product_id
          and u.purchase_id=p_purchase_id and u.status='in_stock'
        for update;
        if not found then raise exception 'Selected tracked unit is not available for this supplier return'; end if;
      end loop;
    elsif cardinality(v_unit_ids) > 0 then
      raise exception 'Non-tracked supplier return cannot contain unit ids';
    end if;
  end loop;

  select coalesce(max((regexp_match(dn_no,'^DN-([0-9]+)$'))[1]::bigint),0)+1
    into v_dn_seq
  from public.purchase_returns
  where shop_id=p_shop_id;
  v_dn_no := 'DN-'||lpad(v_dn_seq::text,4,'0');

  select u.email into v_email from auth.users u where u.id=v_uid;

  insert into public.purchase_returns(
    id,shop_id,purchase_id,dn_no,supplier_id,supplier_name,reason,total,returned_at,created_by,created_by_email,device_id
  )
  values(
    p_return_id,p_shop_id,p_purchase_id,v_dn_no,v_purchase.supplier_id,
    left(coalesce(v_purchase.supplier_name,''),200),left(btrim(p_reason),500),0,now(),v_uid,v_email,btrim(p_device_id)
  );

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_item_idx := (v_line->>'item_idx')::integer;
    v_product_id := (v_line->>'product_id')::uuid;
    v_qty := (v_line->>'qty')::numeric;
    v_cost := (v_line->>'cost')::numeric;
    v_total := v_total + v_qty*v_cost;

    insert into public.purchase_return_items(return_id,item_idx,product_id,name,qty,cost,total)
    values(
      p_return_id,v_item_idx,v_product_id,
      left(coalesce((select p.name from public.products p where p.id=v_product_id and p.shop_id=p_shop_id),''),200),
      v_qty,v_cost,v_qty*v_cost
    ) returning id into v_return_item_id;

    update public.products set stock=stock-v_qty,updated_at=now() where id=v_product_id and shop_id=p_shop_id;
    v_unit_ids := array(select x::uuid from jsonb_array_elements_text(coalesce(v_line->'unit_ids','[]'::jsonb)) x);
    foreach v_unit_id in array v_unit_ids loop
      update public.inventory_units set status='returned',sale_id=null,sale_bill_no=null,sold_at=null,note='Returned to supplier via '||v_dn_no
      where id=v_unit_id and shop_id=p_shop_id and status='in_stock';
      if not found then raise exception 'Tracked unit changed before supplier return was committed'; end if;
      insert into public.purchase_return_units(return_item_id,unit_id) values(v_return_item_id,v_unit_id);
    end loop;
    select * into v_product from public.products p where p.id=v_product_id and p.shop_id=p_shop_id;
    if coalesce(v_product.track_imei,false) or coalesce(v_product.track_serial,false) then
      select count(*)::numeric into v_expected_branch_qty from public.inventory_units iu where iu.shop_id=p_shop_id and iu.product_id=v_product_id and iu.branch_id=v_branch_id and iu.status='in_stock';
      insert into public.branch_stock(shop_id,branch_id,product_id,qty,updated_at) values(p_shop_id,v_branch_id,v_product_id,v_expected_branch_qty,now()) on conflict(branch_id,product_id) do update set qty=excluded.qty,updated_at=now();
    elsif v_active_branches>1 then
      update public.branch_stock set qty=qty-v_qty,updated_at=now() where shop_id=p_shop_id and branch_id=v_branch_id and product_id=v_product_id and qty>=v_qty;
      if not found then raise exception 'Insufficient branch stock for supplier return'; end if;
    else
      select p.stock into v_expected_branch_qty from public.products p where p.id=v_product_id and p.shop_id=p_shop_id;
      insert into public.branch_stock(shop_id,branch_id,product_id,qty,updated_at) values(p_shop_id,v_branch_id,v_product_id,v_expected_branch_qty,now()) on conflict(branch_id,product_id) do update set qty=excluded.qty,updated_at=now();
    end if;
    select coalesce(sum(bs.qty),0) into v_total_qty from public.branch_stock bs where bs.shop_id=p_shop_id and bs.product_id=v_product_id;
    update public.products set stock=v_total_qty,updated_at=now() where id=v_product_id and shop_id=p_shop_id;
  end loop;

  update public.purchase_returns set total=v_total where id=p_return_id;

  insert into public.audit_log(id,shop_id,user_id,user_email,action,entity,details)
  values(
    extensions.uuid_generate_v4(),p_shop_id,v_uid,coalesce(v_email,''),
    'PURCHASE-RETURN','Purchase',
    'Supplier return '||v_dn_no||' for GRN '||v_purchase.po_no||' · Rs.'||v_total::text
  );

  return jsonb_build_object(
    'ok',true,'already_committed',false,'return_id',p_return_id,
    'return_no',v_dn_no,'total',v_total,'purchase_id',p_purchase_id
  );
exception
  when unique_violation then
    raise exception 'Supplier return could not be committed because a duplicate debit note or tracked unit was detected';
end
$function$
;

CREATE OR REPLACE FUNCTION private.approve_sale_reversal(p_shop_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_req public.sale_reversal_requests%rowtype;
  v_sale public.sales%rowtype;
  v_balance_due numeric := 0;
  v_tradein_count numeric := 0;
  v_branch_id uuid;
  v_active_branches integer := 1;
  v_branch_qty numeric;
  v_total_qty numeric;
  v_sale_qty numeric;
  v_product_id uuid;
  v_product public.products%rowtype;
  v_product_ids uuid[] := '{}'::uuid[];
begin
  if v_uid is null then raise exception 'Authentication required'; end if;

  if not exists (
    select 1 from public.shop_memberships m
    where m.shop_id=p_shop_id and m.user_id=v_uid and m.active=true and m.role='admin'
  ) then
    raise exception 'Only an active shop admin can approve bill reversals';
  end if;

  select * into v_req
  from public.sale_reversal_requests
  where id=p_request_id and shop_id=p_shop_id
  for update;
  if not found then raise exception 'Reversal request not found'; end if;

  if v_req.status='approved' then
    return jsonb_build_object('ok',true,'already_committed',true,'request_id',v_req.id,'sale_id',v_req.sale_id);
  end if;
  if v_req.status<>'pending' then raise exception 'Reversal request is no longer pending'; end if;

  select * into v_sale
  from public.sales
  where id=v_req.sale_id and shop_id=p_shop_id
  for update;
  if not found then raise exception 'Sale not found'; end if;
  if v_sale.status<>'completed' then raise exception 'Sale is no longer eligible for reversal'; end if;
  v_branch_id := coalesce(v_sale.branch_id,(select b.id from public.branches b where b.shop_id=p_shop_id and b.is_default limit 1));
  if v_branch_id is null then raise exception 'Sale branch is not configured'; end if;
  select count(*) into v_active_branches from public.branches b where b.shop_id=p_shop_id and b.active;
  select coalesce(array_agg(product_id),'{}'::uuid[]) into v_product_ids from (select distinct si.product_id from public.sale_items si where si.sale_id=v_sale.id union select distinct iu.product_id from public.inventory_units iu where iu.shop_id=p_shop_id and iu.sale_id=v_sale.id and iu.status='in_stock' and iu.note='Trade-in') affected;

  if exists (
    select 1 from public.sale_returns r
    where r.shop_id=p_shop_id and r.sale_id=v_sale.id
  ) then
    raise exception 'A sale return already exists for this bill';
  end if;

  update public.products p
     set stock=p.stock+src.qty, updated_at=now()
    from (
      select si.product_id,sum(si.qty)::numeric qty
      from public.sale_items si
      where si.sale_id=v_sale.id
      group by si.product_id
    ) src
   where p.id=src.product_id and p.shop_id=p_shop_id;

  update public.inventory_units set status='in_stock',sale_id=null,sale_bill_no=null,sold_at=null,branch_id=v_branch_id where shop_id=p_shop_id and sale_id=v_sale.id and status='sold';

  select count(*)::numeric into v_tradein_count
  from public.inventory_units
  where shop_id=p_shop_id and sale_id=v_sale.id and status='in_stock' and note='Trade-in';

  update public.products p
     set stock=greatest(0,p.stock-src.qty),updated_at=now()
    from (
      select iu.product_id,count(*)::numeric qty
      from public.inventory_units iu
      where iu.shop_id=p_shop_id and iu.sale_id=v_sale.id and iu.status='in_stock' and iu.note='Trade-in'
      group by iu.product_id
    ) src
   where p.id=src.product_id and p.shop_id=p_shop_id;

  update public.inventory_units set status='returned',sale_id=null,sale_bill_no=null,sold_at=null where shop_id=p_shop_id and sale_id=v_sale.id and status='in_stock' and note='Trade-in';

  foreach v_product_id in array v_product_ids loop
    select * into v_product from public.products p where p.id=v_product_id and p.shop_id=p_shop_id;
    if coalesce(v_product.track_imei,false) or coalesce(v_product.track_serial,false) then
      select count(*)::numeric into v_branch_qty from public.inventory_units iu where iu.shop_id=p_shop_id and iu.product_id=v_product_id and iu.branch_id=v_branch_id and iu.status='in_stock';
      insert into public.branch_stock(shop_id,branch_id,product_id,qty,updated_at) values(p_shop_id,v_branch_id,v_product_id,v_branch_qty,now()) on conflict(branch_id,product_id) do update set qty=excluded.qty,updated_at=now();
    elsif v_active_branches>1 then
      select coalesce(sum(si.qty),0) into v_sale_qty from public.sale_items si where si.sale_id=v_sale.id and si.product_id=v_product_id;
      insert into public.branch_stock(shop_id,branch_id,product_id,qty,updated_at) values(p_shop_id,v_branch_id,v_product_id,v_sale_qty,now()) on conflict(branch_id,product_id) do update set qty=public.branch_stock.qty+excluded.qty,updated_at=now();
    else
      select p.stock into v_branch_qty from public.products p where p.id=v_product_id and p.shop_id=p_shop_id;
      insert into public.branch_stock(shop_id,branch_id,product_id,qty,updated_at) values(p_shop_id,v_branch_id,v_product_id,v_branch_qty,now()) on conflict(branch_id,product_id) do update set qty=excluded.qty,updated_at=now();
    end if;
    select coalesce(sum(bs.qty),0) into v_total_qty from public.branch_stock bs where bs.shop_id=p_shop_id and bs.product_id=v_product_id;
    update public.products set stock=v_total_qty,updated_at=now() where id=v_product_id and shop_id=p_shop_id;
  end loop;

  v_balance_due:=greatest(0,coalesce(v_sale.total,0)-coalesce(v_sale.amount_paid,0));

  if v_sale.customer_id is not null then
    update public.customers
       set credit_balance=greatest(0,coalesce(credit_balance,0)-v_balance_due),
           loyalty_points=greatest(0,coalesce(loyalty_points,0)-coalesce(v_sale.points_earned,0)+coalesce(v_sale.points_redeemed,0)),
           updated_at=now()
     where id=v_sale.customer_id and shop_id=p_shop_id;
  end if;

  update public.sales
     set status='reversed'::public.sale_status
   where id=v_sale.id and shop_id=p_shop_id;

  update public.sale_reversal_requests
     set status='approved',reviewed_by=v_uid,reviewed_at=now()
   where id=v_req.id and shop_id=p_shop_id;

  insert into public.audit_log(
    id,shop_id,user_id,user_email,action,entity,details
  )
  select extensions.uuid_generate_v4(),p_shop_id,v_uid,u.email,
         'REVERSE-APPROVED','Sale',
         'Bill '||v_sale.bill_no||' reversed and stock restored · requested by '||v_req.requested_by::text
  from auth.users u where u.id=v_uid;

  return jsonb_build_object(
    'ok',true,'already_committed',false,'request_id',v_req.id,
    'sale_id',v_sale.id,'bill_no',v_sale.bill_no,'trade_in_units_returned',v_tradein_count
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION private.register_trade_in_atomic(p_shop_id uuid, p_sale_id uuid, p_unit_id uuid, p_product_id uuid, p_value numeric, p_imei text DEFAULT NULL::text, p_serial text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_product public.products%rowtype;
  v_sale public.sales%rowtype;
  v_branch_id uuid;
  v_branch_qty numeric;
  v_total_qty numeric;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  select role into v_role from public.shop_memberships
   where shop_id=p_shop_id and user_id=v_uid and active=true limit 1;
  if v_role is null or v_role not in ('admin','manager','cashier') then
    raise exception 'Active shop membership required';
  end if;
  if p_shop_id is null or p_sale_id is null or p_unit_id is null or p_product_id is null or p_value is null or p_value <= 0 then
    raise exception 'Invalid trade-in data';
  end if;
  select * into v_product from public.products
   where id=p_product_id and shop_id=p_shop_id and active=true for update;
  if not found then raise exception 'Trade-in product not found'; end if;
  if not v_product.track_imei and not v_product.track_serial then
    raise exception 'Trade-in product must track IMEI or serial';
  end if;
  if v_product.track_imei and nullif(trim(coalesce(p_imei,'')),'') is null then raise exception 'Trade-in IMEI required'; end if;
  if v_product.track_serial and nullif(trim(coalesce(p_serial,'')),'') is null then raise exception 'Trade-in serial required'; end if;
  if exists (select 1 from public.inventory_units where id=p_unit_id and shop_id=p_shop_id) then
    return jsonb_build_object('ok',true,'already_committed',true,'unit_id',p_unit_id);
  end if;
  if nullif(trim(coalesce(p_imei,'')),'') is not null and exists (
    select 1 from public.inventory_units where shop_id=p_shop_id and imei=trim(p_imei) and status='in_stock'
  ) then raise exception 'Trade-in IMEI already exists'; end if;
  if nullif(trim(coalesce(p_serial,'')),'') is not null and exists (
    select 1 from public.inventory_units where shop_id=p_shop_id and serial=trim(p_serial) and status='in_stock'
  ) then raise exception 'Trade-in serial already exists'; end if;
  select * into v_sale from public.sales where id=p_sale_id and shop_id=p_shop_id for update;
  if not found then raise exception 'Sale not found'; end if;
  v_branch_id := coalesce(v_sale.branch_id,(select b.id from public.branches b where b.shop_id=p_shop_id and b.is_default limit 1));
  if v_branch_id is null then raise exception 'Sale branch is not configured'; end if;
  insert into public.inventory_units(id,shop_id,product_id,imei,serial,status,cost,sale_id,note,created_at,branch_id)
  values(p_unit_id,p_shop_id,p_product_id,nullif(trim(p_imei),''),nullif(trim(p_serial),''),'in_stock',p_value,p_sale_id,'Trade-in',now(),v_branch_id);
  update public.products set stock=coalesce(stock,0)+1,updated_at=now() where id=p_product_id and shop_id=p_shop_id;
  select count(*)::numeric into v_branch_qty from public.inventory_units iu where iu.shop_id=p_shop_id and iu.product_id=p_product_id and iu.branch_id=v_branch_id and iu.status='in_stock';
  insert into public.branch_stock(shop_id,branch_id,product_id,qty,updated_at) values(p_shop_id,v_branch_id,p_product_id,v_branch_qty,now()) on conflict(branch_id,product_id) do update set qty=excluded.qty,updated_at=now();
  select coalesce(sum(bs.qty),0) into v_total_qty from public.branch_stock bs where bs.shop_id=p_shop_id and bs.product_id=p_product_id;
  update public.products set stock=v_total_qty,updated_at=now() where id=p_product_id and shop_id=p_shop_id;
  return jsonb_build_object('ok',true,'already_committed',false,'unit_id',p_unit_id);
end;
$function$

;
