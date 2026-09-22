import type { InventoryUnit, Product, Purchase } from './types';

export interface PurchaseReceivePlan {
  productStockDelta: Map<string, number>;
  productCost: Map<string, number>;
  trackedUnitCount: Map<string, number>;
}

/** Validates explicit IMEI/Serial values before a tracked purchase can be saved or received. */
export function validatePurchaseUnitIdentifiers(po: Purchase, products: readonly Product[], existingUnits: readonly InventoryUnit[] = []): boolean {
  const productById = new Map(products.map(p => [p.id, p]));
  const seenImei = new Set<string>();
  const seenSerial = new Set<string>();
  for (const unit of existingUnits) {
    if (unit.imei?.trim()) seenImei.add(unit.imei.trim().toLowerCase());
    if (unit.serial?.trim()) seenSerial.add(unit.serial.trim().toLowerCase());
  }
  for (const item of po.items) {
    const product = productById.get(item.productId);
    if (!product) return false;
    if (!(product.trackImei || product.trackSerial)) { if (item.unitIdentifiers?.length) return false; continue; }
    if (!Array.isArray(item.unitIdentifiers) || item.unitIdentifiers.length !== item.qty) return false;
    for (const raw of item.unitIdentifiers) {
      const imei = raw?.imei?.trim() || ''; const serial = raw?.serial?.trim() || '';
      if (product.trackImei && !imei) return false; if (product.trackSerial && !serial) return false;
      if (!product.trackImei && imei) return false; if (!product.trackSerial && serial) return false;
      if (imei) { const key=imei.toLowerCase(); if (seenImei.has(key)) return false; seenImei.add(key); }
      if (serial) { const key=serial.toLowerCase(); if (seenSerial.has(key)) return false; seenSerial.add(key); }
    }
  }
  return true;
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
