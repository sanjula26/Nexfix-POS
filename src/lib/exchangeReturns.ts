import type { Exchange, InventoryUnit, SaleItem } from './types';

export interface ExchangeReturnRequest {
  itemIdx: number;
  qty: number;
  unitIds?: string[];
}

export type ExchangeReturnFailure =
  | 'invalid_sale_line'
  | 'quantity_exceeds_available'
  | 'tracked_unit_count_mismatch'
  | 'tracked_unit_not_sold'
  | 'untracked_unit_ids'
  | 'no_returnable_items';

export type ExchangeReturnResolution =
  | {
      ok: true;
      items: Exchange['items'];
      returnedUnitIds: string[];
      restockQtyByProduct: Map<string, number>;
      refundAmount: number;
      allReturned: boolean;
    }
  | { ok: false; reason: ExchangeReturnFailure };

/**
 * Resolve exchange/refund lines against prior exchange history and sold units.
 * This is a pure decision helper: it does not mutate POS state or persist data.
 */
export function resolveExchangeReturnLines(input: {
  saleId: string;
  saleItems: readonly SaleItem[];
  priorExchanges: readonly Exchange[];
  units: readonly InventoryUnit[];
  requested: ReadonlyMap<number, number>;
  returns: readonly ExchangeReturnRequest[];
  mode: 'refund' | 'replace';
}): ExchangeReturnResolution {
  const priorReturnedByLine = new Map<string, number>();
  const priorReturnedByProduct = new Map<string, number>();
  input.priorExchanges.forEach(exchange => exchange.items.forEach(item => {
    const lineKey = item.itemIdx !== undefined ? 'i:' + item.itemIdx : 'p:' + item.productId;
    priorReturnedByLine.set(lineKey, (priorReturnedByLine.get(lineKey) || 0) + item.qty);
    priorReturnedByProduct.set(item.productId, (priorReturnedByProduct.get(item.productId) || 0) + item.qty);
  }));

  const items: Exchange['items'] = [];
  const returnedUnitIds: string[] = [];
  const restockQtyByProduct = new Map<string, number>();
  let refundAmount = 0;

  for (const [itemIdx, requestedQty] of input.requested) {
    const it = input.saleItems[itemIdx];
    if (!it) return { ok: false, reason: 'invalid_sale_line' };
    const lineKey = 'i:' + itemIdx;
    const alreadyReturned = priorReturnedByLine.has(lineKey)
      ? (priorReturnedByLine.get(lineKey) || 0)
      : (priorReturnedByProduct.get(it.productId) || 0);
    const availableQty = Math.max(0, it.qty - alreadyReturned);
    const tracked = (it.unitIds || []).length > 0;
    const trackedAvailable = (it.unitIds || []).filter(id =>
      input.units.some(u => u.id === id && u.status === 'sold' && u.saleId === input.saleId),
    ).length;
    const maxReturnable = Math.min(availableQty, tracked ? trackedAvailable : availableQty);
    if (requestedQty > maxReturnable) return { ok: false, reason: 'quantity_exceeds_available' };

    const requestedUnitIds = Array.isArray((input.returns.find(r => r.itemIdx === itemIdx) || {}).unitIds)
      ? ((input.returns.find(r => r.itemIdx === itemIdx) || {}).unitIds || []).filter(Boolean)
      : [];
    if (tracked) {
      if (requestedUnitIds.length !== requestedQty || new Set(requestedUnitIds).size !== requestedQty) {
        return { ok: false, reason: 'tracked_unit_count_mismatch' };
      }
      const soldUnitIds = new Set((it.unitIds || []).filter(Boolean));
      if (requestedUnitIds.some(id =>
        !soldUnitIds.has(id)
        || !input.units.some(u => u.id === id && u.status === 'sold' && u.saleId === input.saleId),
      )) return { ok: false, reason: 'tracked_unit_not_sold' };
    } else if (requestedUnitIds.length) {
      return { ok: false, reason: 'untracked_unit_ids' };
    }

    const proportionalDiscount = it.qty > 0 ? (it.discount || 0) * (requestedQty / it.qty) : 0;
    const amount = Math.max(0, Math.round((it.price * requestedQty - proportionalDiscount) * 100) / 100);
    items.push({ itemIdx, productId: it.productId, name: it.name, qty: requestedQty, amount });
    if (input.mode === 'refund') refundAmount += amount;
    restockQtyByProduct.set(it.productId, (restockQtyByProduct.get(it.productId) || 0) + requestedQty);
    returnedUnitIds.push(...requestedUnitIds);
    priorReturnedByLine.set(lineKey, alreadyReturned + requestedQty);
    priorReturnedByProduct.set(it.productId, (priorReturnedByProduct.get(it.productId) || 0) + requestedQty);
  }

  if (!items.length) return { ok: false, reason: 'no_returnable_items' };
  const allReturned = input.saleItems.every((it, idx) => {
    const returned = priorReturnedByLine.has('i:' + idx)
      ? (priorReturnedByLine.get('i:' + idx) || 0)
      : (priorReturnedByProduct.get(it.productId) || 0);
    return returned >= it.qty;
  });

  return {
    ok: true,
    items,
    returnedUnitIds,
    restockQtyByProduct,
    refundAmount: Math.round(refundAmount * 100) / 100,
    allReturned,
  };
}
