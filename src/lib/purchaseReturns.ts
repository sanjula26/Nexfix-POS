import type { InventoryUnit, Product, Purchase, PurchaseReturn, PurchaseReturnItem } from './types';

export interface PurchaseReturnLineRequest {
  itemIdx: number;
  qty: number;
  unitIds?: string[];
}

export type PurchaseReturnFailure =
  | 'no_returnable_lines'
  | 'invalid_source_line'
  | 'invalid_product_stock'
  | 'quantity_exceeds_available'
  | 'tracked_unit_count_mismatch'
  | 'tracked_unit_not_available'
  | 'tracked_unit_identifier_mismatch'
  | 'untracked_unit_ids';

export type PurchaseReturnResolution =
  | {
      ok: true;
      items: PurchaseReturnItem[];
      returnedUnitIds: Set<string>;
      total: number;
    }
  | { ok: false; reason: PurchaseReturnFailure };

/**
 * Resolve supplier-return quantities and tracked units against received GRN
 * history. This is a pure preflight; the provider must recheck current state
 * after the cloud operation and before applying stock/unit mutations.
 */
export function resolvePurchaseReturnLines(input: {
  purchase: Purchase;
  existingReturns: readonly PurchaseReturn[];
  products: readonly Product[];
  units: readonly InventoryUnit[];
  lines: readonly PurchaseReturnLineRequest[];
}): PurchaseReturnResolution {
  const returnedByItem = new Map<number, number>();
  for (const ret of input.existingReturns) {
    if (ret.purchaseId !== input.purchase.id) continue;
    for (const item of ret.items) {
      returnedByItem.set(item.itemIdx, (returnedByItem.get(item.itemIdx) || 0) + item.qty);
    }
  }

  const requested = new Map<number, { qty: number; unitIds: string[] }>();
  for (const line of input.lines) {
    if (!Number.isInteger(line.itemIdx) || line.itemIdx < 0 || line.itemIdx >= input.purchase.items.length) continue;
    if (!Number.isInteger(line.qty) || line.qty <= 0) continue;
    const previous = requested.get(line.itemIdx);
    const unitIds = Array.isArray(line.unitIds) ? line.unitIds.filter(Boolean) : [];
    requested.set(line.itemIdx, {
      qty: (previous?.qty || 0) + line.qty,
      unitIds: [...(previous?.unitIds || []), ...unitIds],
    });
  }
  if (requested.size === 0) return { ok: false, reason: 'no_returnable_lines' };

  const items: PurchaseReturnItem[] = [];
  const returnedUnitIds = new Set<string>();
  for (const [itemIdx, request] of requested) {
    const source = input.purchase.items[itemIdx];
    if (!Number.isInteger(source.qty) || source.qty <= 0 || !Number.isFinite(source.cost) || source.cost < 0) {
      return { ok: false, reason: 'invalid_source_line' };
    }
    const already = returnedByItem.get(itemIdx) || 0;
    const remaining = Math.max(0, source.qty - already);
    const product = input.products.find(p => p.id === source.productId);
    const stock = product?.stock ?? NaN;
    if (!product || !Number.isFinite(stock) || stock < 0) {
      return { ok: false, reason: 'invalid_product_stock' };
    }

    const tracked = Array.isArray(source.unitIdentifiers) && source.unitIdentifiers.length > 0;
    const availableUnits = tracked
      ? input.units.filter(u => u.productId === source.productId && u.purchaseId === input.purchase.id && u.status === 'in_stock')
      : [];
    const maxReturnable = Math.min(remaining, stock, tracked ? availableUnits.length : Number.MAX_SAFE_INTEGER);
    if (request.qty > maxReturnable) return { ok: false, reason: 'quantity_exceeds_available' };

    let selectedUnitIds: string[] | undefined;
    if (tracked) {
      const selected = [...new Set(request.unitIds)];
      if (selected.length !== request.qty) return { ok: false, reason: 'tracked_unit_count_mismatch' };
      const availableIds = new Set(availableUnits.map(u => u.id));
      const expectedIdentifiers = (source.unitIdentifiers || []).map(x => ({
        imei: x.imei?.trim().toLowerCase() || '',
        serial: x.serial?.trim().toLowerCase() || '',
      }));
      for (const unitId of selected) {
        const unit = availableUnits.find(u => u.id === unitId);
        if (!unit || !availableIds.has(unitId) || returnedUnitIds.has(unitId)) {
          return { ok: false, reason: 'tracked_unit_not_available' };
        }
        const imei = unit.imei?.trim().toLowerCase() || '';
        const serial = unit.serial?.trim().toLowerCase() || '';
        if (!expectedIdentifiers.some(x => x.imei === imei && x.serial === serial)) {
          return { ok: false, reason: 'tracked_unit_identifier_mismatch' };
        }
        returnedUnitIds.add(unitId);
      }
      selectedUnitIds = selected;
    } else if (request.unitIds.length) {
      return { ok: false, reason: 'untracked_unit_ids' };
    }

    items.push({
      itemIdx,
      productId: source.productId,
      name: source.name,
      qty: request.qty,
      cost: source.cost,
      total: request.qty * source.cost,
      ...(selectedUnitIds ? { unitIds: selectedUnitIds } : {}),
    });
  }

  if (!items.length) return { ok: false, reason: 'no_returnable_lines' };
  return {
    ok: true,
    items,
    returnedUnitIds,
    total: items.reduce((sum, item) => sum + item.total, 0),
  };
}
