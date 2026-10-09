-- Phase 2: idempotent branch-scoped stock adjustments for the Inventory editor and stock-take tool.
create table if not exists public.branch_stock_adjustments (
  id uuid primary key,
  shop_id uuid not null references public.shops(id) on delete cascade,
  branch_id uuid not null,
  product_id uuid not null,
  delta numeric(12,2) not null check (delta <> 0),
  note text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint branch_stock_adjustments_branch_fk foreign key (shop_id,branch_id) references public.branches(shop_id,id),
  constraint branch_stock_adjustments_product_fk foreign key (shop_id,product_id) references public.products(shop_id,id)
);
alter table public.branch_stock_adjustments enable row level security;
drop policy if exists "branch stock adjustments member read" on public.branch_stock_adjustments;
create policy "branch stock adjustments member read" on public.branch_stock_adjustments
for select to authenticated using (private.is_shop_member(shop_id));
grant select on public.branch_stock_adjustments to authenticated;
create index if not exists branch_stock_adjustments_shop_branch_created_idx
  on public.branch_stock_adjustments(shop_id,branch_id,created_at desc);

create or replace function public.adjust_branch_stock_atomic(
  p_shop_id uuid,p_branch_id uuid,p_device_id text,p_product_id uuid,p_delta numeric,p_note text,p_adjustment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid:=auth.uid();
  v_role text;
  v_branch_count integer;
  v_binding uuid;
  v_existing public.branch_stock_adjustments%rowtype;
  v_branch_qty numeric;
  v_product_stock numeric;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  select m.role into v_role from public.shop_memberships m
  where m.shop_id=p_shop_id and m.user_id=v_uid and m.active;
  if v_role is null or v_role not in ('admin','manager') then raise exception 'Stock adjustment requires admin or manager permission'; end if;
  if p_delta is null or p_delta=0 or abs(p_delta)>1000000 then raise exception 'Invalid stock adjustment quantity'; end if;
  if p_adjustment_id is null or p_product_id is null then raise exception 'Adjustment and product ids are required'; end if;
  if not exists(select 1 from public.branches b where b.id=p_branch_id and b.shop_id=p_shop_id and b.active) then raise exception 'Selected branch is unavailable'; end if;
  select count(*) into v_branch_count from public.branches b where b.shop_id=p_shop_id and b.active;
  if v_branch_count>1 then
    select d.branch_id into v_binding from public.pos_device_branches d
    where d.shop_id=p_shop_id and d.device_id=btrim(coalesce(p_device_id,'')) limit 1;
    if v_binding is null or v_binding<>p_branch_id then raise exception 'This POS device is not assigned to the selected branch'; end if;
  end if;
  perform pg_advisory_xact_lock(hashtext(p_adjustment_id::text));
  select * into v_existing from public.branch_stock_adjustments a where a.id=p_adjustment_id;
  if found then
    if v_existing.shop_id<>p_shop_id or v_existing.branch_id<>p_branch_id or v_existing.product_id<>p_product_id or v_existing.delta<>p_delta then
      raise exception 'Adjustment idempotency key was reused with different data';
    end if;
    select bs.qty into v_branch_qty from public.branch_stock bs where bs.shop_id=p_shop_id and bs.branch_id=p_branch_id and bs.product_id=p_product_id;
    select p.stock into v_product_stock from public.products p where p.shop_id=p_shop_id and p.id=p_product_id;
    return jsonb_build_object('ok',true,'already_committed',true,'branch_qty',v_branch_qty,'product_stock',v_product_stock);
  end if;
  perform 1 from public.products p where p.shop_id=p_shop_id and p.id=p_product_id for update;
  if not found then raise exception 'Product is not synced to this cloud shop yet'; end if;
  insert into public.branch_stock(shop_id,branch_id,product_id,qty,updated_at)
  values(p_shop_id,p_branch_id,p_product_id,0,now()) on conflict(branch_id,product_id) do nothing;
  select bs.qty into v_branch_qty from public.branch_stock bs
  where bs.shop_id=p_shop_id and bs.branch_id=p_branch_id and bs.product_id=p_product_id for update;
  select p.stock into v_product_stock from public.products p where p.shop_id=p_shop_id and p.id=p_product_id;
  if v_branch_qty+p_delta<0 then raise exception 'Selected branch stock cannot become negative'; end if;
  if v_product_stock+p_delta<0 then raise exception 'Shop total stock cannot become negative'; end if;
  insert into public.branch_stock_adjustments(id,shop_id,branch_id,product_id,delta,note,created_by)
  values(p_adjustment_id,p_shop_id,p_branch_id,p_product_id,p_delta,left(coalesce(p_note,'Stock adjustment'),500),v_uid);
  update public.branch_stock set qty=qty+p_delta,updated_at=now()
  where shop_id=p_shop_id and branch_id=p_branch_id and product_id=p_product_id returning qty into v_branch_qty;
  update public.products set stock=stock+p_delta,updated_at=now() where shop_id=p_shop_id and id=p_product_id returning stock into v_product_stock;
  insert into public.audit_log(shop_id,user_id,action,entity,details)
  values(p_shop_id,v_uid,'STOCK_ADJUSTMENT','Product',format('Branch stock adjustment %s for product %s in branch %s: delta %s (%s)',p_adjustment_id,p_product_id,p_branch_id,p_delta,left(coalesce(p_note,''),300)));
  return jsonb_build_object('ok',true,'already_committed',false,'branch_qty',v_branch_qty,'product_stock',v_product_stock);
end;
$function$;
revoke all on function public.adjust_branch_stock_atomic(uuid,uuid,text,uuid,numeric,text,uuid) from public,anon;
grant execute on function public.adjust_branch_stock_atomic(uuid,uuid,text,uuid,numeric,text,uuid) to authenticated;
