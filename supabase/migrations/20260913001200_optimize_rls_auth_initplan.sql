-- Optimize auth.uid() evaluation in RLS policies.
-- Keep authorization semantics unchanged; evaluate auth.uid() once per statement.

DROP POLICY IF EXISTS "sessions self insert" ON public.day_sessions;
CREATE POLICY "sessions self insert"
ON public.day_sessions
FOR INSERT
TO authenticated
WITH CHECK (
  private.is_shop_member(shop_id)
  AND ((cashier_id = (SELECT auth.uid())) OR private.is_shop_admin(shop_id))
  AND EXISTS (
    SELECT 1
    FROM public.shop_memberships m
    WHERE m.user_id = day_sessions.cashier_id
      AND m.shop_id = day_sessions.shop_id
      AND m.active = true
  )
);

DROP POLICY IF EXISTS "sessions self update" ON public.day_sessions;
CREATE POLICY "sessions self update"
ON public.day_sessions
FOR UPDATE
TO authenticated
USING (
  private.is_shop_member(shop_id)
  AND cashier_id = (SELECT auth.uid())
)
WITH CHECK (
  private.is_shop_member(shop_id)
  AND cashier_id = (SELECT auth.uid())
);

DROP POLICY IF EXISTS "members read self or admin" ON public.shop_memberships;
CREATE POLICY "members read self or admin"
ON public.shop_memberships
FOR SELECT
TO authenticated
USING (
  (user_id = (SELECT auth.uid()))
  OR private.is_shop_admin(shop_id)
);
