import type { SupplierPayment } from './supplierPayments';

export function addSupplierPayment(
  payments: readonly SupplierPayment[],
  payment: SupplierPayment,
): SupplierPayment[] {
  if (!payment.id || !payment.supplierId || !payment.by) return [...payments];
  if (!Number.isFinite(payment.amount) || payment.amount <= 0) return [...payments];
  if (!['cash', 'card', 'bank', 'mobile'].includes(payment.method)) return [...payments];
  if (!payment.date || Number.isNaN(Date.parse(payment.date))) return [...payments];
  if (payments.some(p => p.id === payment.id)) return [...payments];
  return [payment, ...payments];
}

export function deleteSupplierPayment(
  payments: readonly SupplierPayment[],
  paymentId: string,
): SupplierPayment[] {
  return payments.filter(p => p.id !== paymentId);
}
