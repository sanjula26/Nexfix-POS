-- Make completed stock-transfer retries idempotent only for an identical payload.
CREATE OR REPLACE FUNCTION public.complete_stock_transfer(p_shop_id uuid, p_transfer_id uuid, p_from_branch_id uuid, p_to_branch_id uuid, p_lines jsonb, p_note text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_reconcile_ids uuid[];
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
    if v_transfer.from_branch_id<>p_from_branch_id or v_transfer.to_branch_id<>p_to_branch_id then
      raise exception 'Transfer id was already committed for different branches';
    end if;
    -- A completed transfer is idempotent only for the exact same line payload.
    -- Compare normalized line arrays (including sorted tracked-unit IDs) so a
    -- reused transfer ID cannot hide a changed quantity/product/IMEI selection.
    if (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'product_id', l.product_id,
          'qty', l.qty,
          'unit_ids', to_jsonb(array(select u.unit_id from unnest(l.unit_ids) as u(unit_id) order by u.unit_id))
        ) order by l.product_id, l.qty, l.unit_ids::text
      ), '[]'::jsonb)
      from public.stock_transfer_lines l
      where l.transfer_id=p_transfer_id and l.shop_id=p_shop_id
    ) is distinct from (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'product_id', nullif(x.value->>'product_id','')::uuid,
          'qty', (x.value->>'qty')::numeric,
          'unit_ids', to_jsonb(array(
            select u.unit_id::uuid
            from jsonb_array_elements_text(coalesce(x.value->'unit_ids','[]'::jsonb)) as u(unit_id)
            order by u.unit_id::uuid
          ))
        ) order by nullif(x.value->>'product_id','')::uuid, (x.value->>'qty')::numeric, coalesce(x.value->'unit_ids','[]'::jsonb)::text
      ), '[]'::jsonb)
      from jsonb_array_elements(p_lines) as x(value)
    ) then
      raise exception 'Transfer ID was already committed with different line items';
    end if;
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

  -- Keep legacy shop-total stock aligned with branch balances for affected
  -- products; transfers preserve the total quantity.
  select array_agg(distinct l.product_id) into v_reconcile_ids
  from public.stock_transfer_lines l where l.transfer_id=p_transfer_id;
  perform private.reconcile_product_stock_from_branch_stock(p_shop_id,v_reconcile_ids);

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
$function$

