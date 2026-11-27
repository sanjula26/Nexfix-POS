-- Require a current, active shop_memberships row for cloud snapshot/device metadata reads.
--
-- pos_shop_members is a legacy compatibility table populated during device
-- registration. It is not kept in sync when canonical shop_memberships rows
-- are deactivated or deleted, so it must not be used as the authorization
-- source for these SELECT policies.
--
-- Compare the UUID membership key as text to the legacy text shop_id column.
-- This avoids casting arbitrary legacy text values to UUID in the policy.

DROP POLICY IF EXISTS pos_shops_select_member ON public.pos_shops;
CREATE POLICY pos_shops_select_member ON public.pos_shops
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.shop_memberships AS sm
    WHERE sm.shop_id::text = pos_shops.shop_id
      AND sm.user_id = (SELECT auth.uid())
      AND sm.active = true
  ));

DROP POLICY IF EXISTS pos_devices_select_member ON public.pos_devices;
CREATE POLICY pos_devices_select_member ON public.pos_devices
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.shop_memberships AS sm
    WHERE sm.shop_id::text = pos_devices.shop_id
      AND sm.user_id = (SELECT auth.uid())
      AND sm.active = true
  ));

DROP POLICY IF EXISTS pos_state_snapshots_select_member ON public.pos_state_snapshots;
CREATE POLICY pos_state_snapshots_select_member ON public.pos_state_snapshots
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.shop_memberships AS sm
    WHERE sm.shop_id::text = pos_state_snapshots.shop_id
      AND sm.user_id = (SELECT auth.uid())
      AND sm.active = true
  ));
