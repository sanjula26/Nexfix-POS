export type BranchStockEditValidationInput = {
  expectedShopId: string | null;
  expectedBranchId: string | null;
  selectedShopId: string;
  selectedBranchId: string;
  expectedQuantity: number | null;
  nextQuantity: number;
  maxDelta?: number;
};

export type BranchStockEditValidation =
  | { ok: true; delta: number }
  | { ok: false; error: string };

/** Validate a branch-scoped stock edit before saving product details or stock. */
export function validateBranchStockEdit(input: BranchStockEditValidationInput): BranchStockEditValidation {
  if (input.expectedBranchId !== input.selectedBranchId || input.expectedShopId !== input.selectedShopId) {
    return { ok: false, error: 'The selected shop or branch changed while this editor was open. Close and reopen the product editor to verify the correct branch quantity.' };
  }
  if (input.expectedQuantity === null || !Number.isSafeInteger(input.expectedQuantity) || input.expectedQuantity < 0) {
    return { ok: false, error: 'The original branch quantity is unavailable. Close and reopen the product editor to reload it.' };
  }
  if (!Number.isSafeInteger(input.nextQuantity) || input.nextQuantity < 0) {
    return { ok: false, error: 'Stock must be a non-negative whole number.' };
  }
  const delta = input.nextQuantity - input.expectedQuantity;
  const maxDelta = input.maxDelta ?? 1_000_000;
  if (!Number.isSafeInteger(maxDelta) || maxDelta < 0 || Math.abs(delta) > maxDelta) {
    return { ok: false, error: 'A single stock adjustment cannot exceed 1,000,000 units. Enter a smaller change.' };
  }
  return { ok: true, delta };
}

/** Use compare-and-set only for a verified online cloud quantity; preserve local/offline delta queue behavior. */
export function getExpectedBranchQtyForStockAdjustment(
  shopId: string,
  offline: boolean,
  quantity: number | null,
): number | undefined {
  if (!shopId.trim() || offline) return undefined;
  // For an online cloud shop, an invalid baseline must fail closed in adjustStock;
  // returning undefined here would select the legacy non-CAS RPC.
  if (quantity === null || !Number.isSafeInteger(quantity) || quantity < 0) return -1;
  return quantity;
}
