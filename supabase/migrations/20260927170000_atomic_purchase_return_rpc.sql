-- Server-authoritative supplier returns / purchase returns.
-- Keeps the existing Purchase/GRN model and makes stock deduction atomic across devices.

create table if not exists public.purchase_returns (
  id uuid primary key,
  shop_id uuid not null,
  purchase_id uuid not null references public.purchases(id) on delete restrict,
  dn_no text not null,
  supplier_id uuid,
  supplier_name text not null default '',
  reason text not null,
  total numeric not null default 0,
  returned_at timestamptz not null default now(),
  created_by uuid,
  created_by_email text,
  device_id text not null,
  created_at timestamptz not null default now(),
  constraint purchase_returns_total_nonnegative check (total >= 0),
  constraint purchase_returns_reason_nonempty check (length(btrim(reason)) > 0),
  constraint purchase_returns_device_nonempty check (length(btrim(device_id)) > 0),
  constraint purchase_returns_shop_dn_unique unique (shop_id, dn_no)
);

create index if not exists purchase_returns_shop_purchase_idx
  on public.purchase_returns(shop_id, purchase_id, returned_at desc);

create table if not exists public.purchase_return_items (
  id uuid primary key default extensions.uuid_generate_v4(),
  return_id uuid not null references public.purchase_returns(id) on delete cascade,
  item_idx integer not null,
  product_id uuid not null references public.products(id) on delete restrict,
  name text not null default '',
  qty numeric not null,
  cost numeric not null,
  total numeric not null,
  constraint purchase_return_items_qty_positive check (qty > 0),
  constraint purchase_return_items_cost_nonnegative check (cost >= 0),
  constraint purchase_return_items_total_nonnegative check (total >= 0)
);

create index if not exists purchase_return_items_return_idx
  on public.purchase_return_items(return_id);

create table if not exists public.purchase_return_units (
  return_item_id uuid not null references public.purchase_return_items(id) on delete cascade,
  unit_id uuid not null references public.inventory_units(id) on delete restrict,
  primary key (return_item_id, unit_id),
  constraint purchase_return_units_unit_unique unique (unit_id)
);

alter table public.purchase_returns enable row level security;
alter table public.purchase_return_items enable row level security;
alter table public.purchase_return_units enable row level security;

revoke all on table public.purchase_returns, public.purchase_return_items, public.purchase_return_units from public, anon, authenticated;

create or replace function private.process_purchase_return_atomic(
  p_shop_id uuid,
  p_return_id uuid,
  p_purchase_id uuid,
  p_device_id text,
  p_reason text,
  p_purchase jsonb,
  p_lines jsonb
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
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
  v_tracked boolean;
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

  -- Serialize returns for one shop so debit-note numbering and stock validation
  -- cannot race between two POS devices.
  perform pg_advisory_xact_lock(hashtextextended('purchase-return:'||p_shop_id::text, 0));

  select * into v_purchase
  from public.purchases
  where id=p_purchase_id and shop_id=p_shop_id
  for update;
  if not found then raise exception 'GRN not found'; end if;
  if v_purchase.status <> 'received' then raise exception 'GRN must be processed before a supplier return'; end if;

  -- Retry-safe: the same stable return id never deducts stock twice.
  select * into v_existing
  from public.purchase_returns
  where id=p_return_id and shop_id=p_shop_id;
  if found then
    if v_existing.purchase_id <> p_purchase_id then
      raise exception 'Return id already belongs to another GRN';
    end if;
    return jsonb_build_object(
      'ok',true,
      'already_committed',true,
      'return_id',v_existing.id,
      'return_no',v_existing.dn_no,
      'total',v_existing.total,
      'purchase_id',v_existing.purchase_id
    );
  end if;

  -- Reject duplicate product/cost pairs in one request so two lines cannot
  -- each pass the remaining-quantity check and collectively over-return stock.
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

  -- Validate every requested line against normalized received purchase quantities.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_item_idx := (v_line->>'item_idx')::integer;
    v_product_id := (v_line->>'product_id')::uuid;
    v_qty := (v_line->>'qty')::numeric;
    v_cost := (v_line->>'cost')::numeric;

    if v_item_idx < 0 or v_item_idx >= jsonb_array_length(coalesce(p_purchase->'items','[]'::jsonb)) then
      raise exception 'Return item index is outside the source GRN';
    end if;
    if (p_purchase->'items'->v_item_idx->>'productId')::uuid <> v_product_id
       or (p_purchase->'items'->v_item_idx->>'cost')::numeric <> v_cost then
      raise exception 'Supplier return line does not match the selected GRN item';
    end if;
    if v_qty > (p_purchase->'items'->v_item_idx->>'qty')::numeric then
      raise exception 'Supplier return quantity exceeds the selected GRN item quantity';
    end if;
    if v_qty <= 0 or v_qty <> trunc(v_qty) then raise exception 'Return quantity must be a positive whole number'; end if;
    if v_cost < 0 or v_cost <> v_cost then raise exception 'Invalid return cost'; end if;

    select * into v_product
    from public.products
    where id=v_product_id and shop_id=p_shop_id
    for update;
    if not found then raise exception 'Return product does not belong to this shop'; end if;
    if v_product.stock < v_qty then raise exception 'Insufficient stock for supplier return'; end if;

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

    v_tracked := coalesce(v_product.track_imei,false) or coalesce(v_product.track_serial,false);
    v_unit_ids := array(select x::uuid from jsonb_array_elements_text(coalesce(v_line->'unit_ids','[]'::jsonb)) x);

    if v_tracked then
      if cardinality(v_unit_ids) <> v_qty then raise exception 'Tracked supplier return must select exactly one unit per returned quantity'; end if;
      if cardinality(v_unit_ids) <> (select count(distinct x) from unnest(v_unit_ids) x) then raise exception 'Duplicate tracked unit ids are not allowed'; end if;

      foreach v_unit_id in array v_unit_ids loop
        perform 1 from public.inventory_units u
        where u.id=v_unit_id
          and u.shop_id=p_shop_id
          and u.product_id=v_product_id
          and u.purchase_id=p_purchase_id
          and u.status='in_stock'
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

    update public.products
      set stock=stock-v_qty,updated_at=now()
      where id=v_product_id and shop_id=p_shop_id;

    v_unit_ids := array(select x::uuid from jsonb_array_elements_text(coalesce(v_line->'unit_ids','[]'::jsonb)) x);
    foreach v_unit_id in array v_unit_ids loop
      update public.inventory_units
        set status='returned',sale_id=null,sale_bill_no=null,sold_at=null,
            note='Returned to supplier via '||v_dn_no
        where id=v_unit_id and shop_id=p_shop_id and status='in_stock';
      if not found then raise exception 'Tracked unit changed before supplier return was committed'; end if;
      insert into public.purchase_return_units(return_item_id,unit_id)
      values(v_return_item_id,v_unit_id);
    end loop;
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
$$;

create or replace function public.process_purchase_return_atomic(
  p_shop_id uuid,p_return_id uuid,p_purchase_id uuid,p_device_id text,p_reason text,p_purchase jsonb,p_lines jsonb
) returns jsonb
language sql security invoker set search_path to ''
as 'select private.process_purchase_return_atomic($1,$2,$3,$4,$5,$6,$7)';

revoke all on function private.process_purchase_return_atomic(uuid,uuid,uuid,text,text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.process_purchase_return_atomic(uuid,uuid,uuid,text,text,jsonb,jsonb) from public,anon;
grant execute on function public.process_purchase_return_atomic(uuid,uuid,uuid,text,text,jsonb,jsonb) to authenticated;
