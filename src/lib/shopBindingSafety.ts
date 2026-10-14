import type { POSState } from './types';

/**
 * A first cloud setup may safely start with a clean local seed. If a shop
 * binding is missing but business records/settings already exist, do not
 * silently associate that data with whichever cloud membership happens to
 * appear first. An explicit, verified migration/rebind flow is needed instead.
 */
export function hasLocalBusinessData(state: POSState): boolean {
  const collections: unknown[] = [
    state.products, state.customers, state.suppliers, state.sales, state.purchases,
    state.expenses, state.exchanges, state.purchaseReturns, state.held, state.sessions,
    state.units, state.repairs, state.kitItems, state.quotations, state.warrantyClaims,
    state.inventoryTransactions, state.supplierPayments, state.customerCreditPayments,
    state.grns, state.reverseRequests,
  ];
  if (collections.some(value => Array.isArray(value) && value.length > 0)) return true;
  if (Object.values(state.counters || {}).some(value => Number(value) > 0)) return true;

  const settings = state.settings as unknown as Record<string, unknown>;
  const nonDefaultSettings: Array<[string, unknown]> = [
    ['shopName', 'Nexfix Solution'], ['tagline', ''], ['address', ''], ['phone', ''],
    ['email', ''], ['receiptFooter', ''], ['taxDefault', 0], ['lowStockDefault', 5],
    ['exchangeDays', 3], ['openingFloat', 10000], ['loyaltyPointsPerRs', 0.001],
    ['loyaltyPointValue', 20], ['taxRegistrationNo', ''], ['invoicePlaceOfSupply', ''],
  ];
  return nonDefaultSettings.some(([key, fallback]) => {
    const value = settings[key];
    return typeof value === 'string'
      ? value.trim() !== String(fallback).trim()
      : value !== fallback;
  });
}
