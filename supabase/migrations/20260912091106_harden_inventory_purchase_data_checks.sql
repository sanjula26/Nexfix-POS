DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_units_cost_nonnegative') THEN
    ALTER TABLE public.inventory_units ADD CONSTRAINT inventory_units_cost_nonnegative CHECK (cost IS NULL OR cost >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_units_warranty_months_nonnegative') THEN
    ALTER TABLE public.inventory_units ADD CONSTRAINT inventory_units_warranty_months_nonnegative CHECK (warranty_months IS NULL OR warranty_months >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_items_qty_ordered_positive') THEN
    ALTER TABLE public.purchase_items ADD CONSTRAINT purchase_items_qty_ordered_positive CHECK (qty_ordered > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_items_qty_received_nonnegative') THEN
    ALTER TABLE public.purchase_items ADD CONSTRAINT purchase_items_qty_received_nonnegative CHECK (qty_received IS NULL OR qty_received >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_items_cost_nonnegative') THEN
    ALTER TABLE public.purchase_items ADD CONSTRAINT purchase_items_cost_nonnegative CHECK (cost >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_total_nonnegative') THEN
    ALTER TABLE public.purchases ADD CONSTRAINT purchase_total_nonnegative CHECK (total IS NULL OR total >= 0);
  END IF;
END $$;
