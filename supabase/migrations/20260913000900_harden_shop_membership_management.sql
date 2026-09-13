-- Memberships control who can access a shop. Members may only read their
-- own membership (or memberships visible to an active shop admin/manager).
-- Membership creation, role changes, activation and deletion are intentionally
-- denied to direct authenticated clients until a dedicated server-side
-- membership-management function exists.

DROP POLICY IF EXISTS "members read own" ON public.shop_memberships;
DROP POLICY IF EXISTS "members read self or admin" ON public.shop_memberships;
DROP POLICY IF EXISTS "members admin manage" ON public.shop_memberships;

CREATE POLICY "members read self or admin"
ON public.shop_memberships
FOR SELECT
TO authenticated
USING (
  user_id = auth.uid()
  OR private.is_shop_admin(shop_id)
);
