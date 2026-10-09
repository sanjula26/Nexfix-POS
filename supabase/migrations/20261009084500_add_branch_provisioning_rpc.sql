-- Phase 2 branch provisioning. New branch stock starts at zero; stock must be transferred explicitly from Main.
create or replace function private.initialize_branch_stock_for_product()
returns trigger language plpgsql security definer set search_path = ''
as $function$
begin
  insert into public.branch_stock(shop_id,branch_id,product_id,qty,updated_at)
  select b.shop_id,b.id,new.id,case when b.is_default then new.stock else 0 end,now()
  from public.branches b where b.shop_id=new.shop_id and b.active
  on conflict(branch_id,product_id) do nothing;
  return new;
end;
$function$;
revoke all on function private.initialize_branch_stock_for_product() from public,anon,authenticated;
drop trigger if exists products_initialize_branch_stock on public.products;
create trigger products_initialize_branch_stock after insert on public.products
for each row execute function private.initialize_branch_stock_for_product();

create or replace function public.create_shop_branch(p_shop_id uuid,p_name text,p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_uid uuid:=auth.uid(); v_role text; v_branch public.branches%rowtype;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  select m.role into v_role from public.shop_memberships m
  where m.shop_id=p_shop_id and m.user_id=v_uid and m.active;
  if v_role is null or v_role not in ('admin','manager') then raise exception 'Only an admin or manager can create a branch'; end if;
  if length(btrim(coalesce(p_name,'')))<2 or length(btrim(p_name))>80 then raise exception 'Branch name must be 2–80 characters'; end if;
  if upper(btrim(coalesce(p_code,''))) !~ '^[A-Z0-9][A-Z0-9_-]{0,19}$' then raise exception 'Branch code must be 1–20 letters, numbers, hyphens or underscores'; end if;
  insert into public.branches(shop_id,name,code,active,is_default,created_at,updated_at)
  values(p_shop_id,btrim(p_name),upper(btrim(p_code)),true,false,now(),now())
  returning * into v_branch;
  insert into public.branch_stock(shop_id,branch_id,product_id,qty,updated_at)
  select p_shop_id,v_branch.id,p.id,0,now() from public.products p where p.shop_id=p_shop_id
  on conflict(branch_id,product_id) do nothing;
  insert into public.audit_log(shop_id,user_id,action,entity,details)
  values(p_shop_id,v_uid,'BRANCH_CREATE','Branch',format('Created branch %s (%s); opening stock starts at zero',v_branch.name,v_branch.code));
  return jsonb_build_object('ok',true,'branch',to_jsonb(v_branch));
end;
$function$;
revoke all on function public.create_shop_branch(uuid,text,text) from public,anon;
grant execute on function public.create_shop_branch(uuid,text,text) to authenticated;
