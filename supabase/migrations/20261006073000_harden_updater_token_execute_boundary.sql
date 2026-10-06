-- Updater tokens are issued only after Supabase Auth + shop-admin + device checks.
-- PUBLIC grants would implicitly make the function executable by anon, even if
-- the anon role itself was explicitly revoked, so remove both PUBLIC and anon.
revoke execute on function public.issue_pos_updater_token(text,text) from public, anon;
grant execute on function public.issue_pos_updater_token(text,text) to authenticated;

revoke execute on function private.issue_pos_updater_token(text,text) from public, anon;
grant execute on function private.issue_pos_updater_token(text,text) to authenticated;
