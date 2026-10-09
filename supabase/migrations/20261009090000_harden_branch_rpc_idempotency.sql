-- Phase 2 hardening: idempotent retries cannot silently cross branches.
do $$
declare d text;
begin
  select pg_get_functiondef('public.complete_sale_atomic_for_branch(uuid,uuid,uuid,uuid,numeric,numeric,numeric,integer,text,uuid,jsonb,jsonb)'::regprocedure) into d;
  if position($a$if coalesce((v_result->>'already_committed')::boolean,false) then return v_result; end if;$a$ in d)=0 then
    raise exception 'Sale idempotency anchor not found; refusing unsafe migration';
  end if;
  d := replace(d,
    $a$if coalesce((v_result->>'already_committed')::boolean,false) then return v_result; end if;$a$,
    $b$if coalesce((v_result->>'already_committed')::boolean,false) then
    if nullif(v_result->'sale'->>'branch_id','') is not null and (v_result->'sale'->>'branch_id')::uuid <> p_branch_id then
      raise exception 'Sale id was already committed to a different branch';
    end if;
    return v_result;
  end if;$b$);
  execute d;
end $$;

do $$
declare d text;
begin
  select pg_get_functiondef('public.receive_purchase_atomic_for_branch(uuid,uuid,uuid,text,jsonb)'::regprocedure) into d;
  if position($a$v_existing_status text;$a$ in d)=0 or position($a$select p.status into v_existing_status$a$ in d)=0 then
    raise exception 'GRN idempotency anchors not found; refusing unsafe migration';
  end if;
  d := replace(d, $a$v_existing_status text;$a$, $b$v_existing_status text; v_existing_branch_id uuid;$b$);
  d := replace(d, $a$select p.status into v_existing_status from public.purchases p$a$,
    $b$select p.status,p.branch_id into v_existing_status,v_existing_branch_id from public.purchases p$b$);
  d := replace(d,
    $a$if v_existing_status='received' then
    return public.receive_purchase_atomic(p_shop_id,p_purchase_id,p_device_id,p_purchase);
  end if;$a$,
    $b$if v_existing_status='received' then
    if v_existing_branch_id is not null and v_existing_branch_id <> p_branch_id then
      raise exception 'GRN was already received at a different branch';
    end if;
    return public.receive_purchase_atomic(p_shop_id,p_purchase_id,p_device_id,p_purchase);
  end if;$b$);
  execute d;
end $$;

do $$
declare d text;
begin
  select pg_get_functiondef('public.complete_stock_transfer(uuid,uuid,uuid,uuid,jsonb,text,text)'::regprocedure) into d;
  if position($a$if found and v_transfer.status='completed' then$a$ in d)=0 then
    raise exception 'Transfer idempotency anchor not found; refusing unsafe migration';
  end if;
  d := replace(d,
    $a$if found and v_transfer.status='completed' then
    return jsonb_build_object('ok',true,'already_committed',true,'transfer_id',p_transfer_id,'status','completed');
  end if;$a$,
    $b$if found and v_transfer.status='completed' then
    if v_transfer.from_branch_id<>p_from_branch_id or v_transfer.to_branch_id<>p_to_branch_id then
      raise exception 'Transfer id was already committed for different branches';
    end if;
    return jsonb_build_object('ok',true,'already_committed',true,'transfer_id',p_transfer_id,'status','completed');
  end if;$b$);
  execute d;
end $$;

do $$
declare d text;
begin
  select pg_get_functiondef('public.receive_purchase_atomic_for_device_branch(uuid,uuid,text,uuid,jsonb)'::regprocedure) into d;
  if position($a$if auth.uid() is null then raise exception 'Authentication required'; end if;$a$ in d)=0 then
    raise exception 'GRN device branch authorization anchor not found';
  end if;
  d := replace(d,
    $a$if auth.uid() is null then raise exception 'Authentication required'; end if;$a$,
    $b$if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not exists(select 1 from public.shop_memberships m where m.shop_id=p_shop_id and m.user_id=auth.uid() and m.active and m.role in ('admin','manager','inventory_manager')) then
    raise exception 'User is not authorized to receive GRNs';
  end if;$b$);
  execute d;
end $$;
