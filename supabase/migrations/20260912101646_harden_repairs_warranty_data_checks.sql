DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repairs_labor_cost_nonnegative') THEN
    ALTER TABLE public.repairs ADD CONSTRAINT repairs_labor_cost_nonnegative CHECK (labor_cost >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repairs_warranty_days_nonnegative') THEN
    ALTER TABLE public.repairs ADD CONSTRAINT repairs_warranty_days_nonnegative CHECK (warranty_days IS NULL OR warranty_days >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repairs_advance_paid_nonnegative') THEN
    ALTER TABLE public.repairs ADD CONSTRAINT repairs_advance_paid_nonnegative CHECK (advance_paid IS NULL OR advance_paid >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repairs_status_valid') THEN
    ALTER TABLE public.repairs ADD CONSTRAINT repairs_status_valid CHECK (status IN ('received','diagnosed','waiting_parts','in_repair','ready','delivered','cancelled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repair_parts_qty_positive') THEN
    ALTER TABLE public.repair_parts ADD CONSTRAINT repair_parts_qty_positive CHECK (qty > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repair_parts_cost_nonnegative') THEN
    ALTER TABLE public.repair_parts ADD CONSTRAINT repair_parts_cost_nonnegative CHECK (cost >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warranty_claims_status_valid') THEN
    ALTER TABLE public.warranty_claims ADD CONSTRAINT warranty_claims_status_valid CHECK (status IN ('open','approved','rejected','replaced','repaired','closed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warranty_claims_issue_nonempty') THEN
    ALTER TABLE public.warranty_claims ADD CONSTRAINT warranty_claims_issue_nonempty CHECK (length(btrim(issue_description)) > 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS warranty_claims_shop_claim_no_unique_nonblank
  ON public.warranty_claims (shop_id, claim_no)
  WHERE NULLIF(btrim(claim_no), '') IS NOT NULL;
