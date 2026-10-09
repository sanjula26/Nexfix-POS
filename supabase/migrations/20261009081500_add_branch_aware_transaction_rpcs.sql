-- Phase 2.2/2.3: branch-aware transactional RPCs.
-- Existing RPCs remain available for older desktop builds and single-branch compatibility.
-- New builds call these wrappers with an explicit branch_id.

create index if not exists branch_stock_shop_branch_idx on public.branch_stock(shop_id, branch_id);
create index if not exists branch_stock_shop_product_idx on public.branch_stock(shop_id, product_id);
create index if not exists stock_transfer_lines_transfer_idx on public.stock_transfer_lines(transfer_id);
create index if not exists stock_transfer_lines_shop_product_idx on public.stock_transfer_lines(shop_id, product_id);
create index if not exists stock_transfers_from_branch_idx on public.stock_transfers(shop_id, from_branch_id);
create index if not exists stock_transfers_to_branch_idx on public.stock_transfers(shop_id, to_branch_id);
create index if not exists stock_transfers_created_by_idx on public.stock_transfers(created_by);
create index if not exists stock_transfers_completed_by_idx on public.stock_transfers(completed_by);
alter table public.stock_transfer_lines add column if not exists unit_ids uuid[] not null default '{}'::uuid[];

create or replace function private.assign_default_branch_id()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare
  v_branch_shop uuid;
  v_requested text;
begin
  v_requested := nullif(current_setting('app.current_branch_id', true), '');
  if new.branch_id is null and v_requested is not null then
    begin
      new.branch_id := v_requested::uuid;
    exception when invalid_text_representation then
      raise exception 'Invalid selected branch id';
    end;
  end if;
  if new.branch_id is null then
    select b.id into new.branch_id from public.branches b
    where b.shop_id = new.shop_id and b.is_default and b.active limit 1;
  end if;
  if new.branch_id is null then raise exception 'Branch is required and this shop has no active default branch'; end if;
  select b.shop_id into v_branch_shop from public.branches b
  where b.id = new.branch_id and b.active;
  if v_branch_shop is null or v_branch_shop <> new.shop_id then
    raise exception 'Selected branch does not belong to this shop or is inactive';
  end if;
  return new;
end;
$function$;
revoke all on function private.assign_default_branch_id() from public, anon, authenticated;

create or replace function public.complete_sale_atomic_for_branch(
  p_shop_id uuid,
  p_branch_id uuid,
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
as $function$
declare
  v_result jsonb;
  v_before jsonb;
  v_delta record;
  v_active_branch_count integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_shop_id is null or p_branch_id is null or p_sale_id is null then
    raise exception 'Shop, selected branch and sale id are required';
  end if;
  if not exists (
    select 1 from public.shop_memberships m
    where m.shop_id = p_shop_id and m.user_id = auth.uid() and m.active
      and m.role in ('admin','manager','cashier')
  ) then raise exception 'User is not authorized to complete sales for this shop'; end if;
  if not exists (select 1 from public.branches b where b.id=p_branch_id and b.shop_id=p_shop_id and b.active) then
    raise exception 'Selected branch is unavailable for this shop';
  end if;

  -- Tracked units are branch-owned; fail before any stock or invoice mutation.
  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_lines,'[]'::jsonb)) l
    cross join lateral jsonb_array_elements_text(coalesce(l.value->'unit_ids','[]'::jsonb)) u(unit_id)
    left join public.inventory_units iu
      on iu.id = u.unit_id::uuid and iu.shop_id=p_shop_id
    where iu.id is null or iu.branch_id <> p_branch_id or iu.status <> 'in_stock'
  ) then raise exception 'Selected IMEI/serial belongs to another branch or is not in stock'; end if;

  -- Capture only affected stock rows (direct products and kit components).
  select coalesce(jsonb_object_agg(p.id::text, p.stock), '{}'::jsonb)
  into v_before
  from public.products p
  where p.shop_id=p_shop_id and p.id in (
    select (l.value->>'product_id')::uuid from jsonb_array_elements(coalesce(p_lines,'[]'::jsonb)) l
    union
    select ki.component_product_id
    from jsonb_array_elements(coalesce(p_lines,'[]'::jsonb)) l
    join public.products kp on kp.id=(l.value->>'product_id')::uuid and kp.shop_id=p_shop_id and kp.is_kit
    join public.kit_items ki on ki.kit_product_id=kp.id and ki.qty>0
  );

  perform set_config('app.current_branch_id', p_branch_id::text, true);
  v_result := public.complete_sale_atomic(
    p_shop_id,p_sale_id,p_customer_id,p_shipping,p_discount,p_tax_pct,
    p_points_redeemed,p_note,p_salesman_id,p_lines,p_payments
  );
  if coalesce((v_result->>'ok')::boolean,false) is not true then return v_result; end if;
  if coalesce((v_result->>'already_committed')::boolean,false) then return v_result; end if;

  select count(*) into v_active_branch_count from public.branches b where b.shop_id=p_shop_id and b.active;
  if v_active_branch_count > 1 then
    for v_delta in
      select p.id as product_id, (v_before->>p.id::text)::numeric - p.stock as qty_delta
      from public.products p
      where p.shop_id=p_shop_id and v_before ? p.id::text
    loop
      if v_delta.qty_delta > 0 then
        update public.branch_stock bs
        set qty=bs.qty-v_delta.qty_delta, updated_at=now()
        where bs.shop_id=p_shop_id and bs.branch_id=p_branch_id and bs.product_id=v_delta.product_id
          and bs.qty >= v_delta.qty_delta;
        if not found then raise exception 'Insufficient stock in selected branch for product %', v_delta.product_id; end if;
      end if;
    end loop;
  end if;

  return v_result || jsonb_build_object(
    'sale', (select to_jsonb(s) from public.sales s where s.id=p_sale_id and s.shop_id=p_shop_id),
    'products', coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from public.products p
      where p.shop_id=p_shop_id and p.id in (select si.product_id from public.sale_items si where si.sale_id=p_sale_id)), '[]'::jsonb),
    'units', coalesce((select jsonb_agg(to_jsonb(iu) order by iu.id) from public.inventory_units iu
      where iu.shop_id=p_shop_id and iu.sale_id=p_sale_id), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.complete_sale_atomic_for_branch(uuid,uuid,uuid,uuid,numeric,numeric,numeric,integer,text,uuid,jsonb,jsonb) from public, anon;
grant execute on function public.complete_sale_atomic_for_branch(uuid,uuid,uuid,uuid,numeric,numeric,numeric,integer,text,uuid,jsonb,jsonb) to authenticated;

create or replace function public.receive_purchase_atomic_for_branch(
  p_shop_id uuid, p_branch_id uuid, p_purchase_id uuid, p_device_id text, p_purchase jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_existing_status text;
  v_before jsonb;
  v_result jsonb;
  v_item record;
  v_branch_count integer;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if p_shop_id is null or p_branch_id is null or p_purchase_id is null then raise exception 'Shop, branch and GRN id are required'; end if;
  if not exists (
    select 1 from public.shop_memberships m where m.shop_id=p_shop_id and m.user_id=v_uid and m.active
      and m.role in ('admin','manager','inventory_manager')
  ) then raise exception 'User is not authorized to receive GRNs'; end if;
  if not exists (select 1 from public.branches b where b.id=p_branch_id and b.shop_id=p_shop_id and b.active) then
    raise exception 'Selected branch is unavailable for this shop';
  end if;
  if not exists (
    select 1 from public.pos_devices d where d.shop_id=p_shop_id::text and d.device_id=btrim(p_device_id)
      and d.user_id=v_uid and d.revoked_at is null
  ) then raise exception 'POS device is not registered to this user for this shop'; end if;

  select p.status into v_existing_status from public.purchases p
  where p.id=p_purchase_id and p.shop_id=p_shop_id for update;
  if v_existing_status='received' then
    return public.receive_purchase_atomic(p_shop_id,p_purchase_id,p_device_id,p_purchase);
  end if;

  select coalesce(jsonb_object_agg(p.id::text,p.stock), '{}'::jsonb) into v_before
  from public.products p
  where p.shop_id=p_shop_id and p.id in (
    select (i.value->>'productId')::uuid from jsonb_array_elements(coalesce(p_purchase->'items','[]'::jsonb)) i
  );

  perform set_config('app.current_branch_id',p_branch_id::text,true);
  update public.purchases set branch_id=p_branch_id where id=p_purchase_id and shop_id=p_shop_id;
  v_result := public.receive_purchase_atomic(p_shop_id,p_purchase_id,p_device_id,p_purchase);
  if coalesce((v_result->>'ok')::boolean,false) is not true then return v_result; end if;
  if coalesce((v_result->>'already_committed')::boolean,false) then return v_result; end if;

  select count(*) into v_branch_count from public.branches b where b.shop_id=p_shop_id and b.active;
  if v_branch_count > 1 then
    for v_item in
      select p.id as product_id, p.stock-(v_before->>p.id::text)::numeric as qty_delta
      from public.products p where p.shop_id=p_shop_id and v_before ? p.id::text
    loop
      if v_item.qty_delta > 0 then
        insert into public.branch_stock(shop_id,branch_id,product_id,qty,updated_at)
        values (p_shop_id,p_branch_id,v_item.product_id,v_item.qty_delta,now())
        on conflict (branch_id,product_id) do update set qty=public.branch_stock.qty+excluded.qty,updated_at=now();
      end if;
    end loop;
  end if;
  return v_result;
end;
$function$;
revoke all on function public.receive_purchase_atomic_for_branch(uuid,uuid,uuid,text,jsonb) from public, anon;
grant execute on function public.receive_purchase_atomic_for_branch(uuid,uuid,uuid,text,jsonb) to authenticated;

create or replace function public.complete_stock_transfer(
  p_shop_id uuid, p_transfer_id uuid, p_from_branch_id uuid, p_to_branch_id uuid,
  p_lines jsonb, p_note text default null, p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_line jsonb;
  v_product_id uuid;
  v_qty numeric;
  v_units uuid[];
  v_product public.products%rowtype;
  v_transfer public.stock_transfers%rowtype;
  v_count integer := 0;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  select m.role into v_role from public.shop_memberships m
  where m.shop_id=p_shop_id and m.user_id=v_uid and m.active;
  if v_role is null or v_role not in ('admin','manager') then raise exception 'Stock transfer requires admin or manager permission'; end if;
  if p_shop_id is null or p_transfer_id is null or p_from_branch_id is null or p_to_branch_id is null
     or p_from_branch_id=p_to_branch_id then raise exception 'Valid source and destination branches are required'; end if;
  if not exists(select 1 from public.branches b where b.id=p_from_branch_id and b.shop_id=p_shop_id and b.active)
     or not exists(select 1 from public.branches b where b.id=p_to_branch_id and b.shop_id=p_shop_id and b.active) then
    raise exception 'Both transfer branches must be active branches in the same shop';
  end if;
  if jsonb_typeof(coalesce(p_lines,'[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_lines,'[]'::jsonb))=0 then
    raise exception 'At least one transfer line is required';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_transfer_id::text));
  select * into v_transfer from public.stock_transfers t where t.id=p_transfer_id and t.shop_id=p_shop_id for update;
  if found and v_transfer.status='completed' then
    return jsonb_build_object('ok',true,'already_committed',true,'transfer_id',p_transfer_id,'status','completed');
  end if;
  if found and v_transfer.status <> 'draft' then raise exception 'Only draft transfers can be completed'; end if;
  if not found then
    insert into public.stock_transfers(id,shop_id,from_branch_id,to_branch_id,status,note,created_by,idempotency_key)
    values(p_transfer_id,p_shop_id,p_from_branch_id,p_to_branch_id,'draft',left(coalesce(p_note,''),500),v_uid,p_idempotency_key)
    returning * into v_transfer;
  else
    if v_transfer.from_branch_id<>p_from_branch_id or v_transfer.to_branch_id<>p_to_branch_id then
      raise exception 'Transfer document branch mismatch';
    end if;
  end if;

  delete from public.stock_transfer_lines where transfer_id=p_transfer_id;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_product_id := nullif(v_line->>'product_id','')::uuid;
    v_qty := (v_line->>'qty')::numeric;
    v_units := coalesce(array(select value::uuid from jsonb_array_elements_text(coalesce(v_line->'unit_ids','[]'::jsonb))), '{}'::uuid[]);
    if v_product_id is null or v_qty<=0 or v_qty<>trunc(v_qty) then raise exception 'Transfer quantity must be a positive whole number'; end if;
    if cardinality(v_units) <> (select count(distinct x) from unnest(v_units) as x) then raise exception 'Duplicate IMEI/serial in transfer'; end if;
    select * into v_product from public.products p where p.id=v_product_id and p.shop_id=p_shop_id for update;
    if not found then raise exception 'Transfer product does not belong to this shop'; end if;
    if (coalesce(v_product.track_imei,false) or coalesce(v_product.track_serial,false)) and cardinality(v_units)<>v_qty then
      raise exception 'Tracked stock transfer requires one selected in-stock IMEI/serial per unit';
    end if;
    if not (coalesce(v_product.track_imei,false) or coalesce(v_product.track_serial,false)) and cardinality(v_units)>0 then
      raise exception 'IMEI/serial units were supplied for an untracked product';
    end if;
    if cardinality(v_units)>0 and exists(
      select 1 from unnest(v_units) as x(unit_id)
      left join public.inventory_units iu on iu.id=x.unit_id and iu.shop_id=p_shop_id and iu.product_id=v_product_id
      where iu.id is null or iu.branch_id<>p_from_branch_id or iu.status<>'in_stock'
    ) then raise exception 'One or more IMEI/serial units do not belong to the source branch'; end if;
    insert into public.stock_transfer_lines(transfer_id,shop_id,product_id,qty,unit_ids)
    values(p_transfer_id,p_shop_id,v_product_id,v_qty,v_units);
    v_count := v_count+1;
  end loop;

  -- Lock and validate all source rows before any mutation; transaction rollback is atomic.
  if exists(
    select 1 from (select l.product_id, sum(l.qty) as required_qty from public.stock_transfer_lines l where l.transfer_id=p_transfer_id group by l.product_id) l
    left join public.branch_stock bs on bs.shop_id=p_shop_id and bs.branch_id=p_from_branch_id and bs.product_id=l.product_id
    where coalesce(bs.qty,0)<l.required_qty
  ) then raise exception 'Insufficient source-branch stock for this transfer'; end if;

  for v_line in select to_jsonb(l) from public.stock_transfer_lines l where l.transfer_id=p_transfer_id order by l.product_id loop
    v_product_id := (v_line->>'product_id')::uuid;
    v_qty := (v_line->>'qty')::numeric;
    v_units := coalesce(array(select value::uuid from jsonb_array_elements_text(coalesce(v_line->'unit_ids','[]'::jsonb))), '{}'::uuid[]);
    update public.branch_stock set qty=qty-v_qty,updated_at=now()
      where shop_id=p_shop_id and branch_id=p_from_branch_id and product_id=v_product_id;
    insert into public.branch_stock(shop_id,branch_id,product_id,qty,updated_at)
      values(p_shop_id,p_to_branch_id,v_product_id,v_qty,now())
      on conflict(branch_id,product_id) do update set qty=public.branch_stock.qty+excluded.qty,updated_at=now();
    if cardinality(v_units)>0 then
      update public.inventory_units set branch_id=p_to_branch_id
      where shop_id=p_shop_id and product_id=v_product_id and id=any(v_units) and branch_id=p_from_branch_id and status='in_stock';
      if not found then raise exception 'IMEI/serial transfer could not move all selected units'; end if;
    end if;
  end loop;

  update public.stock_transfers set status='completed',note=left(coalesce(p_note,note,''),500),
    completed_by=v_uid,completed_at=now() where id=p_transfer_id;
  insert into public.audit_log(shop_id,user_id,action,entity,details)
  values(p_shop_id,v_uid,'STOCK_TRANSFER','StockTransfer',
    format('Transfer %s completed from branch %s to %s (%s line(s))',p_transfer_id,p_from_branch_id,p_to_branch_id,v_count));
  return jsonb_build_object('ok',true,'already_committed',false,'transfer_id',p_transfer_id,'status','completed','line_count',v_count);
end;
$function$;
revoke all on function public.complete_stock_transfer(uuid,uuid,uuid,uuid,jsonb,text,text) from public, anon;
grant execute on function public.complete_stock_transfer(uuid,uuid,uuid,uuid,jsonb,text,text) to authenticated;
