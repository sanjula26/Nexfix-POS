-- Fix cloud-auth gating, safe Main-branch recovery, and server-generated branch codes.
-- Branch management is authorized by Supabase auth.uid() + shop_memberships,
-- never by the local POS user role.

create or replace function public.ensure_default_branch(p_shop_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_branch public.branches%rowtype;
  v_active_count integer := 0;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'Cloud sign-in required to load or create the Main branch';
  end if;
  if p_shop_id is null or not exists (
    select 1 from public.shop_memberships m
    where m.shop_id = p_shop_id and m.user_id = v_uid and m.active
  ) then
    raise exception using errcode = '42501', message = 'No active shop membership for this Cloud account';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_shop_id::text, 0));
  select count(*) into v_active_count
  from public.branches b where b.shop_id = p_shop_id and b.active;

  select b.* into v_branch
  from public.branches b
  where b.shop_id = p_shop_id and b.is_default
  for update;

  if found then
    update public.branches set active = true, updated_at = now()
    where id = v_branch.id and shop_id = p_shop_id
    returning * into v_branch;
  else
    select b.* into v_branch from public.branches b
    where b.shop_id = p_shop_id and upper(b.code) = 'MAIN'
    for update;
    if found then
      update public.branches set active = true, is_default = true, updated_at = now()
      where id = v_branch.id and shop_id = p_shop_id
      returning * into v_branch;
    else
      insert into public.branches(shop_id, name, code, active, is_default, created_at, updated_at)
      values (p_shop_id, 'Main', 'MAIN', true, true, now(), now())
      returning * into v_branch;
    end if;
  end if;

  -- Recover legacy product stock only if there were no active branches.
  -- Existing branch balances are never copied or duplicated.
  insert into public.branch_stock(shop_id, branch_id, product_id, qty, updated_at)
  select p_shop_id, v_branch.id, p.id,
         case when v_active_count = 0 then p.stock else 0 end, now()
  from public.products p where p.shop_id = p_shop_id
  on conflict (branch_id, product_id) do nothing;

  return jsonb_build_object('ok', true, 'branch', to_jsonb(v_branch));
end;
$function$;

revoke all on function public.ensure_default_branch(uuid) from public, anon;
grant execute on function public.ensure_default_branch(uuid) to authenticated;

create or replace function public.create_shop_branch(p_shop_id uuid, p_name text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_branch public.branches%rowtype;
  v_base_code text;
  v_code text;
  v_suffix integer := 2;
  v_suffix_text text;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'Cloud sign-in required to create a branch';
  end if;

  select m.role into v_role from public.shop_memberships m
  where m.shop_id = p_shop_id and m.user_id = v_uid and m.active;
  if v_role is null then
    raise exception using errcode = '42501', message = 'No active shop membership for this Cloud account';
  end if;
  if v_role not in ('admin', 'manager') then
    raise exception using errcode = '42501', message = 'Only an Admin or Manager Cloud membership can create a branch';
  end if;
  if length(btrim(coalesce(p_name, ''))) < 2 or length(btrim(p_name)) > 80 then
    raise exception using errcode = '22023', message = 'Branch name must be 2–80 characters';
  end if;

  -- p_code is retained for compatibility with older builds, but ignored.
  perform pg_advisory_xact_lock(hashtextextended(p_shop_id::text, 0));
  v_base_code := left(regexp_replace(upper(btrim(p_name)), '[^A-Z0-9]', '', 'g'), 20);
  if v_base_code = '' then v_base_code := 'BRANCH'; end if;
  v_code := v_base_code;

  while exists (select 1 from public.branches b where b.shop_id = p_shop_id and upper(b.code) = v_code) loop
    v_suffix_text := '-' || v_suffix::text;
    v_code := left(v_base_code, 20 - length(v_suffix_text)) || v_suffix_text;
    v_suffix := v_suffix + 1;
  end loop;

  insert into public.branches(shop_id, name, code, active, is_default, created_at, updated_at)
  values (p_shop_id, btrim(p_name), v_code, true, false, now(), now())
  returning * into v_branch;

  insert into public.branch_stock(shop_id, branch_id, product_id, qty, updated_at)
  select p_shop_id, v_branch.id, p.id, 0, now()
  from public.products p where p.shop_id = p_shop_id
  on conflict (branch_id, product_id) do nothing;

  insert into public.audit_log(shop_id, user_id, action, entity, details)
  values (p_shop_id, v_uid, 'BRANCH_CREATE', 'Branch',
          format('Created branch %s (%s); opening stock starts at zero', v_branch.name, v_branch.code));

  return jsonb_build_object('ok', true, 'branch', to_jsonb(v_branch));
end;
$function$;

revoke all on function public.create_shop_branch(uuid, text, text) from public, anon;
grant execute on function public.create_shop_branch(uuid, text, text) to authenticated;
