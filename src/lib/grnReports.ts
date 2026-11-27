import type { Purchase, PurchaseReturn } from './types';

export interface PurchaseCostHistoryRow {
  id: string;
  purchaseId: string;
  poNo: string;
  date: string;
  supplierName: string;
  supplierInvoiceNo: string;
  productId: string;
  productName: string;
  purchaseQty: number;
  returnedQty: number;
  netQty: number;
  unitCost: number;
  purchaseValue: number;
  returnedValue: number;
  netValue: number;
}

export interface SupplierReturnReportRow {
  id: string;
  returnId: string;
  dnNo: string;
  date: string;
  supplierName: string;
  poNo: string;
  purchaseId: string;
  productId: string;
  productName: string;
  qty: number;
  unitCost: number;
  total: number;
  reason: string;
  by: string;
}

const safeQty = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

const safeMoney = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, value) : 0;

/** Builds a read-only, per-item audit of actual received GRN costs, net of supplier returns. */
export function buildPurchaseCostHistoryRows(
  purchases: readonly Purchase[],
  returns: readonly PurchaseReturn[] = [],
): PurchaseCostHistoryRow[] {
  const returnedByPurchaseItem = new Map<string, number>();
  for (const purchaseReturn of returns) {
    for (const item of purchaseReturn.items || []) {
      const key = purchaseReturn.purchaseId + ':' + item.itemIdx;
      returnedByPurchaseItem.set(key, (returnedByPurchaseItem.get(key) || 0) + safeQty(item.qty));
    }
  }

  const rows: PurchaseCostHistoryRow[] = [];
  for (const purchase of purchases) {
    if (purchase.status !== 'received') continue;
    for (let itemIdx = 0; itemIdx < purchase.items.length; itemIdx++) {
      const item = purchase.items[itemIdx];
      const purchaseQty = safeQty(item.qty);
      const returnedQty = Math.min(
        purchaseQty,
        returnedByPurchaseItem.get(purchase.id + ':' + itemIdx) || 0,
      );
      const unitCost = safeMoney(item.cost);
      const purchaseValue = purchaseQty * unitCost;
      const returnedValue = returnedQty * unitCost;
      rows.push({
        id: purchase.id + ':' + itemIdx,
        purchaseId: purchase.id,
        poNo: purchase.poNo,
        date: purchase.processedAt || purchase.date,
        supplierName: purchase.supplierName,
        supplierInvoiceNo: purchase.supplierInvoiceNo || '',
        productId: item.productId,
        productName: item.name,
        purchaseQty,
        returnedQty,
        netQty: Math.max(0, purchaseQty - returnedQty),
        unitCost,
        purchaseValue,
        returnedValue,
        netValue: Math.max(0, purchaseValue - returnedValue),
      });
    }
  }
  return rows;
}

/** Flattens supplier debit notes to one report row per returned product line. */
export function buildSupplierReturnReportRows(
  returns: readonly PurchaseReturn[],
): SupplierReturnReportRow[] {
  const rows: SupplierReturnReportRow[] = [];
  for (const purchaseReturn of returns) {
    for (let itemIdx = 0; itemIdx < (purchaseReturn.items || []).length; itemIdx++) {
      const item = purchaseReturn.items[itemIdx];
      const qty = safeQty(item.qty);
      const unitCost = safeMoney(item.cost);
      rows.push({
        id: purchaseReturn.id + ':' + itemIdx,
        returnId: purchaseReturn.id,
        dnNo: purchaseReturn.dnNo,
        date: purchaseReturn.date,
        supplierName: purchaseReturn.supplierName,
        poNo: purchaseReturn.poNo,
        purchaseId: purchaseReturn.purchaseId,
        productId: item.productId,
        productName: item.name,
        qty,
        unitCost,
        total: safeMoney(item.total),
        reason: purchaseReturn.reason,
        by: purchaseReturn.by,
      });
    }
  }
  return rows;
}
