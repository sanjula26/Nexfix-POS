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
  const productById = new Map(products.map(p => [p.id, p]));
  const productStockDelta = new Map<string, number>();
  const productCost = new Map<string, number>();
  const trackedUnitCount = new Map<string, number>();

  for (const item of po.items) {
    const product = productById.get(item.productId);
    if (!product || !Number.isFinite(item.qty) || item.qty <= 0 || !Number.isFinite(item.cost) || item.cost < 0) {
      return null;
    }
    // Duplicate product lines can carry different costs. Reject them at the
    // business-logic boundary instead of silently losing a line's cost.
    if (productStockDelta.has(item.productId)) return null;

    productStockDelta.set(item.productId, item.qty);
    productCost.set(item.productId, item.cost);

    if (product.trackImei || product.trackSerial) {
      const qty = Math.floor(item.qty);
      if (qty !== item.qty) return null;
      trackedUnitCount.set(item.productId, qty);
    }
  }

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
