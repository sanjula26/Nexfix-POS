import type { Purchase } from './types';
import type { SupplierPayment } from './supplierPayments';
import { addSupplierPayment } from './supplierPaymentsState';
import { getSupplierPaymentTotals } from './supplierPaymentTotals';

export function runSupplierPaymentInvariantChecks(): void {
  const purchase: Purchase = {
    id: 'po-test', poNo: 'PO-TEST', date: '2026-09-08T00:00:00.000Z',
    supplierId: 'sup-test', supplierName: 'Test Supplier',
    items: [], total: 1000, status: 'received',
  };
  const payment: SupplierPayment = {
    id: 'pay-test', supplierId: 'sup-test', amount: 250,
    method: 'cash', date: '2026-09-08T01:00:00.000Z', by: 'user-test',
  };
  const payments = addSupplierPayment([], payment);
  const totals = getSupplierPaymentTotals('sup-test', [purchase], payments);
  if (totals.purchased !== 1000 || totals.paid !== 250 || totals.outstanding !== 750) {
    throw new Error('Supplier payment totals invariant failed');
  }
  const duplicate = addSupplierPayment(payments, payment);
  if (duplicate.length !== 1) throw new Error('Duplicate supplier payment invariant failed');
  const invalid = addSupplierPayment(payments, { ...payment, id: 'bad', amount: -1 });
  if (invalid.length !== 1) throw new Error('Invalid supplier payment invariant failed');
}
