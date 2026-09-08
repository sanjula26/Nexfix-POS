import type { Purchase } from './types';
import type { SupplierPayment } from './supplierPayments';
import { addSupplierPayment } from './supplierPaymentsState';
import { getSupplierPaymentTotals } from './supplierPaymentTotals';

export function verifySupplierPaymentInvariants(): boolean {
  const purchase: Purchase = { id: 'po-test', poNo: 'PO-TEST', date: '2026-09-08T00:00:00.000Z', supplierId: 'sup-test', supplierName: 'Test Supplier', items: [], total: 1000, status: 'received' };
  const payment: SupplierPayment = { id: 'pay-test', supplierId: 'sup-test', amount: 250, method: 'cash', date: '2026-09-08T01:00:00.000Z', by: 'user-test' };
  const payments = addSupplierPayment([], payment);
  const totals = getSupplierPaymentTotals('sup-test', [purchase], payments);
  const duplicate = addSupplierPayment(payments, payment);
  const invalid = addSupplierPayment(payments, { ...payment, id: 'bad', amount: -1 });
  return totals.purchased === 1000 && totals.paid === 250 && totals.outstanding === 750 && duplicate.length === 1 && invalid.length === 1;
}
