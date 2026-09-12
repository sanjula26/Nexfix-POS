import type { InventoryUnit, Product, Purchase } from './types';

export interface PurchaseReceivePlan {
  productStockDelta: Map<string, number>;
  productCost: Map<string, number>;
  trackedUnitCount: Map<string, number>;
}

/**
 * Builds a deterministic receive plan from every purchase line.
 * Purchase creation rejects duplicate product lines, so the store-layer
 * receive path must reject them too rather than silently choosing one cost.
 */
export function buildPurchaseReceivePlan(po: Purchase, products: readonly Product[]): PurchaseReceivePlan | null {
  if (!po || !po.id || !po.supplierId || !po.supplierName?.trim() || !Array.isArray(po.items) || po.items.length === 0) return null;
  if (!Number.isFinite(po.total) || po.total < 0) return null;

  const productById = new Map(products.map(p => [p.id, p]));
  const productStockDelta = new Map<string, number>();
  const productCost = new Map<string, number>();
  const trackedUnitCount = new Map<string, number>();
  let calculatedTotal = 0;

  for (const item of po.items) {
    const product = productById.get(item.productId);
    if (!product || !Number.isFinite(item.qty) || item.qty <= 0 || !Number.isInteger(item.qty) || !Number.isFinite(item.cost) || item.cost < 0) {
      return null;
    }
    if (productStockDelta.has(item.productId)) return null;

    if (item.updateSellingPrice) {
      if (!Number.isFinite(item.sellingPrice) || (item.sellingPrice ?? 0) < 0) return null;
    }

    const lineTotal = item.qty * item.cost;
    if (!Number.isFinite(lineTotal) || lineTotal < 0) return null;
    calculatedTotal += lineTotal;
    if (!Number.isFinite(calculatedTotal)) return null;

    productStockDelta.set(item.productId, item.qty);
    productCost.set(item.productId, item.cost);

    if (product.trackImei || product.trackSerial) {
      trackedUnitCount.set(item.productId, item.qty);
    }
  }

  // The persisted PO/GRN total must be derived from its lines, not supplied
  // independently by the caller. Allow only normal floating-point rounding.
  if (Math.abs(calculatedTotal - po.total) > 0.01) return null;

  return { productStockDelta, productCost, trackedUnitCount };
}

/**
 * Purchase-scoped units are safe to identify for reconciliation only when
 * their purchaseId matches exactly. This intentionally does not delete units.
 */
export function getPurchaseUnits(units: readonly InventoryUnit[], purchaseId: string): InventoryUnit[] {
  return units.filter(u => u.purchaseId === purchaseId);
}

/** Received purchase orders must not be destructively deleted. */
export function canDeletePurchase(po: Purchase): boolean {
  return po.status === 'pending';
}
