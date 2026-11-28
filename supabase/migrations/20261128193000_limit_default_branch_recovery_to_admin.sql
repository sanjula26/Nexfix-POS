-- A branch-list read path calls ensure_default_branch for all Cloud members.
-- Non-admin members must not reactivate/create branch metadata as a side effect.
-- Keep this RPC readable for staff when an active branch exists, but reserve
-- recovery/creation of Main for Cloud Admin/Manager memberships.

create or replace function public.ensure_default_branch(p_shop_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_branch public.branches%rowtype;
  v_active_count integer := 0;
begin
  if v_uid is null then
    raise exception using errcode = '28000',
      message = 'Cloud sign-in required to load or create the Main branch';
  end if;

  if p_shop_id is null then
    raise exception using errcode = '42501',
      message = 'No active shop membership for this Cloud account';
  end if;

  select m.role into v_role
  from public.shop_memberships m
  where m.shop_id = p_shop_id
    and m.user_id = v_uid
    and m.active = true
  limit 1;

  if v_role is null then
    raise exception using errcode = '42501',
      message = 'No active shop membership for this Cloud account';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_shop_id::text, 0));

  select count(*) into v_active_count
  from public.branches b
  where b.shop_id = p_shop_id
    and b.active = true;

  -- Settings loads the branch list for all active Cloud members. For a
  -- non-admin member this routine is strictly read-only: it returns an
  -- already-active branch and never reactivates a retired/default branch or
  -- creates a replacement Main branch.
  if v_role not in ('admin', 'manager') then
    select b.* into v_branch
    from public.branches b
    where b.shop_id = p_shop_id
      and b.active = true
    order by b.is_default desc, b.created_at, b.id
    limit 1
    for share;

    if not found then
      raise exception using errcode = '42501',
        message = 'No active branch is configured. Ask a Cloud Admin or Manager to restore the Main branch.';
    end if;

    return jsonb_build_object(
      'ok', true,
      'branch', to_jsonb(v_branch),
      'read_only', true
    );
  end if;

  -- Admin/Manager recovery retains the existing Main-branch behavior.
  select b.* into v_branch
  from public.branches b
  where b.shop_id = p_shop_id
    and b.is_default = true
  for update;

  if found then
    update public.branches
    set active = true, updated_at = now()
    where id = v_branch.id and shop_id = p_shop_id
    returning * into v_branch;
  else
    select b.* into v_branch
    from public.branches b
    where b.shop_id = p_shop_id
      and upper(b.code) = 'MAIN'
    for update;

    if found then
      update public.branches
      set active = true, is_default = true, updated_at = now()
      where id = v_branch.id and shop_id = p_shop_id
      returning * into v_branch;
    else
      insert into public.branches(
        shop_id, name, code, active, is_default, created_at, updated_at
      )
      values (
        p_shop_id, 'Main', 'MAIN', true, true, now(), now()
      )
      returning * into v_branch;
    end if;
  end if;

  -- Recover legacy product stock only if there were no active branches.
  -- Existing branch balances are never copied or duplicated.
  insert into public.branch_stock(shop_id, branch_id, product_id, qty, updated_at)
  select p_shop_id, v_branch.id, p.id,
         case when v_active_count = 0 then p.stock else 0 end, now()
  from public.products p
  where p.shop_id = p_shop_id
  on conflict (branch_id, product_id) do nothing;

  return jsonb_build_object(
    'ok', true,
    'branch', to_jsonb(v_branch),
    'read_only', false
  );
end;
$function$;

revoke all on function public.ensure_default_branch(uuid) from public, anon;
grant execute on function public.ensure_default_branch(uuid) to authenticated;
