-- Step 1 production hardening: close profile privilege escalation and make
-- audit logging append-only from authenticated tenant members.
-- Run after the existing production-security and cloud-sync migrations.

-- A user's browser must never be able to promote its own cloud profile by
-- updating the role column. The old policy allowed arbitrary self-updates.
drop policy if exists "profile self update" on public.profiles;

create or replace function public.update_own_profile(
  p_full_name text,
  p_phone text
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.profiles;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_full_name is null or length(btrim(p_full_name)) < 1 or length(p_full_name) > 200 then
    raise exception 'Invalid full name';
  end if;

  if p_phone is not null and length(p_phone) > 50 then
    raise exception 'Invalid phone';
  end if;

  update public.profiles
     set full_name = btrim(p_full_name),
         phone = nullif(btrim(coalesce(p_phone, '')), ''),
         updated_at = now()
   where id = auth.uid()
   returning * into result;

  if result.id is null then
    raise exception 'Profile not found';
  end if;

  return result;
end;
$$;

revoke all on function public.update_own_profile(text, text) from public, anon;
grant execute on function public.update_own_profile(text, text) to authenticated;

-- Audit events are immutable. Members may append events for their own shop,
-- but nobody using the browser client may update or delete them.
drop policy if exists "audit member insert" on public.audit_log;
create policy "audit member insert" on public.audit_log
  for insert to authenticated
  with check (
    is_shop_member(shop_id)
    and (user_id is null or user_id = auth.uid())
  );

drop policy if exists "audit member update" on public.audit_log;
drop policy if exists "audit member delete" on public.audit_log;

comment on function public.update_own_profile(text, text)
is 'Safe self-service profile update. Role, active status and email cannot be changed by the browser client.';
comment on table public.audit_log
is 'Append-only tenant audit log. Browser clients may insert and read their shop events but cannot update or delete events.';
