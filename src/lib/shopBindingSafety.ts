import type { POSState } from './types';

/**
 * A first cloud setup may safely start with a clean local seed. If a shop
 * binding is missing but business records/settings already exist, do not
 * silently associate that data with whichever cloud membership happens to
 * appear first. An explicit, verified migration/rebind flow is needed instead.
 */
export function hasLocalBusinessData(input: unknown): boolean {
  if (!input || typeof input !== 'object') return true;
  const state = input as Partial<POSState>;
  const collections: unknown[] = [
    state.products, state.customers, state.suppliers, state.sales, state.purchases,
    state.expenses, state.exchanges, state.purchaseReturns, state.held, state.sessions,
    state.units, state.repairs, state.kitItems, state.quotations, state.warrantyClaims,
    state.inventoryTransactions, state.supplierPayments, state.customerCreditPayments,
    state.grns, state.reverseRequests,
  ];
  if (collections.some(value => Array.isArray(value) && value.length > 0)) return true;
  if (Object.values(state.counters || {}).some(value => Number(value) > 0)) return true;

  const settings = (state.settings || {}) as unknown as Record<string, unknown>;
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


/** Pure evaluator for saved local snapshots/caches; every legacy source is checked independently. */
export function hasStoredLocalBusinessDataFromEntries(
  entries: Array<{ key: string; raw: string | null }>,
): boolean {
  const relevant = entries.filter(entry =>
    entry.raw !== null
    && (
      entry.key === 'nexfix_pos_v2'
      || entry.key === 'nexfix_pos_v1'
      || entry.key.startsWith('nexfix_shop_state_cache_v1:')
    ),
  );
  for (const entry of relevant) {
    if (entry.raw === null) return true;
    let parsed: unknown;
    try { parsed = JSON.parse(entry.raw); } catch { return true; }
    if (hasLocalBusinessData(parsed)) return true;
  }
  return false;
}

/** Inspect both legacy snapshots and every per-shop cache. Unreadable storage
 * or corrupt saved state fails closed rather than being assumed empty.
 */
export function hasStoredLocalBusinessData(): boolean {
  try {
    const entries: Array<{ key: string; raw: string | null }> = [];
    const keys = ['nexfix_pos_v2', 'nexfix_pos_v1'];
    for (const key of keys) entries.push({ key, raw: localStorage.getItem(key) });
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith('nexfix_shop_state_cache_v1:')) {
        entries.push({ key, raw: localStorage.getItem(key) });
      }
    }
    return hasStoredLocalBusinessDataFromEntries(entries);
  } catch {
    return true;
  }
}


/** First-time automatic Cloud binding is safe only for a clean seed with no legacy snapshot or pending local work. */
export function canAutoBindCloudShop(
  state: unknown,
  pendingQueueCount: number,
  hasStoredLegacyBusinessData: boolean,
): boolean {
  if (!Number.isSafeInteger(pendingQueueCount) || pendingQueueCount < 0) return false;
  return pendingQueueCount === 0
    && !hasLocalBusinessData(state)
    && hasStoredLegacyBusinessData === false;
}
