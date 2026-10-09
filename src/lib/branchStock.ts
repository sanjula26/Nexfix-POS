export interface BranchStockRow { productId: string; qty: number }

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function key(branchId: string): string {
  return `nexfix_branch_stock_v1:${branchId}`;
}

/** Cache only the selected branch's server-authoritative stock for offline POS checks. */
export function cacheBranchStock(branchId: string, rows: Array<{ product_id: string; qty: number | string }>): void {
  if (!branchId || branchId === 'local-main') return;
  const values: Record<string, number> = {};
  for (const row of rows) {
    const qty = Number(row.qty);
    if (row.product_id && Number.isFinite(qty) && qty >= 0) values[row.product_id] = qty;
  }
  try { storage()?.setItem(key(branchId), JSON.stringify({ updatedAt: new Date().toISOString(), values })); } catch { /* offline cache is best-effort */ }
}

export function getCachedBranchStock(branchId: string, productId: string): number | null {
  if (!branchId || branchId === 'local-main') return null;
  try {
    const parsed = JSON.parse(storage()?.getItem(key(branchId)) || 'null') as { values?: Record<string, number> } | null;
    if (!parsed?.values || !Object.prototype.hasOwnProperty.call(parsed.values, productId)) return null;
    const qty = Number(parsed.values[productId]);
    return Number.isFinite(qty) && qty >= 0 ? qty : null;
  } catch { return null; }
}

export function hasCachedBranchStock(branchId: string): boolean {
  if (!branchId || branchId === 'local-main') return false;
  try {
    const parsed = JSON.parse(storage()?.getItem(key(branchId)) || 'null') as { values?: Record<string, number> } | null;
    return !!parsed?.values && typeof parsed.values === 'object';
  } catch { return false; }
}

/** Apply signed quantity deltas after local transactions; negative result is rejected. */
export function applyBranchStockDeltas(branchId: string, deltas: Record<string, number>): boolean {
  if (!branchId || branchId === 'local-main') return false;
  try {
    const s = storage();
    const parsed = JSON.parse(s?.getItem(key(branchId)) || 'null') as { updatedAt?: string; values?: Record<string, number> } | null;
    if (!s || !parsed?.values) return false;
    const next = { ...parsed.values };
    for (const [productId, delta] of Object.entries(deltas)) {
      const current = Number(next[productId] ?? 0);
      const amount = Number(delta);
      if (!Number.isFinite(amount) || current + amount < -0.0001) return false;
      next[productId] = Math.max(0, Math.round((current + amount) * 100) / 100);
    }
    s.setItem(key(branchId), JSON.stringify({ updatedAt: new Date().toISOString(), values: next }));
    return true;
  } catch { return false; }
}

export function cacheDefaultBranchId(shopId: string, branchId: string): void {
  if (!shopId || !branchId) return;
  try { storage()?.setItem(`nexfix_default_branch_v1:${shopId}`, branchId); } catch { /* optional cache */ }
}

export function getDefaultBranchId(shopId: string): string | null {
  if (!shopId) return null;
  try { return storage()?.getItem(`nexfix_default_branch_v1:${shopId}`) || null; } catch { return null; }
}

export function hasMultipleCachedBranches(shopId: string): boolean {
  if (!shopId) return false;
  try {
    const parsed = JSON.parse(storage()?.getItem(`nexfix_branches_v1:${shopId}`) || '[]') as Array<{ active?: boolean }>;
    return Array.isArray(parsed) && parsed.filter(branch => branch.active !== false).length > 1;
  } catch { return false; }
}
