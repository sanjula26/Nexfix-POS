-- Server-authoritative bill reversal request/approval workflow.
do $$ begin
  if not exists(select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typname='sale_status' and e.enumlabel='reversed') then
    alter type public.sale_status add value 'reversed';
  end if;
end $$;

create table if not exists public.sale_reversal_requests(
 id uuid primary key, shop_id uuid not null references public.shops(id) on delete cascade,
 sale_id uuid not null references public.sales(id) on delete restrict, bill_no text not null,
 reason text not null check(length(btrim(reason)) between 1 and 500),
 requested_by uuid not null references auth.users(id) on delete restrict,
 requested_at timestamptz not null default now(),
 status text not null default 'pending' check(status in('pending','approved','rejected')),
 reviewed_by uuid references auth.users(id) on delete restrict, reviewed_at timestamptz, review_note text);
create index if not exists sale_reversal_requests_shop_status_idx on public.sale_reversal_requests(shop_id,status,requested_at desc);
create index if not exists sale_reversal_requests_sale_idx on public.sale_reversal_requests(shop_id,sale_id,status);
alter table public.sale_reversal_requests enable row level security;
revoke all on table public.sale_reversal_requests from public,anon,authenticated;

create or replace function private.request_sale_reversal(p_shop_id uuid,p_request_id uuid,p_sale_id uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_uid uuid:=auth.uid(); v_sale public.sales%rowtype; v_existing public.sale_reversal_requests%rowtype; v_reason text:=left(btrim(coalesce(p_reason,'')),500);
begin
 if v_uid is null then raise exception 'Authentication required'; end if;
 if p_shop_id is null or p_request_id is null or p_sale_id is null or v_reason='' then raise exception 'Invalid reversal request'; end if;
 if not exists(select 1 from public.shop_memberships m where m.shop_id=p_shop_id and m.user_id=v_uid and m.active=true and m.role in('admin','manager','cashier')) then raise exception 'Shop membership does not allow bill reversal requests'; end if;
 select * into v_sale from public.sales where id=p_sale_id and shop_id=p_shop_id for update;
 if not found then raise exception 'Sale not found'; end if;
 if v_sale.status<>'completed' then raise exception 'Sale is not eligible for reversal'; end if;
 select * into v_existing from public.sale_reversal_requests where id=p_request_id and shop_id=p_shop_id;
 if found then if v_existing.sale_id<>p_sale_id then raise exception 'Request id already belongs to another sale'; end if;
   return jsonb_build_object('ok',true,'already_committed',true,'request_id',v_existing.id,'sale_id',v_existing.sale_id,'status',v_existing.status); end if;
 if exists(select 1 from public.sale_reversal_requests r where r.shop_id=p_shop_id and r.sale_id=p_sale_id and r.status='pending') then raise exception 'A reversal request is already pending for this sale'; end if;
 if exists(select 1 from public.sale_returns r where r.shop_id=p_shop_id and r.sale_id=p_sale_id) then raise exception 'A sale return already exists for this bill'; end if;
 insert into public.sale_reversal_requests(id,shop_id,sale_id,bill_no,reason,requested_by) values(p_request_id,p_shop_id,p_sale_id,v_sale.bill_no,v_reason,v_uid);
 insert into public.audit_log(id,shop_id,user_id,user_email,action,entity,details) select extensions.uuid_generate_v4(),p_shop_id,v_uid,u.email,'REVERSE-REQUEST','Sale','Reverse requested for '||v_sale.bill_no||' · '||v_reason from auth.users u where u.id=v_uid;
 return jsonb_build_object('ok',true,'already_committed',false,'request_id',p_request_id,'sale_id',p_sale_id,'status','pending');
end $$;
create or replace function public.request_sale_reversal(p_shop_id uuid,p_request_id uuid,p_sale_id uuid,p_reason text) returns jsonb language sql security invoker set search_path to '' as $$ select private.request_sale_reversal($1,$2,$3,$4) $$;

create or replace function private.approve_sale_reversal(p_shop_id uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_uid uuid:=auth.uid(); v_req public.sale_reversal_requests%rowtype; v_sale public.sales%rowtype; v_balance_due numeric:=0;
begin
 if v_uid is null then raise exception 'Authentication required'; end if;
 if not exists(select 1 from public.shop_memberships m where m.shop_id=p_shop_id and m.user_id=v_uid and m.active=true and m.role='admin') then raise exception 'Only an active shop admin can approve bill reversals'; end if;
 select * into v_req from public.sale_reversal_requests where id=p_request_id and shop_id=p_shop_id for update;
 if not found then raise exception 'Reversal request not found'; end if;
 if v_req.status='approved' then return jsonb_build_object('ok',true,'already_committed',true,'request_id',v_req.id,'sale_id',v_req.sale_id); end if;
 if v_req.status<>'pending' then raise exception 'Reversal request is no longer pending'; end if;
 select * into v_sale from public.sales where id=v_req.sale_id and shop_id=p_shop_id for update;
 if not found then raise exception 'Sale not found'; end if;
 if v_sale.status<>'completed' then raise exception 'Sale is no longer eligible for reversal'; end if;
 if exists(select 1 from public.sale_returns r where r.shop_id=p_shop_id and r.sale_id=v_sale.id) then raise exception 'A sale return already exists for this bill'; end if;
 update public.products p set stock=p.stock+x.qty,updated_at=now() from(select si.product_id,sum(si.qty)::numeric qty from public.sale_items si where si.sale_id=v_sale.id group by si.product_id)x where p.id=x.product_id and p.shop_id=p_shop_id;
 update public.inventory_units set status='in_stock',sale_id=null,sale_bill_no=null,sold_at=null where shop_id=p_shop_id and sale_id=v_sale.id and status='sold';
 update public.products p set stock=greatest(0,p.stock-x.qty),updated_at=now() from(select iu.product_id,count(*)::numeric qty from public.inventory_units iu where iu.shop_id=p_shop_id and iu.sale_id=v_sale.id and iu.status='in_stock' and iu.note='Trade-in' group by iu.product_id)x where p.id=x.product_id and p.shop_id=p_shop_id;
 update public.inventory_units set status='returned',sale_id=null,sale_bill_no=null,sold_at=null where shop_id=p_shop_id and sale_id=v_sale.id and status='in_stock' and note='Trade-in';
 v_balance_due:=greatest(0,coalesce(v_sale.total,0)-coalesce(v_sale.amount_paid,0));
 if v_sale.customer_id is not null then update public.customers set credit_balance=greatest(0,coalesce(credit_balance,0)-v_balance_due),loyalty_points=greatest(0,coalesce(loyalty_points,0)-coalesce(v_sale.points_earned,0)+coalesce(v_sale.points_redeemed,0)),updated_at=now() where id=v_sale.customer_id and shop_id=p_shop_id; end if;
 update public.sales set status='reversed'::public.sale_status where id=v_sale.id and shop_id=p_shop_id;
 update public.sale_reversal_requests set status='approved',reviewed_by=v_uid,reviewed_at=now() where id=v_req.id and shop_id=p_shop_id;
 insert into public.audit_log(id,shop_id,user_id,user_email,action,entity,details) select extensions.uuid_generate_v4(),p_shop_id,v_uid,u.email,'REVERSE-APPROVED','Sale','Bill '||v_sale.bill_no||' reversed and stock restored' from auth.users u where u.id=v_uid;
 return jsonb_build_object('ok',true,'already_committed',false,'request_id',v_req.id,'sale_id',v_sale.id,'bill_no',v_sale.bill_no);
end $$;
create or replace function public.approve_sale_reversal(p_shop_id uuid,p_request_id uuid) returns jsonb language sql security invoker set search_path to '' as $$ select private.approve_sale_reversal($1,$2) $$;

create or replace function private.reject_sale_reversal(p_shop_id uuid,p_request_id uuid,p_note text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_uid uuid:=auth.uid(); v_req public.sale_reversal_requests%rowtype; v_note text:=nullif(left(btrim(coalesce(p_note,'')),500),'');
begin
 if v_uid is null then raise exception 'Authentication required'; end if;
 if not exists(select 1 from public.shop_memberships m where m.shop_id=p_shop_id and m.user_id=v_uid and m.active=true and m.role='admin') then raise exception 'Only an active shop admin can reject bill reversals'; end if;
 select * into v_req from public.sale_reversal_requests where id=p_request_id and shop_id=p_shop_id for update;
 if not found then raise exception 'Reversal request not found'; end if;
 if v_req.status='rejected' then return jsonb_build_object('ok',true,'already_committed',true,'request_id',v_req.id,'status','rejected'); end if;
 if v_req.status<>'pending' then raise exception 'Reversal request is no longer pending'; end if;
 update public.sale_reversal_requests set status='rejected',reviewed_by=v_uid,reviewed_at=now(),review_note=v_note where id=v_req.id and shop_id=p_shop_id;
 insert into public.audit_log(id,shop_id,user_id,user_email,action,entity,details) select extensions.uuid_generate_v4(),p_shop_id,v_uid,u.email,'REVERSE-REJECTED','Sale','Reverse request for '||v_req.bill_no||' rejected' from auth.users u where u.id=v_uid;
 return jsonb_build_object('ok',true,'already_committed',false,'request_id',v_req.id,'status','rejected');
end $$;
create or replace function public.reject_sale_reversal(p_shop_id uuid,p_request_id uuid,p_note text default null) returns jsonb language sql security invoker set search_path to '' as $$ select private.reject_sale_reversal($1,$2,$3) $$;

revoke all on function private.request_sale_reversal(uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function private.approve_sale_reversal(uuid,uuid) from public,anon,authenticated;
revoke all on function private.reject_sale_reversal(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.request_sale_reversal(uuid,uuid,uuid,text) from public,anon;
revoke all on function public.approve_sale_reversal(uuid,uuid) from public,anon;
revoke all on function public.reject_sale_reversal(uuid,uuid,text) from public,anon;
grant execute on function public.request_sale_reversal(uuid,uuid,uuid,text) to authenticated;
grant execute on function public.approve_sale_reversal(uuid,uuid) to authenticated;
grant execute on function public.reject_sale_reversal(uuid,uuid,text) to authenticated;