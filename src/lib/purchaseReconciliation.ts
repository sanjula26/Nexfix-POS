import type { InventoryUnit, Product, Purchase } from './types';

export interface PurchaseReceivePlan {
  productStockDelta: Map<string, number>;
  productCost: Map<string, number>;
  trackedUnitCount: Map<string, number>;
}

/**
 * Builds a deterministic receive plan from every purchase line.
 * Duplicate product lines are aggregated instead of using Array.find(), so
 * stock and tracked-unit creation cannot silently ignore later lines.
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

    productStockDelta.set(item.productId, (productStockDelta.get(item.productId) || 0) + item.qty);
    productCost.set(item.productId, item.cost);

    if (product.trackImei || product.trackSerial) {
      const qty = Math.floor(item.qty);
      if (qty !== item.qty) return null;
      trackedUnitCount.set(item.productId, (trackedUnitCount.get(item.productId) || 0) + qty);
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
