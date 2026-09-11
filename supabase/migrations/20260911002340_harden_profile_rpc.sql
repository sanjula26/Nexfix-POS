-- Nexfix POS: remove unnecessary SECURITY DEFINER privilege from the
-- self-service profile update RPC. The function only changes the caller's
-- own profile, so ordinary RLS is the safer boundary.

alter table public.profiles enable row level security;

drop policy if exists "profile self update" on public.profiles;
create policy "profile self update"
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

alter function public.update_own_profile(text, text) security invoker;

revoke execute on function public.update_own_profile(text, text) from public, anon;
grant execute on function public.update_own_profile(text, text) to authenticated;
