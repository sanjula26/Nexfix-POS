function isValidIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function hasPlainObjectShape(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** Validate financial fields in settlement history before accepting a restore. */
export function hasValidCustomerCreditPayment(value: unknown): boolean {
  if (!hasPlainObjectShape(value)) return false;
  const payment = value;
  const validMethods = new Set(['cash', 'card', 'bank', 'mobile']);
  if (typeof payment.id !== 'string' || !payment.id.trim()
    || typeof payment.customerId !== 'string' || !payment.customerId.trim()
    || typeof payment.by !== 'string' || !payment.by.trim()
    || !isValidIsoDate(payment.date)
    || typeof payment.amount !== 'number' || !Number.isFinite(payment.amount) || payment.amount <= 0
    || typeof payment.method !== 'string' || !validMethods.has(payment.method)) return false;
  for (const field of ['balanceBefore', 'balanceAfter'] as const) {
    const balance = payment[field];
    if (balance !== undefined && (typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0)) return false;
  }
  // Newer records include both snapshots. Keep accepting older backups without them.
  if (typeof payment.balanceBefore === 'number' && typeof payment.balanceAfter === 'number'
    && Math.abs(Math.round((payment.balanceBefore - payment.amount) * 100) / 100 - payment.balanceAfter) > 0.009) return false;
  if (payment.methods !== undefined) {
    if (!hasArray(payment.methods) || payment.methods.length === 0 || !payment.methods.every(leg =>
      hasPlainObjectShape(leg) && typeof leg.method === 'string' && validMethods.has(leg.method)
      && typeof leg.amount === 'number' && Number.isFinite(leg.amount) && leg.amount > 0)) return false;
    const splitTotal = (payment.methods as Array<{ amount: number }>).reduce((sum, leg) => sum + leg.amount, 0);
    if (Math.abs(splitTotal - payment.amount) > 0.009) return false;
  }
  if (payment.allocations !== undefined) {
    if (!hasArray(payment.allocations) || !payment.allocations.every(allocation =>
      hasPlainObjectShape(allocation) && typeof allocation.saleId === 'string' && !!allocation.saleId.trim()
      && typeof allocation.billNo === 'string' && !!allocation.billNo.trim()
      && typeof allocation.amount === 'number' && Number.isFinite(allocation.amount) && allocation.amount > 0)) return false;
    // Customer-level repayments remain valid when legacy invoice allocation data
    // is incomplete. Allocations are supporting detail, not the payment source.
    const allocated = (payment.allocations as Array<{ amount: number }>).reduce((sum, allocation) => sum + allocation.amount, 0);
    if (allocated - payment.amount > 0.009) return false;
  }
  return true;
}
