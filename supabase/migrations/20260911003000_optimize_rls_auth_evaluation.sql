-- Nexfix POS: avoid per-row re-evaluation of auth.uid() in RLS policies.
-- The deployed cloud-sync schema uses user_id on pos_devices and direct
-- membership EXISTS checks; keep that schema unchanged while enabling initplans.

-- Cloud-sync policies
DROP POLICY IF EXISTS pos_shops_select_member ON public.pos_shops;
CREATE POLICY pos_shops_select_member ON public.pos_shops
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.pos_shop_members m
    WHERE m.shop_id = pos_shops.shop_id
      AND m.user_id = (SELECT auth.uid())
  ));

DROP POLICY IF EXISTS pos_shop_members_select_self ON public.pos_shop_members;
CREATE POLICY pos_shop_members_select_self ON public.pos_shop_members
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS pos_devices_select_member ON public.pos_devices;
CREATE POLICY pos_devices_select_member ON public.pos_devices
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.pos_shop_members m
    WHERE m.shop_id = pos_devices.shop_id
      AND m.user_id = (SELECT auth.uid())
  ));

DROP POLICY IF EXISTS pos_state_snapshots_select_member ON public.pos_state_snapshots;
CREATE POLICY pos_state_snapshots_select_member ON public.pos_state_snapshots
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.pos_shop_members m
    WHERE m.shop_id = pos_state_snapshots.shop_id
      AND m.user_id = (SELECT auth.uid())
  ));

-- Main application membership policies
DROP POLICY IF EXISTS "members read own" ON public.shop_memberships;
CREATE POLICY "members read own" ON public.shop_memberships
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR (SELECT public.is_shop_admin(shop_id))
  );

DROP POLICY IF EXISTS "profile self read" ON public.profiles;
CREATE POLICY "profile self read" ON public.profiles
  FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "profile shop admin read" ON public.profiles;
CREATE POLICY "profile shop admin read" ON public.profiles
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.shop_memberships m
    WHERE m.user_id = profiles.id
      AND (SELECT public.is_shop_admin(m.shop_id))
  ));

DROP POLICY IF EXISTS "profile self update" ON public.profiles;
CREATE POLICY "profile self update" ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "audit member insert" ON public.audit_log;
CREATE POLICY "audit member insert" ON public.audit_log
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.is_shop_member(shop_id))
    AND (user_id IS NULL OR user_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "audit member read" ON public.audit_log;
CREATE POLICY "audit member read" ON public.audit_log
  FOR SELECT TO authenticated
  USING ((SELECT public.is_shop_member(shop_id)));
