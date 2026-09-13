-- Prevent a normal authenticated user from changing their own
-- authorization-bearing profile fields (role/active/commission).
-- RLS protects which profile row may be updated, but a self-update policy
-- alone would otherwise allow privilege escalation through those columns.

create or replace function public.prevent_profile_privilege_self_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if new.role is distinct from old.role
     or new.active is distinct from old.active
     or new.commission_pct is distinct from old.commission_pct then
    if not exists (
      select 1
      from public.shop_memberships m
      where m.user_id = auth.uid()
        and m.active = true
        and m.role in ('admin', 'manager')
    ) then
      raise exception 'Only a shop admin or manager may change profile authorization fields';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists protect_profile_privilege_fields on public.profiles;
create trigger protect_profile_privilege_fields
before update on public.profiles
for each row
execute function public.prevent_profile_privilege_self_change();
