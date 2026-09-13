-- Consolidate day_sessions UPDATE policies to avoid multiple permissive policies.
-- Authorization semantics remain: shop admins may update; members may update their own cashier session.

DROP POLICY IF EXISTS "sessions manager update" ON public.day_sessions;
DROP POLICY IF EXISTS "sessions self update" ON public.day_sessions;

CREATE POLICY "sessions member or manager update"
ON public.day_sessions
FOR UPDATE
TO authenticated
USING (
  private.is_shop_admin(shop_id)
  OR (
    private.is_shop_member(shop_id)
    AND cashier_id = (SELECT auth.uid())
  )
)
WITH CHECK (
  private.is_shop_admin(shop_id)
  OR (
    private.is_shop_member(shop_id)
    AND cashier_id = (SELECT auth.uid())
  )
);
