-- Require the GRN wrapper's device ID to belong to the authenticated user,
-- not merely to have a branch assignment. The inner GRN function also validates
-- this registration; keeping the check at the branch boundary prevents device-ID
-- spoofing from selecting another branch.
CREATE OR REPLACE FUNCTION public.receive_purchase_atomic_for_device_branch(p_shop_id uuid, p_branch_id uuid, p_device_id text, p_purchase_id uuid, p_purchase jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_branch_count integer; v_binding uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not exists(select 1 from public.shop_memberships m where m.shop_id=p_shop_id and m.user_id=auth.uid() and m.active and m.role in ('admin','manager','inventory_manager')) then
    raise exception 'User is not authorized to receive GRNs';
  end if;
  if not exists (
    select 1 from public.pos_devices pd
    where pd.shop_id=p_shop_id::text
      and pd.device_id=btrim(coalesce(p_device_id,''))
      and pd.user_id=auth.uid()
      and pd.revoked_at is null
  ) then
    raise exception 'POS device is not registered to this user for this shop';
  end if;
  select count(*) into v_branch_count from public.branches b where b.shop_id=p_shop_id and b.active;
  if v_branch_count > 1 then
    select d.branch_id into v_binding from public.pos_device_branches d
    where d.shop_id=p_shop_id and d.device_id=btrim(coalesce(p_device_id,'')) limit 1;
    if v_binding is null or v_binding<>p_branch_id then
      raise exception 'This POS device is not assigned to the selected branch. Ask the shop admin to assign this PC to an active branch.';
    end if;
  end if;
  return public.receive_purchase_atomic_for_branch(p_shop_id,p_branch_id,p_purchase_id,p_device_id,p_purchase);
end;
$function$;
