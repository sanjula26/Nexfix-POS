import type { Purchase, Supplier } from './types';

export type SupplierPaymentMethod = 'cash' | 'card' | 'bank' | 'mobile';

export interface SupplierPayment {
  id: string;
  supplierId: string;
  amount: number;
  method: SupplierPaymentMethod;
  date: string;
  note?: string;
  purchaseId?: string;
  by: string;
}

export interface SupplierAccountLedgerRow {
  date: string;
  type: 'purchase' | 'payment';
  reference: string;
  amount: number;
  balance: number;
  paymentMethod?: SupplierPaymentMethod;
}

export function buildSupplierLedger(
  supplier: Supplier,
  purchases: readonly Purchase[],
  payments: readonly SupplierPayment[],
): SupplierAccountLedgerRow[] {
  const rows: Array<{ date: string; type: 'purchase' | 'payment'; reference: string; amount: number; paymentMethod?: SupplierPaymentMethod }> = [];

  for (const purchase of purchases) {
    if (purchase.supplierId !== supplier.id || purchase.status !== 'received') continue;
    if (!Number.isFinite(purchase.total) || purchase.total < 0) continue;
    rows.push({ date: purchase.date, type: 'purchase', reference: purchase.poNo, amount: purchase.total });
  }

  for (const payment of payments) {
    if (payment.supplierId !== supplier.id) continue;
    if (!Number.isFinite(payment.amount) || payment.amount <= 0) continue;
    rows.push({ date: payment.date, type: 'payment', reference: payment.purchaseId || payment.id, amount: -payment.amount, paymentMethod: payment.method });
  }

  rows.sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type) || a.reference.localeCompare(b.reference));
  let balance = 0;
  return rows.map(row => {
    balance = Math.round((balance + row.amount) * 100) / 100;
    return { ...row, balance };
  });
}

export function getSupplierOutstanding(
  supplierId: string,
  purchases: readonly Purchase[],
  payments: readonly SupplierPayment[],
): number {
  const purchased = purchases
    .filter(p => p.supplierId === supplierId && p.status === 'received' && Number.isFinite(p.total) && p.total >= 0)
    .reduce((sum, p) => sum + p.total, 0);
  const paid = payments
    .filter(p => p.supplierId === supplierId && Number.isFinite(p.amount) && p.amount > 0)
    .reduce((sum, p) => sum + p.amount, 0);
  return Math.max(0, Math.round((purchased - paid) * 100) / 100);
}
