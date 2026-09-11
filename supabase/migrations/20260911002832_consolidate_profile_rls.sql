-- Nexfix POS: consolidate the two permissive profile SELECT policies into
-- one policy. Authorization is unchanged: users can read themselves, and
-- shop admins/managers can read profiles belonging to their shop.

drop policy if exists "profile self read" on public.profiles;
drop policy if exists "profile shop admin read" on public.profiles;

create policy "profile read"
  on public.profiles
  for select
  to authenticated
  using (
    id = (select auth.uid())
    or exists (
      select 1
      from public.shop_memberships m
      where m.user_id = profiles.id
        and (select public.is_shop_admin(m.shop_id))
    )
  );
