-- Enforce the registered POS device's source-sale branch for returns, reversal requests and trade-ins.
-- Existing transaction accounting functions remain the single source of truth.
-- Public RPCs require the caller's exact registered device ID; no table/column is added.

create or replace function private.assert_pos_device_can_access_sale(
  p_shop_id uuid,
  p_device_id text,
  p_sale_id uuid
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_sale public.sales%rowtype;
  v_sale_branch_id uuid;
  v_active_branch_count integer := 0;
  v_device_branch_id uuid;
  v_has_binding boolean := false;
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;
  if p_shop_id is null or p_sale_id is null
     or nullif(btrim(coalesce(p_device_id, '')), '') is null
     or length(p_device_id) > 200 then
    raise exception 'Shop, sale and valid POS device are required';
  end if;

  -- Check membership before looking up a sale so inactive/non-members cannot
  -- use this function to probe another shop's sale identifiers.
  if not exists (
    select 1
    from public.shop_memberships m
    where m.shop_id = p_shop_id
      and m.user_id = v_uid
      and m.active = true
      and m.role in ('admin', 'manager', 'cashier')
  ) then
    raise exception 'Active shop membership required';
  end if;

  -- Lock the registered device against concurrent ownership transfer/revocation
  -- until the transaction using this authorization has completed.
  perform 1
  from public.pos_devices pd
  where pd.shop_id = p_shop_id::text
    and pd.device_id = btrim(p_device_id)
    and pd.user_id = v_uid
    and pd.revoked_at is null
  for share;
  if not found then
    raise exception 'POS device is not registered to this user for this shop';
  end if;

  -- Lock the source sale so its branch cannot be changed while the guarded
  -- transaction is being prepared and committed.
  select *
    into v_sale
  from public.sales s
  where s.id = p_sale_id
    and s.shop_id = p_shop_id
  for update;
  if not found then
    raise exception 'Sale not found';
  end if;

  v_sale_branch_id := coalesce(
    v_sale.branch_id,
    (
      select b.id
      from public.branches b
      where b.shop_id = p_shop_id
        and b.is_default = true
      limit 1
    )
  );
  if v_sale_branch_id is null then
    raise exception 'Sale branch is not configured';
  end if;

  -- Lock the authoritative active branch row, preventing a concurrent
  -- deactivation from racing the return/trade-in/request operation.
  perform 1
  from public.branches b
  where b.id = v_sale_branch_id
    and b.shop_id = p_shop_id
    and b.active = true
  for share;
  if not found then
    raise exception 'Sale branch is not active in this shop';
  end if;

  select count(*)::integer
    into v_active_branch_count
  from public.branches b
  where b.shop_id = p_shop_id
    and b.active = true;

  -- Lock an existing device-branch assignment so an Admin cannot reassign the
  -- terminal between branch validation and the underlying inventory mutation.
  select d.branch_id
    into v_device_branch_id
  from public.pos_device_branches d
  where d.shop_id = p_shop_id
    and d.device_id = btrim(p_device_id)
  for share;
  v_has_binding := found;

  if v_active_branch_count > 1 then
    if not v_has_binding or v_device_branch_id is distinct from v_sale_branch_id then
      raise exception 'This POS device is not assigned to the sale branch';
    end if;
  elsif v_has_binding and v_device_branch_id is distinct from v_sale_branch_id then
    -- Keep one-branch legacy compatibility only when there is no stale,
    -- conflicting assignment left behind from an earlier branch layout.
    raise exception 'This POS device has a stale branch assignment and is not assigned to the sale branch';
  end if;

  return v_sale_branch_id;
end;
$function$;

create or replace function private.process_sale_return_atomic_for_device_branch(
  p_shop_id uuid,
  p_return_id uuid,
  p_sale_id uuid,
  p_device_id text,
  p_reason text,
  p_mode text,
  p_payment_method text,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
begin
  perform private.assert_pos_device_can_access_sale(p_shop_id, p_device_id, p_sale_id);
  return private.process_sale_return_atomic(
    p_shop_id, p_return_id, p_sale_id, p_reason, p_mode, p_payment_method, p_lines
  );
end;
$function$;

create or replace function private.register_trade_in_atomic_for_device_branch(
  p_shop_id uuid,
  p_device_id text,
  p_sale_id uuid,
  p_unit_id uuid,
  p_product_id uuid,
  p_value numeric,
  p_imei text,
  p_serial text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
begin
  perform private.assert_pos_device_can_access_sale(p_shop_id, p_device_id, p_sale_id);
  return private.register_trade_in_atomic(
    p_shop_id, p_sale_id, p_unit_id, p_product_id, p_value, p_imei, p_serial
  );
end;
$function$;

create or replace function private.request_sale_reversal_for_device_branch(
  p_shop_id uuid,
  p_request_id uuid,
  p_sale_id uuid,
  p_device_id text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
begin
  perform private.assert_pos_device_can_access_sale(p_shop_id, p_device_id, p_sale_id);
  return private.request_sale_reversal(p_shop_id, p_request_id, p_sale_id, p_reason);
end;
$function$;

-- New public entry points keep the Data API boundary SECURITY INVOKER while
-- the narrowly scoped private wrappers perform the protected transaction.
create or replace function public.process_sale_return_atomic_for_device_branch(
  p_shop_id uuid,
  p_return_id uuid,
  p_sale_id uuid,
  p_device_id text,
  p_reason text,
  p_mode text,
  p_payment_method text,
  p_lines jsonb
)
returns jsonb
language sql
security invoker
set search_path to ''
as $wrapper$
  select private.process_sale_return_atomic_for_device_branch(
    p_shop_id, p_return_id, p_sale_id, p_device_id, p_reason, p_mode, p_payment_method, p_lines
  );
$wrapper$;

create or replace function public.register_trade_in_atomic_for_device_branch(
  p_shop_id uuid,
  p_device_id text,
  p_sale_id uuid,
  p_unit_id uuid,
  p_product_id uuid,
  p_value numeric,
  p_imei text,
  p_serial text
)
returns jsonb
language sql
security invoker
set search_path to ''
as $wrapper$
  select private.register_trade_in_atomic_for_device_branch(
    p_shop_id, p_device_id, p_sale_id, p_unit_id, p_product_id, p_value, p_imei, p_serial
  );
$wrapper$;

create or replace function public.request_sale_reversal_for_device_branch(
  p_shop_id uuid,
  p_request_id uuid,
  p_sale_id uuid,
  p_device_id text,
  p_reason text
)
returns jsonb
language sql
security invoker
set search_path to ''
as $wrapper$
  select private.request_sale_reversal_for_device_branch(
    p_shop_id, p_request_id, p_sale_id, p_device_id, p_reason
  );
$wrapper$;

-- Old public signatures cannot prove which registered terminal made the call.
-- Keep them callable only to return an explicit upgrade error, never to mutate.
create or replace function public.process_sale_return_atomic(
  p_shop_id uuid,
  p_return_id uuid,
  p_sale_id uuid,
  p_reason text,
  p_mode text,
  p_payment_method text,
  p_lines jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $legacy$
begin
  raise exception 'This Nexfix POS client is outdated. Update the POS before processing a Cloud sale return.';
end;
$legacy$;

create or replace function public.register_trade_in_atomic(
  p_shop_id uuid,
  p_sale_id uuid,
  p_unit_id uuid,
  p_product_id uuid,
  p_value numeric,
  p_imei text default null,
  p_serial text default null
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $legacy$
begin
  raise exception 'This Nexfix POS client is outdated. Update the POS before registering a Cloud trade-in.';
end;
$legacy$;

create or replace function public.request_sale_reversal(
  p_shop_id uuid,
  p_request_id uuid,
  p_sale_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $legacy$
begin
  raise exception 'This Nexfix POS client is outdated. Update the POS before requesting a Cloud bill reversal.';
end;
$legacy$;

-- Only the guarded wrappers may reach the old accounting implementations.
revoke all on function private.assert_pos_device_can_access_sale(uuid, text, uuid)
  from public, anon, authenticated;
revoke all on function private.process_sale_return_atomic_for_device_branch(uuid, uuid, uuid, text, text, text, text, jsonb)
  from public, anon;
revoke all on function private.register_trade_in_atomic_for_device_branch(uuid, text, uuid, uuid, uuid, numeric, text, text)
  from public, anon;
revoke all on function private.request_sale_reversal_for_device_branch(uuid, uuid, uuid, text, text)
  from public, anon;

revoke all on function private.process_sale_return_atomic(uuid, uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function private.register_trade_in_atomic(uuid, uuid, uuid, uuid, numeric, text, text)
  from public, anon, authenticated;
revoke all on function private.request_sale_reversal(uuid, uuid, uuid, text)
  from public, anon, authenticated;

-- Existing clients without p_device_id are denied a mutation path. They receive
-- the explicit upgrade message from the old public signatures above.
revoke all on function public.process_sale_return_atomic(uuid, uuid, uuid, text, text, text, jsonb)
  from public, anon;
revoke all on function public.register_trade_in_atomic(uuid, uuid, uuid, uuid, numeric, text, text)
  from public, anon;
revoke all on function public.request_sale_reversal(uuid, uuid, uuid, text)
  from public, anon;

revoke all on function public.process_sale_return_atomic_for_device_branch(uuid, uuid, uuid, text, text, text, text, jsonb)
  from public, anon;
revoke all on function public.register_trade_in_atomic_for_device_branch(uuid, text, uuid, uuid, uuid, numeric, text, text)
  from public, anon;
revoke all on function public.request_sale_reversal_for_device_branch(uuid, uuid, uuid, text, text)
  from public, anon;

grant usage on schema private to authenticated;

grant execute on function private.process_sale_return_atomic_for_device_branch(uuid, uuid, uuid, text, text, text, text, jsonb)
  to authenticated;
grant execute on function private.register_trade_in_atomic_for_device_branch(uuid, text, uuid, uuid, uuid, numeric, text, text)
  to authenticated;
grant execute on function private.request_sale_reversal_for_device_branch(uuid, uuid, uuid, text, text)
  to authenticated;

grant execute on function public.process_sale_return_atomic_for_device_branch(uuid, uuid, uuid, text, text, text, text, jsonb)
  to authenticated;
grant execute on function public.register_trade_in_atomic_for_device_branch(uuid, text, uuid, uuid, uuid, numeric, text, text)
  to authenticated;
grant execute on function public.request_sale_reversal_for_device_branch(uuid, uuid, uuid, text, text)
  to authenticated;


-- Read-side resolver guards: bill lookup and item/IMEI resolution must not
-- reveal another branch's Sale before the later atomic return RPC is called.
-- These wrappers reuse the same source-sale/device/branch authorization helper.

create or replace function private.resolve_sale_return_target_for_device_branch(
  p_bill_no text,
  p_device_id text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_result jsonb;
  v_shop_id uuid;
  v_sale_id uuid;
begin
  v_result := private.resolve_sale_return_target(p_bill_no);
  if coalesce((v_result ->> 'ok')::boolean, false) is not true then
    return v_result;
  end if;

  v_shop_id := nullif(v_result ->> 'shop_id', '')::uuid;
  v_sale_id := nullif(v_result ->> 'sale_id', '')::uuid;
  perform private.assert_pos_device_can_access_sale(v_shop_id, p_device_id, v_sale_id);
  return v_result;
end;
$function$;

create or replace function private.resolve_sale_return_items_for_device_branch(
  p_shop_id uuid,
  p_sale_id uuid,
  p_device_id text,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
begin
  perform private.assert_pos_device_can_access_sale(p_shop_id, p_device_id, p_sale_id);
  return private.resolve_sale_return_items(p_shop_id, p_sale_id, p_lines);
end;
$function$;

create or replace function public.resolve_sale_return_target_for_device_branch(
  p_bill_no text,
  p_device_id text
)
returns jsonb
language sql
security invoker
set search_path to ''
as $wrapper$
  select private.resolve_sale_return_target_for_device_branch(p_bill_no, p_device_id);
$wrapper$;

create or replace function public.resolve_sale_return_items_for_device_branch(
  p_shop_id uuid,
  p_sale_id uuid,
  p_device_id text,
  p_lines jsonb
)
returns jsonb
language sql
security invoker
set search_path to ''
as $wrapper$
  select private.resolve_sale_return_items_for_device_branch(p_shop_id, p_sale_id, p_device_id, p_lines);
$wrapper$;

-- Old resolver entry points cannot prove the calling terminal's branch.
-- Preserve the old signatures only as upgrade notices, never as data-returning RPCs.
create or replace function public.resolve_sale_return_target(p_bill_no text)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $legacy$
begin
  raise exception 'This Nexfix POS client is outdated. Update the POS before looking up a Cloud return bill.';
end;
$legacy$;

create or replace function public.resolve_sale_return_items(
  p_shop_id uuid,
  p_sale_id uuid,
  p_lines jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $legacy$
begin
  raise exception 'This Nexfix POS client is outdated. Update the POS before looking up Cloud return items.';
end;
$legacy$;

-- Existing private resolvers remain reachable only from the guarded wrappers.
revoke all on function private.resolve_sale_return_target(text)
  from public, anon, authenticated;
revoke all on function private.resolve_sale_return_items(uuid, uuid, jsonb)
  from public, anon, authenticated;

revoke all on function private.resolve_sale_return_target_for_device_branch(text, text)
  from public, anon;
revoke all on function private.resolve_sale_return_items_for_device_branch(uuid, uuid, text, jsonb)
  from public, anon;

revoke all on function public.resolve_sale_return_target_for_device_branch(text, text)
  from public, anon;
revoke all on function public.resolve_sale_return_items_for_device_branch(uuid, uuid, text, jsonb)
  from public, anon;

revoke all on function public.resolve_sale_return_target(text)
  from public, anon;
revoke all on function public.resolve_sale_return_items(uuid, uuid, jsonb)
  from public, anon;

grant usage on schema private to authenticated;
grant execute on function private.resolve_sale_return_target_for_device_branch(text, text)
  to authenticated;
grant execute on function private.resolve_sale_return_items_for_device_branch(uuid, uuid, text, jsonb)
  to authenticated;

grant execute on function public.resolve_sale_return_target_for_device_branch(text, text)
  to authenticated;
grant execute on function public.resolve_sale_return_items_for_device_branch(uuid, uuid, text, jsonb)
  to authenticated;

-- Old public signatures remain callable solely so older installed clients
-- receive a clear upgrade message instead of a generic missing-function error.
grant execute on function public.resolve_sale_return_target(text)
  to authenticated;
grant execute on function public.resolve_sale_return_items(uuid, uuid, jsonb)
  to authenticated;


-- Reversal request lists are loaded into every authenticated POS session.
-- Return only the rows visible to the current terminal's branch. A cloud Admin
-- remains the shop-wide reviewer; other shop roles are limited to their branch.

create or replace function private.list_sale_reversal_requests_for_device_branch(
  p_shop_id uuid,
  p_device_id text
)
returns setof jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_active_branch_count integer := 0;
  v_branch_id uuid;
  v_device_branch_id uuid;
  v_has_binding boolean := false;
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;
  if p_shop_id is null
     or nullif(btrim(coalesce(p_device_id, '')), '') is null
     or length(p_device_id) > 200 then
    raise exception 'Shop and valid POS device are required';
  end if;

  select m.role
    into v_role
  from public.shop_memberships m
  where m.shop_id = p_shop_id
    and m.user_id = v_uid
    and m.active = true
  limit 1;
  if v_role is null then
    raise exception 'Active shop membership required';
  end if;

  perform 1
  from public.pos_devices pd
  where pd.shop_id = p_shop_id::text
    and pd.device_id = btrim(p_device_id)
    and pd.user_id = v_uid
    and pd.revoked_at is null
  for share;
  if not found then
    raise exception 'POS device is not registered to this user for this shop';
  end if;

  select count(*)::integer
    into v_active_branch_count
  from public.branches b
  where b.shop_id = p_shop_id
    and b.active = true;
  if v_active_branch_count = 0 then
    raise exception 'Shop has no active branch';
  end if;

  if v_role <> 'admin' then
    select d.branch_id
      into v_device_branch_id
    from public.pos_device_branches d
    where d.shop_id = p_shop_id
      and d.device_id = btrim(p_device_id)
    for share;
    v_has_binding := found;

    if v_active_branch_count > 1 then
      if not v_has_binding then
        raise exception 'This POS device is not assigned to an active branch';
      end if;
      v_branch_id := v_device_branch_id;
    else
      select b.id
        into v_branch_id
      from public.branches b
      where b.shop_id = p_shop_id
        and b.active = true
      limit 1
      for share;
      if v_has_binding and v_device_branch_id is distinct from v_branch_id then
        raise exception 'This POS device has a stale branch assignment';
      end if;
    end if;

    perform 1
    from public.branches b
    where b.id = v_branch_id
      and b.shop_id = p_shop_id
      and b.active = true
    for share;
    if not found then
      raise exception 'Assigned POS branch is not active in this shop';
    end if;
  end if;

  return query
  select jsonb_build_object(
    'id', r.id,
    'saleId', r.sale_id,
    'billNo', r.bill_no,
    'reason', r.reason,
    'requestedBy', coalesce(p.full_name, au.email, r.requested_by::text),
    'requestedAt', r.requested_at,
    'status', r.status,
    'reviewedBy', r.reviewed_by::text,
    'reviewedAt', r.reviewed_at,
    'reviewNote', r.review_note
  )
  from public.sale_reversal_requests r
  join public.sales s
    on s.id = r.sale_id
   and s.shop_id = r.shop_id
  left join public.profiles p on p.id = r.requested_by
  left join auth.users au on au.id = r.requested_by
  where r.shop_id = p_shop_id
    and (v_role = 'admin' or s.branch_id = v_branch_id)
  order by r.requested_at desc
  limit 200;
end;
$function$;

create or replace function public.list_sale_reversal_requests_for_device_branch(
  p_shop_id uuid,
  p_device_id text
)
returns setof jsonb
language sql
security invoker
set search_path to ''
as $wrapper$
  select * from private.list_sale_reversal_requests_for_device_branch(p_shop_id, p_device_id);
$wrapper$;

-- The original shop-wide list has no terminal identity. Keep it as an upgrade
-- notice so an old client cannot silently load another branch's reversal queue.
create or replace function public.list_sale_reversal_requests(p_shop_id uuid)
returns setof jsonb
language plpgsql
security invoker
set search_path to ''
as $legacy$
begin
  raise exception 'This Nexfix POS client is outdated. Update the POS before loading Cloud bill reversal requests.';
end;
$legacy$;

revoke all on function private.list_sale_reversal_requests(uuid)
  from public, anon, authenticated;
revoke all on function public.list_sale_reversal_requests_for_device_branch(uuid, text)
  from public, anon;
revoke all on function private.list_sale_reversal_requests_for_device_branch(uuid, text)
  from public, anon;

revoke all on function public.list_sale_reversal_requests(uuid)
  from public, anon;

grant usage on schema private to authenticated;
grant execute on function private.list_sale_reversal_requests_for_device_branch(uuid, text)
  to authenticated;
grant execute on function public.list_sale_reversal_requests_for_device_branch(uuid, text)
  to authenticated;

-- Old public list remains executable only to produce its explicit upgrade message.
grant execute on function public.list_sale_reversal_requests(uuid)
  to authenticated;


-- Ensure Supabase/PostgREST discovers the newly created guarded RPC signatures.
notify pgrst, 'reload schema';
