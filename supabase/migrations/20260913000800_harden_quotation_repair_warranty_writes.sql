-- Preserve operational member access for creating/updating quotations, repairs,
-- repair parts and warranty claims, but prevent ordinary staff from deleting
-- business records. Shop admins/managers retain full write control.

DROP POLICY IF EXISTS "quotations member access" ON public.quotations;
CREATE POLICY "quotations member read"
ON public.quotations FOR SELECT TO authenticated
USING (private.is_shop_member(shop_id));
CREATE POLICY "quotations member insert"
ON public.quotations FOR INSERT TO authenticated
WITH CHECK (private.is_shop_member(shop_id));
CREATE POLICY "quotations member update"
ON public.quotations FOR UPDATE TO authenticated
USING (private.is_shop_member(shop_id))
WITH CHECK (private.is_shop_member(shop_id));
CREATE POLICY "quotations manager delete"
ON public.quotations FOR DELETE TO authenticated
USING (private.is_shop_admin(shop_id));

DROP POLICY IF EXISTS "quotation items member access" ON public.quotation_items;
CREATE POLICY "quotation items member read"
ON public.quotation_items FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.quotations q WHERE q.id=quotation_items.quotation_id AND private.is_shop_member(q.shop_id)));
CREATE POLICY "quotation items member insert"
ON public.quotation_items FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.quotations q WHERE q.id=quotation_items.quotation_id AND private.is_shop_member(q.shop_id)));
CREATE POLICY "quotation items member update"
ON public.quotation_items FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.quotations q WHERE q.id=quotation_items.quotation_id AND private.is_shop_member(q.shop_id)))
WITH CHECK (EXISTS (SELECT 1 FROM public.quotations q WHERE q.id=quotation_items.quotation_id AND private.is_shop_member(q.shop_id)));
CREATE POLICY "quotation items manager delete"
ON public.quotation_items FOR DELETE TO authenticated
USING (EXISTS (SELECT 1 FROM public.quotations q WHERE q.id=quotation_items.quotation_id AND private.is_shop_admin(q.shop_id)));

DROP POLICY IF EXISTS "repairs member access" ON public.repairs;
CREATE POLICY "repairs member read"
ON public.repairs FOR SELECT TO authenticated
USING (private.is_shop_member(shop_id));
CREATE POLICY "repairs member insert"
ON public.repairs FOR INSERT TO authenticated
WITH CHECK (private.is_shop_member(shop_id));
CREATE POLICY "repairs member update"
ON public.repairs FOR UPDATE TO authenticated
USING (private.is_shop_member(shop_id))
WITH CHECK (private.is_shop_member(shop_id));
CREATE POLICY "repairs manager delete"
ON public.repairs FOR DELETE TO authenticated
USING (private.is_shop_admin(shop_id));

DROP POLICY IF EXISTS "repair parts member access" ON public.repair_parts;
CREATE POLICY "repair parts member read"
ON public.repair_parts FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.repairs r WHERE r.id=repair_parts.repair_id AND private.is_shop_member(r.shop_id)));
CREATE POLICY "repair parts member insert"
ON public.repair_parts FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.repairs r WHERE r.id=repair_parts.repair_id AND private.is_shop_member(r.shop_id)));
CREATE POLICY "repair parts member update"
ON public.repair_parts FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.repairs r WHERE r.id=repair_parts.repair_id AND private.is_shop_member(r.shop_id)))
WITH CHECK (EXISTS (SELECT 1 FROM public.repairs r WHERE r.id=repair_parts.repair_id AND private.is_shop_member(r.shop_id)));
CREATE POLICY "repair parts manager delete"
ON public.repair_parts FOR DELETE TO authenticated
USING (EXISTS (SELECT 1 FROM public.repairs r WHERE r.id=repair_parts.repair_id AND private.is_shop_admin(r.shop_id)));

DROP POLICY IF EXISTS "warranty member access" ON public.warranty_claims;
CREATE POLICY "warranty member read"
ON public.warranty_claims FOR SELECT TO authenticated
USING (private.is_shop_member(shop_id));
CREATE POLICY "warranty member insert"
ON public.warranty_claims FOR INSERT TO authenticated
WITH CHECK (private.is_shop_member(shop_id));
CREATE POLICY "warranty member update"
ON public.warranty_claims FOR UPDATE TO authenticated
USING (private.is_shop_member(shop_id))
WITH CHECK (private.is_shop_member(shop_id));
CREATE POLICY "warranty manager delete"
ON public.warranty_claims FOR DELETE TO authenticated
USING (private.is_shop_admin(shop_id));
