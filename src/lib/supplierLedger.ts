import type { Purchase, Supplier } from './types';

/**
 * Supplier account foundation.
 *
 * The current POS model stores purchase orders but does not yet store supplier
 * payment transactions. This helper therefore exposes the payable created by
 * received purchase orders without inventing payment data. It is intentionally
 * pure so it can be used by the upcoming Supplier Payments UI and tests.
 */
export interface SupplierAccountSummary {
  supplierId: string;
  supplierName: string;
  receivedPurchases: number;
  purchasedValue: number;
  outstanding: number;
}

export function buildSupplierAccountSummary(
  suppliers: readonly Supplier[],
  purchases: readonly Purchase[],
): SupplierAccountSummary[] {
  const supplierById = new Map(suppliers.map(s => [s.id, s]));
  const totals = new Map<string, { count: number; value: number }>();

  for (const purchase of purchases) {
    if (purchase.status !== 'received') continue;
    if (!supplierById.has(purchase.supplierId)) continue;
    if (!Number.isFinite(purchase.total) || purchase.total < 0) continue;

    const current = totals.get(purchase.supplierId) || { count: 0, value: 0 };
    current.count += 1;
    current.value += purchase.total;
    totals.set(purchase.supplierId, current);
  }

  return suppliers
    .map(supplier => {
      const total = totals.get(supplier.id) || { count: 0, value: 0 };
      return {
        supplierId: supplier.id,
        supplierName: supplier.name,
        receivedPurchases: total.count,
        purchasedValue: Math.round(total.value * 100) / 100,
        outstanding: Math.round(total.value * 100) / 100,
      };
    })
    .sort((a, b) => b.outstanding - a.outstanding || a.supplierName.localeCompare(b.supplierName));
}
