-- Atomic sale return / refund persistence and RPC.
-- Kept in source control as the schema counterpart of the production migration.

create table if not exists public.sale_returns (
  id uuid primary key default uuid_generate_v4(),
  shop_id uuid not null references public.shops(id),
  sale_id uuid not null references public.sales(id),
  return_no text not null,
  mode text not null check (mode in ('refund','replace')),
  reason text not null default '',
  refund_amount numeric not null default 0 check (refund_amount >= 0),
  additional_payment numeric not null default 0 check (additional_payment >= 0),
  payment_method text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (shop_id, return_no)
);

create table if not exists public.sale_return_items (
  id uuid primary key default uuid_generate_v4(),
  return_id uuid not null references public.sale_returns(id),
  sale_item_id uuid not null references public.sale_items(id),
  product_id uuid not null references public.products(id),
  qty numeric not null check (qty > 0),
  amount numeric not null default 0 check (amount >= 0),
  unit_ids uuid[] not null default '{}'::uuid[]
);

alter table public.sale_returns enable row level security;
alter table public.sale_return_items enable row level security;
revoke all on table public.sale_returns from anon, authenticated;
revoke all on table public.sale_return_items from anon, authenticated;

drop function if exists public.process_sale_return_atomic(uuid,uuid,uuid,text,text,text,jsonb);
drop function if exists private.process_sale_return_atomic(uuid,uuid,uuid,text,text,text,jsonb);

-- The implementation is intentionally installed in private and exposed only through
-- the authenticated SECURITY INVOKER wrapper. The implementation validates the caller,
-- shop membership, return quantities, tracked units, and performs the return atomically.
create or replace function private.process_sale_return_atomic(p_shop_id uuid, p_return_id uuid, p_sale_id uuid, p_reason text, p_mode text, p_payment_method text, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  v_uid uuid := auth.uid(); v_role text; v_sale public.sales%rowtype; v_existing public.sale_returns%rowtype;
  v_return_no text; v_refund numeric := 0; v_additional numeric := 0; v_sale_subtotal numeric := 0;
  v_sale_discount numeric := 0; v_post_discount numeric := 0; v_tax_refund numeric := 0; v_shipping_refund numeric := 0;
  v_returned_merch numeric := 0; v_allocated_discount numeric := 0; v_taxable_returned numeric := 0;
  v_full_return boolean := false; v_returned_ratio numeric := 0; v_points_reverse integer := 0; v_points_restore integer := 0;
  v_credit_due numeric := 0; v_credit_reduction numeric := 0; v_line jsonb; v_sale_item public.sale_items%rowtype;
  v_qty numeric; v_prior numeric; v_available numeric; v_amount numeric; v_unit_ids uuid[]; v_id uuid;
  v_remaining numeric; v_remaining_lines integer := 0; v_total_lines integer := 0;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if p_shop_id is null or p_return_id is null or p_sale_id is null then raise exception 'Missing return identifiers'; end if;
  if p_mode not in ('refund','replace') then raise exception 'Invalid return mode'; end if;
  if jsonb_typeof(coalesce(p_lines,'[]'::jsonb)) <> 'array' or jsonb_array_length(p_lines)=0 then raise exception 'Return lines are required'; end if;
  select role into v_role from public.shop_memberships where shop_id=p_shop_id and user_id=v_uid and active=true limit 1;
  if v_role is null or v_role not in ('admin','manager','cashier') then raise exception 'Active shop membership required'; end if;
  select * into v_existing from public.sale_returns where id=p_return_id and shop_id=p_shop_id;
  if found then
    if v_existing.sale_id <> p_sale_id then raise exception 'Return id already belongs to another sale'; end if;
    return jsonb_build_object('ok',true,'already_committed',true,'return_id',v_existing.id,'return_no',v_existing.return_no,'refund_amount',v_existing.refund_amount,'additional_payment',v_existing.additional_payment);
  end if;
  select * into v_sale from public.sales where id=p_sale_id and shop_id=p_shop_id for update;
  if not found then raise exception 'Sale not found'; end if;
  if v_sale.status not in ('completed','exchanged') then raise exception 'Sale is not eligible for return'; end if;
  select count(*) into v_total_lines from public.sale_items where sale_id=v_sale.id;
  if v_total_lines=0 then raise exception 'Sale has no items'; end if;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_id := (v_line->>'sale_item_id')::uuid; v_qty := (v_line->>'qty')::numeric;
    if v_qty is null or v_qty<=0 then raise exception 'Invalid return quantity'; end if;
    select * into v_sale_item from public.sale_items where id=v_id and sale_id=v_sale.id for update;
    if not found then raise exception 'Sale item not found'; end if;
    select coalesce(sum(ri.qty),0) into v_prior from public.sale_return_items ri join public.sale_returns r on r.id=ri.return_id where ri.sale_item_id=v_id and r.shop_id=p_shop_id;
    v_available := v_sale_item.qty-v_prior; if v_qty>v_available then raise exception 'Return quantity exceeds remaining quantity'; end if;
    v_amount := greatest(0,round((v_sale_item.price*v_qty-coalesce(v_sale_item.discount,0)*(v_qty/nullif(v_sale_item.qty,0)))::numeric,2)); v_returned_merch := v_returned_merch+v_amount;
    if coalesce(array_length(v_sale_item.unit_ids,1),0)>0 then
      if coalesce(jsonb_array_length(v_line->'unit_ids'),0)<>v_qty::integer then raise exception 'Tracked return requires exact unit ids'; end if;
      v_unit_ids := array(select x::uuid from jsonb_array_elements_text(v_line->'unit_ids') x);
      foreach v_id in array v_unit_ids loop
        perform 1 from public.inventory_units where id=v_id and shop_id=p_shop_id and product_id=v_sale_item.product_id and status='sold' and sale_id=v_sale.id for update;
        if not found then raise exception 'Tracked unit is not currently sold on this sale'; end if;
      end loop;
    elsif coalesce(jsonb_array_length(v_line->'unit_ids'),0)<>0 then raise exception 'Untracked sale item cannot return tracked unit ids'; end if;
  end loop;
  v_sale_subtotal:=greatest(0,coalesce(v_sale.subtotal,0)); v_sale_discount:=least(greatest(0,coalesce(v_sale.discount,0)),v_sale_subtotal);
  v_post_discount:=greatest(0,v_sale_subtotal-v_sale_discount);
  v_allocated_discount:=least(v_sale_discount,v_returned_merch*case when v_sale_subtotal>0 then v_sale_discount/v_sale_subtotal else 0 end);
  v_taxable_returned:=greatest(0,v_returned_merch-v_allocated_discount);
  v_tax_refund:=case when v_post_discount>0 then round(coalesce(v_sale.tax,0)*(v_taxable_returned/v_post_discount),2) else 0 end;
  select count(*) into v_remaining_lines from public.sale_items si where si.sale_id=v_sale.id and (si.qty-(select coalesce(sum(ri.qty),0) from public.sale_return_items ri join public.sale_returns r on r.id=ri.return_id where ri.sale_item_id=si.id and r.shop_id=p_shop_id))>0;
  v_full_return:=v_remaining_lines=0; if v_full_return then v_shipping_refund:=greatest(0,coalesce(v_sale.shipping,0)); end if;
  v_refund:=greatest(0,round((v_taxable_returned+v_tax_refund+v_shipping_refund)::numeric,2));
  if p_mode='replace' then v_refund:=0; v_additional:=0; end if;
  select coalesce(exchange,0)+1 into v_remaining from public.counters where shop_id=p_shop_id for update;
  insert into public.counters(shop_id,exchange) values(p_shop_id,coalesce(v_remaining,1)::integer) on conflict(shop_id) do update set exchange=excluded.exchange;
  update public.counters set exchange=greatest(exchange,coalesce(v_remaining,1)::integer) where shop_id=p_shop_id;
  v_return_no:='EX-'||lpad(coalesce(v_remaining,1)::integer::text,4,'0');
  insert into public.sale_returns(id,shop_id,sale_id,return_no,mode,reason,refund_amount,additional_payment,payment_method,created_by) values(p_return_id,p_shop_id,p_sale_id,v_return_no,p_mode,left(coalesce(p_reason,''),500),v_refund,v_additional,p_payment_method,v_uid);
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_id:=(v_line->>'sale_item_id')::uuid; v_qty:=(v_line->>'qty')::numeric;
    select * into v_sale_item from public.sale_items where id=v_id and sale_id=v_sale.id;
    v_amount:=greatest(0,round((v_sale_item.price*v_qty-coalesce(v_sale_item.discount,0)*(v_qty/nullif(v_sale_item.qty,0)))::numeric,2));
    v_unit_ids:=case when coalesce(jsonb_array_length(v_line->'unit_ids'),0)>0 then array(select x::uuid from jsonb_array_elements_text(v_line->'unit_ids') x) else '{}'::uuid[] end;
    insert into public.sale_return_items(return_id,sale_item_id,product_id,qty,amount,unit_ids) values(p_return_id,v_id,v_sale_item.product_id,v_qty,v_amount,v_unit_ids);
    update public.products set stock=stock+v_qty,updated_at=now() where id=v_sale_item.product_id and shop_id=p_shop_id;
    foreach v_id in array v_unit_ids loop update public.inventory_units set status='returned',sale_id=null,sale_bill_no=null,sold_at=null where id=v_id and shop_id=p_shop_id; end loop;
  end loop;
  if v_sale.customer_id is not null then
    v_credit_due:=greatest(0,coalesce(v_sale.total,0)-coalesce(v_sale.amount_paid,0)); v_credit_reduction:=least(v_credit_due,v_refund);
    v_returned_ratio:=case when coalesce(v_sale.total,0)>0 then least(1,v_refund/v_sale.total) else 1 end;
    v_points_reverse:=least(coalesce(v_sale.points_earned,0),round(coalesce(v_sale.points_earned,0)*v_returned_ratio));
    v_points_restore:=least(coalesce(v_sale.points_redeemed,0),round(coalesce(v_sale.points_redeemed,0)*v_returned_ratio));
    update public.customers set credit_balance=greatest(0,coalesce(credit_balance,0)-v_credit_reduction),loyalty_points=greatest(0,coalesce(loyalty_points,0)-v_points_reverse+v_points_restore),updated_at=now() where id=v_sale.customer_id and shop_id=p_shop_id;
  end if;
  select count(*) into v_remaining_lines from public.sale_items si where si.sale_id=v_sale.id and (si.qty-(select coalesce(sum(ri.qty),0) from public.sale_return_items ri join public.sale_returns r on r.id=ri.return_id where ri.sale_item_id=si.id and r.shop_id=p_shop_id))>0;
  update public.sales set status=case when v_remaining_lines=0 then 'refunded'::public.sale_status else 'completed'::public.sale_status end where id=v_sale.id;
  insert into public.audit_log(shop_id,user_id,user_email,action,entity,details) select p_shop_id,v_uid,u.email,'REFUND','Sale','Return '||v_return_no||' · bill '||v_sale.bill_no||' · Rs. '||v_refund from auth.users u where u.id=v_uid;
  return jsonb_build_object('ok',true,'already_committed',false,'return_id',p_return_id,'return_no',v_return_no,'refund_amount',v_refund,'additional_payment',v_additional,'sale_id',v_sale.id);
end;
$function$;

create or replace function public.process_sale_return_atomic(p_shop_id uuid,p_return_id uuid,p_sale_id uuid,p_reason text,p_mode text,p_payment_method text,p_lines jsonb)
returns jsonb language sql security invoker set search_path to '' as $wrapper$
  select private.process_sale_return_atomic($1,$2,$3,$4,$5,$6,$7)
$wrapper$;
revoke all on function public.process_sale_return_atomic(uuid,uuid,uuid,text,text,text,jsonb) from public,anon;
grant execute on function public.process_sale_return_atomic(uuid,uuid,uuid,text,text,text,jsonb) to authenticated;
revoke all on function private.process_sale_return_atomic(uuid,uuid,uuid,text,text,text,jsonb) from public,anon;
grant execute on function private.process_sale_return_atomic(uuid,uuid,uuid,text,text,text,jsonb) to authenticated;
