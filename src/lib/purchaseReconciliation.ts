import type { InventoryUnit, Product, Purchase } from './types';

export interface PurchaseReceivePlan {
  productStockDelta: Map<string, number>;
  productCost: Map<string, number>;
  trackedUnitCount: Map<string, number>;
}

export interface PurchaseValidationResult {
  ok: boolean;
  error?: string;
}

export interface PurchaseReceivePlanResult extends PurchaseValidationResult {
  plan?: PurchaseReceivePlan;
}

/** Validates explicit IMEI/Serial values before a tracked purchase can be saved or received. */
export function validatePurchaseUnitIdentifiers(
  po: Purchase,
  products: readonly Product[],
  existingUnits: readonly InventoryUnit[] = [],
): PurchaseValidationResult {
  if (!po || !Array.isArray(po.items)) return { ok: false, error: 'GRN items are invalid.' };
  const productById = new Map(products.map(p => [p.id, p]));
  const seenImei = new Set<string>();
  const seenSerial = new Set<string>();
  for (const unit of existingUnits) {
    if (unit.imei?.trim()) seenImei.add(unit.imei.trim().toLowerCase());
    if (unit.serial?.trim()) seenSerial.add(unit.serial.trim().toLowerCase());
  }
  for (const item of po.items) {
    const product = productById.get(item.productId);
    if (!product) return { ok: false, error: (item.name || 'Product') + ': product no longer exists in Inventory.' };
    const trackedImei = !!product.trackImei;
    const trackedSerial = !!product.trackSerial;
    if (!trackedImei && !trackedSerial) {
      if (item.unitIdentifiers?.length) return { ok: false, error: item.name + ': this product is not configured for IMEI/Serial tracking.' };
      continue;
    }
    if (!Array.isArray(item.unitIdentifiers) || item.unitIdentifiers.length !== item.qty) {
      const got = Array.isArray(item.unitIdentifiers) ? item.unitIdentifiers.length : 0;
      const kind = trackedImei && trackedSerial ? 'IMEI and Serial pair' : trackedImei ? 'IMEI' : 'Serial number';
      return { ok: false, error: item.name + ': enter one ' + kind + ' for every unit (expected ' + item.qty + ', got ' + got + ').' };
    }
    for (let index = 0; index < item.unitIdentifiers.length; index++) {
      const raw = item.unitIdentifiers[index] || {};
      const imei = raw.imei?.trim() || '';
      const serial = raw.serial?.trim() || '';
      if (trackedImei && !imei) return { ok: false, error: item.name + ': unit ' + (index + 1) + ' is missing its IMEI.' };
      if (trackedSerial && !serial) return { ok: false, error: item.name + ': unit ' + (index + 1) + ' is missing its Serial number.' };
      if (!trackedImei && imei) return { ok: false, error: item.name + ': IMEI was entered but this product does not track IMEI.' };
      if (!trackedSerial && serial) return { ok: false, error: item.name + ': Serial number was entered but this product does not track Serial.' };
      if (imei) {
        const key = imei.toLowerCase();
        if (seenImei.has(key)) return { ok: false, error: 'IMEI ' + imei + ' already exists in stock.' };
        seenImei.add(key);
      }
      if (serial) {
        const key = serial.toLowerCase();
        if (seenSerial.has(key)) return { ok: false, error: 'Serial ' + serial + ' already exists in stock.' };
        seenSerial.add(key);
      }
    }
  }
  return { ok: true };
}

/** Builds a deterministic receive plan and returns the exact validation error. */
export function buildPurchaseReceivePlan(po: Purchase, products: readonly Product[]): PurchaseReceivePlanResult {
  if (!po || !po.id) return { ok: false, error: 'GRN is invalid.' };
  if (!po.supplierId || !po.supplierName?.trim()) return { ok: false, error: 'Select a supplier.' };
  if (!Array.isArray(po.items) || po.items.length === 0) return { ok: false, error: 'Add at least one product line.' };
  if (!Number.isFinite(po.total) || po.total < 0) return { ok: false, error: 'GRN total is invalid.' };

  const productById = new Map(products.map(p => [p.id, p]));
  const productStockDelta = new Map<string, number>();
  const productCost = new Map<string, number>();
  const trackedUnitCount = new Map<string, number>();
  let calculatedTotal = 0;
  for (const item of po.items) {
    const product = productById.get(item.productId);
    if (!product) return { ok: false, error: (item.name || 'Product') + ': product no longer exists in Inventory.' };
    if (!Number.isFinite(item.qty) || !Number.isInteger(item.qty) || item.qty <= 0) return { ok: false, error: 'Quantity must be a positive whole number.' };
    if (!Number.isFinite(item.cost) || item.cost < 0) return { ok: false, error: item.name + ': cost cannot be negative.' };
    if (productStockDelta.has(item.productId)) return { ok: false, error: 'This product appears more than once in the GRN.' };
    if (item.updateSellingPrice && (!Number.isFinite(item.sellingPrice) || (item.sellingPrice ?? 0) < 0)) return { ok: false, error: item.name + ': selling price is invalid.' };
    const lineTotal = item.qty * item.cost;
    if (!Number.isFinite(lineTotal) || lineTotal < 0) return { ok: false, error: item.name + ': line total is invalid.' };
    calculatedTotal += lineTotal;
    if (!Number.isFinite(calculatedTotal)) return { ok: false, error: 'GRN total is too large.' };
    productStockDelta.set(item.productId, item.qty);
    productCost.set(item.productId, item.cost);
    if (product.trackImei || product.trackSerial) trackedUnitCount.set(item.productId, item.qty);
  }
  if (Math.abs(calculatedTotal - po.total) > 0.01) return { ok: false, error: 'GRN total mismatch: expected ' + calculatedTotal.toFixed(2) + ', got ' + po.total.toFixed(2) + '.' };
  return { ok: true, plan: { productStockDelta, productCost, trackedUnitCount } };
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
