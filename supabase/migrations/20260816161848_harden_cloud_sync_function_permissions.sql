revoke all on function public.rls_auto_enable() from anon, authenticated;
revoke all on function public.register_pos_device(text,text) from anon;
revoke all on function public.upsert_pos_snapshot(text,text,bigint,jsonb) from anon;
grant execute on function public.register_pos_device(text,text) to authenticated;
grant execute on function public.upsert_pos_snapshot(text,text,bigint,jsonb) to authenticated;