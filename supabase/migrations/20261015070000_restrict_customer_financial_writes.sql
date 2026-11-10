-- Customer balances and loyalty points are financial state. Clients must not
-- change them directly; trusted transaction RPCs own those mutations.
--
-- Revoke every default table privilege first. Revoking only INSERT/UPDATE
-- would leave default TRUNCATE, REFERENCES and TRIGGER grants available.
REVOKE ALL PRIVILEGES ON TABLE public.customers FROM PUBLIC, anon, authenticated;

-- Restore only the operations used by the authenticated POS client.
GRANT SELECT, DELETE ON TABLE public.customers TO authenticated;

-- Customer creation may set identity/contact and credit-limit metadata only.
GRANT INSERT (
  id, shop_id, name, phone, email, nic, address, credit_limit, notes, created_at, updated_at
) ON TABLE public.customers TO authenticated;

-- Customer edits may update metadata only; credit_balance and loyalty_points
-- are intentionally excluded and remain writable only through trusted RPCs.
GRANT UPDATE (
  name, phone, email, nic, address, credit_limit, notes, updated_at
) ON TABLE public.customers TO authenticated;
