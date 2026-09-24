create policy "No direct reversal request access" on public.sale_reversal_requests for all to anon,authenticated using(false) with check(false);

create or replace function public.list_sale_reversal_requests(p_shop_id uuid)
returns setof jsonb language sql security invoker set search_path to '' as $$
 select jsonb_build_object('id',r.id,'saleId',r.sale_id,'billNo',r.bill_no,'reason',r.reason,'requestedBy',coalesce(p.full_name,au.email,r.requested_by::text),'requestedAt',r.requested_at,'status',r.status,'reviewedBy',r.reviewed_by::text,'reviewedAt',r.reviewed_at,'reviewNote',r.review_note)
 from public.sale_reversal_requests r left join public.profiles p on p.id=r.requested_by left join auth.users au on au.id=r.requested_by
 where r.shop_id=p_shop_id and exists(select 1 from public.shop_memberships m where m.shop_id=p_shop_id and m.user_id=(select auth.uid()) and m.active=true)
 order by r.requested_at desc limit 200
$$;
revoke all on function public.list_sale_reversal_requests(uuid) from public,anon;
grant execute on function public.list_sale_reversal_requests(uuid) to authenticated;