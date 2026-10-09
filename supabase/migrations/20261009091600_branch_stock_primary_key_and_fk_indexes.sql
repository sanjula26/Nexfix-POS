-- Phase 2: make branch stock identity explicit and index audit foreign keys.
-- This is additive and idempotent so it is safe on installations where the
-- branch model has already been applied through the connected migration runner.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.branch_stock'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE public.branch_stock
      DROP CONSTRAINT IF EXISTS branch_stock_branch_product_unique;
    ALTER TABLE public.branch_stock
      ADD CONSTRAINT branch_stock_pkey PRIMARY KEY (branch_id, product_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_branch_stock_adjustments_created_by
  ON public.branch_stock_adjustments (created_by);

CREATE INDEX IF NOT EXISTS idx_branch_stock_adjustments_shop_product
  ON public.branch_stock_adjustments (shop_id, product_id);

CREATE INDEX IF NOT EXISTS idx_pos_device_branches_assigned_by
  ON public.pos_device_branches (assigned_by);
