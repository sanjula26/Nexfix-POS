-- Phase 2.2 device-to-branch binding. This is intentionally separate from updater device credentials.
create table if not exists public.pos_device_branches (
  shop_id uuid not null references public.shops(id) on delete cascade,
  device_id text not null check (length(btrim(device_id)) between 1 and 200),
  branch_id uuid not null,
  assigned_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (shop_id, device_id),
  constraint pos_device_branches_branch_fk foreign key (shop_id, branch_id)
    references public.branches(shop_id, id)
);
alter table public.pos_device_branches enable row level security;
drop policy if exists "device branches member read" on public.pos_device_branches;
create policy "device branches member read" on public.pos_device_branches
for select to authenticated using (private.is_shop_member(shop_id));
drop policy if exists "device branches admin manage" on public.pos_device_branches;
create policy "device branches admin manage" on public.pos_device_branches
for all to authenticated using (private.is_shop_admin(shop_id))
with check (private.is_shop_admin(shop_id));
grant select on public.pos_device_branches to authenticated;
create index if not exists pos_device_branches_branch_idx on public.pos_device_branches(shop_id,branch_id);

create or replace function public.set_pos_device_branch(p_shop_id uuid, p_device_id text, p_branch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_uid uuid:=auth.uid(); v_role text;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  select m.role into v_role from public.shop_memberships m
  where m.shop_id=p_shop_id and m.user_id=v_uid and m.active;
  if v_role is null or v_role not in ('admin','manager') then raise exception 'Only an admin or manager can assign a POS device to a branch'; end if;
  if p_device_id is null or length(btrim(p_device_id))=0 or length(p_device_id)>200 then raise exception 'Valid POS device id is required'; end if;
  if not exists(select 1 from public.branches b where b.id=p_branch_id and b.shop_id=p_shop_id and b.active) then raise exception 'Selected branch is not active in this shop'; end if;
  insert into public.pos_device_branches(shop_id,device_id,branch_id,assigned_by,created_at,updated_at)
  values(p_shop_id,btrim(p_device_id),p_branch_id,v_uid,now(),now())
  on conflict(shop_id,device_id) do update set branch_id=excluded.branch_id,assigned_by=excluded.assigned_by,updated_at=now();
  insert into public.audit_log(shop_id,user_id,action,entity,details)
  values(p_shop_id,v_uid,'BRANCH_BIND','POSDevice',format('Device %s assigned to branch %s',left(btrim(p_device_id),80),p_branch_id));
  return jsonb_build_object('ok',true,'shop_id',p_shop_id,'device_id',btrim(p_device_id),'branch_id',p_branch_id);
end;
$function$;
revoke all on function public.set_pos_device_branch(uuid,text,uuid) from public,anon;
grant execute on function public.set_pos_device_branch(uuid,text,uuid) to authenticated;

create or replace function public.complete_sale_atomic_for_device_branch(
  p_shop_id uuid, p_branch_id uuid, p_device_id text, p_sale_id uuid,
  p_customer_id uuid default null, p_shipping numeric default 0, p_discount numeric default 0,
  p_tax_pct numeric default 0, p_points_redeemed integer default 0, p_note text default null,
  p_salesman_id uuid default null, p_lines jsonb default '[]'::jsonb, p_payments jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_branch_count integer; v_binding uuid; v_result jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not exists(select 1 from public.shop_memberships m where m.shop_id=p_shop_id and m.user_id=auth.uid() and m.active and m.role in ('admin','manager','cashier')) then
    raise exception 'User is not authorized to complete sales for this shop';
  end if;
  select count(*) into v_branch_count from public.branches b where b.shop_id=p_shop_id and b.active;
  if v_branch_count > 1 then
    select d.branch_id into v_binding from public.pos_device_branches d
    where d.shop_id=p_shop_id and d.device_id=btrim(coalesce(p_device_id,'')) limit 1;
    if v_binding is null or v_binding<>p_branch_id then
      raise exception 'This POS device is not assigned to the selected branch. Ask an admin to assign it in Settings.';
    end if;
  end if;
  v_result := public.complete_sale_atomic_for_branch(
    p_shop_id,p_branch_id,p_sale_id,p_customer_id,p_shipping,p_discount,p_tax_pct,
    p_points_redeemed,p_note,p_salesman_id,p_lines,p_payments
  );
  return v_result;
end;
$function$;
revoke all on function public.complete_sale_atomic_for_device_branch(uuid,uuid,text,uuid,uuid,numeric,numeric,numeric,integer,text,uuid,jsonb,jsonb) from public,anon;
grant execute on function public.complete_sale_atomic_for_device_branch(uuid,uuid,text,uuid,uuid,numeric,numeric,numeric,integer,text,uuid,jsonb,jsonb) to authenticated;

create or replace function public.receive_purchase_atomic_for_device_branch(
  p_shop_id uuid, p_branch_id uuid, p_device_id text, p_purchase_id uuid, p_purchase jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_branch_count integer; v_binding uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select count(*) into v_branch_count from public.branches b where b.shop_id=p_shop_id and b.active;
  if v_branch_count > 1 then
    select d.branch_id into v_binding from public.pos_device_branches d
    where d.shop_id=p_shop_id and d.device_id=btrim(coalesce(p_device_id,'')) limit 1;
    if v_binding is null or v_binding<>p_branch_id then
      raise exception 'This POS device is not assigned to the selected branch. Ask an admin to assign it in Settings.';
    end if;
  end if;
  return public.receive_purchase_atomic_for_branch(p_shop_id,p_branch_id,p_purchase_id,p_device_id,p_purchase);
end;
$function$;
revoke all on function public.receive_purchase_atomic_for_device_branch(uuid,uuid,text,uuid,jsonb) from public,anon;
grant execute on function public.receive_purchase_atomic_for_device_branch(uuid,uuid,text,uuid,jsonb) to authenticated;
