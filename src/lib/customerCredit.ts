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


export type CreditPaymentAllocationResult =
  | {
      ok: true;
      allocations: CustomerCreditAllocation[];
      allocatedTotal: number;
    }
  | {
      ok: false;
      reason: 'invoice_not_found' | 'invoice_paid' | 'invoice_exceeded' | 'fifo_incomplete' | 'allocation_incomplete';
      invoiceDue?: number;
      billNo?: string;
      allocatedTotal?: number;
    };

/**
 * Resolve invoice-specific or customer-level FIFO allocations before a credit
 * settlement is committed. This is pure financial logic; session, permission,
 * branch and state-commit checks remain in the POS provider.
 */
export function resolveCreditPaymentAllocations(input: {
  customerId: string;
  amount: number;
  customerOutstanding: number;
  saleId?: string;
  sales: ReadonlyArray<{
    id: string;
    billNo: string;
    customerId?: string;
    total: number;
    amountPaid: number;
    date: string;
    status: string;
  }>;
  payments: readonly CustomerCreditPayment[];
}): CreditPaymentAllocationResult {
  let allocations: CustomerCreditAllocation[] = [];

  if (input.saleId) {
    const sale = input.sales.find(item =>
      item.id === input.saleId &&
      item.customerId === input.customerId &&
      item.status === 'completed',
    );
    if (!sale) return { ok: false, reason: 'invoice_not_found' };

    const invoiceDue = Math.min(
      getOpenCreditInvoiceBalance(sale, input.payments),
      input.customerOutstanding,
    );
    if (invoiceDue <= 0.009) {
      return { ok: false, reason: 'invoice_paid', invoiceDue, billNo: sale.billNo };
    }
    if (input.amount > invoiceDue + 0.009) {
      return { ok: false, reason: 'invoice_exceeded', invoiceDue, billNo: sale.billNo };
    }
    allocations = [{ saleId: sale.id, billNo: sale.billNo, amount: input.amount }];
  } else {
    allocations = allocateCreditPaymentFIFO(
      input.customerId,
      input.amount,
      input.sales,
      input.payments,
    );
    const allocatedTotal = Math.round(
      allocations.reduce((sum, item) => sum + item.amount, 0) * 100,
    ) / 100;
    if (Math.abs(allocatedTotal - input.amount) > 0.009) {
      return { ok: false, reason: 'fifo_incomplete', allocatedTotal };
    }
  }

  const allocatedTotal = Math.round(
    allocations.reduce((sum, item) => sum + item.amount, 0) * 100,
  ) / 100;
  if (Math.abs(allocatedTotal - input.amount) > 0.009) {
    return { ok: false, reason: 'allocation_incomplete', allocatedTotal };
  }

  return { ok: true, allocations, allocatedTotal };
}
