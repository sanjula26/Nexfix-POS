import type { PaymentMethod, PaymentLeg } from './types';

export interface CustomerCreditAllocation {
  saleId: string;
  billNo: string;
  amount: number;
}

export interface CustomerCreditPayment {
  id: string;
  customerId: string;
  cashierId?: string;
  branchId?: string;
  amount: number;
  method: Exclude<PaymentMethod, 'credit'>;
  methods?: PaymentLeg[];
  allocations?: CustomerCreditAllocation[];
  date: string;
  by: string;
  note?: string;
  /** Snapshot of customer credit balance immediately before this settlement. */
  balanceBefore?: number;
  /** Snapshot of customer credit balance immediately after this settlement. */
  balanceAfter?: number;
}

/** Amount still open on a completed credit invoice after recorded settlement allocations. */
export function getOpenCreditInvoiceBalance(
  sale: { id: string; total: number; amountPaid: number; status: string },
  payments: readonly CustomerCreditPayment[],
): number {
  if (sale.status !== 'completed') return 0;
  const allocated = payments.reduce((sum, payment) => sum + (payment.allocations || [])
    .filter(allocation => allocation.saleId === sale.id)
    .reduce((part, allocation) => part + Math.max(0, Number(allocation.amount) || 0), 0), 0);
  return Math.max(0, Math.round((Math.max(0, sale.total - sale.amountPaid) - allocated) * 100) / 100);
}

export function allocateCreditPaymentFIFO(
  customerId: string,
  amount: number,
  sales: ReadonlyArray<{ id: string; billNo: string; customerId?: string; total: number; amountPaid: number; date: string; status: string }>,
  payments: readonly CustomerCreditPayment[],
): Array<{ saleId: string; billNo: string; amount: number }> {
  let remaining = Math.max(0, Math.round(amount * 100) / 100);
  const open = sales
    .filter(sale => sale.customerId === customerId && sale.status === 'completed')
    .map(sale => ({ sale, due: getOpenCreditInvoiceBalance(sale, payments) }))
    .filter(row => row.due > 0)
    .sort((a, b) => a.sale.date.localeCompare(b.sale.date) || a.sale.billNo.localeCompare(b.sale.billNo));
  const allocations: Array<{ saleId: string; billNo: string; amount: number }> = [];
  for (const row of open) {
    if (remaining <= 0.009) break;
    const applied = Math.min(row.due, remaining);
    if (applied > 0) {
      allocations.push({ saleId: row.sale.id, billNo: row.sale.billNo, amount: Math.round(applied * 100) / 100 });
      remaining = Math.round((remaining - applied) * 100) / 100;
    }
  }
  return allocations;
}
