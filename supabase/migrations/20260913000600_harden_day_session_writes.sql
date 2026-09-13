-- Day sessions are operational cash-drawer records.
-- Members may read sessions in their shop. A user may create/update their own
-- session; shop admins/managers may manage sessions for other staff.
-- There is no client-side delete path for day sessions, so deletes are denied.

DROP POLICY IF EXISTS "sessions member access" ON public.day_sessions;
DROP POLICY IF EXISTS "sessions member read" ON public.day_sessions;
DROP POLICY IF EXISTS "sessions self insert" ON public.day_sessions;
DROP POLICY IF EXISTS "sessions self update" ON public.day_sessions;
DROP POLICY IF EXISTS "sessions manager update" ON public.day_sessions;

CREATE POLICY "sessions member read"
ON public.day_sessions
FOR SELECT
TO authenticated
USING (private.is_shop_member(shop_id));

CREATE POLICY "sessions self insert"
ON public.day_sessions
FOR INSERT
TO authenticated
WITH CHECK (
  private.is_shop_member(shop_id)
  AND (
    cashier_id = auth.uid()
    OR private.is_shop_admin(shop_id)
  )
  AND EXISTS (
    SELECT 1
    FROM public.shop_memberships m
    WHERE m.user_id = day_sessions.cashier_id
      AND m.shop_id = day_sessions.shop_id
      AND m.active = true
  )
);

CREATE POLICY "sessions self update"
ON public.day_sessions
FOR UPDATE
TO authenticated
USING (
  private.is_shop_member(shop_id)
  AND cashier_id = auth.uid()
)
WITH CHECK (
  private.is_shop_member(shop_id)
  AND cashier_id = auth.uid()
);

CREATE POLICY "sessions manager update"
ON public.day_sessions
FOR UPDATE
TO authenticated
USING (private.is_shop_admin(shop_id))
WITH CHECK (private.is_shop_admin(shop_id));
