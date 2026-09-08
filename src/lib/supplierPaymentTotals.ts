import type { Purchase } from './types';
import type { SupplierPayment } from './supplierPayments';

export interface SupplierPaymentTotals {
  purchased: number;
  paid: number;
  outstanding: number;
}

export function getSupplierPaymentTotals(
  supplierId: string,
  purchases: readonly Purchase[],
  payments: readonly SupplierPayment[],
): SupplierPaymentTotals {
  const purchased = purchases
    .filter(p => p.supplierId === supplierId && p.status === 'received' && Number.isFinite(p.total) && p.total >= 0)
    .reduce((sum, p) => sum + p.total, 0);
  const paid = payments
    .filter(p => p.supplierId === supplierId && Number.isFinite(p.amount) && p.amount > 0)
    .reduce((sum, p) => sum + p.amount, 0);
  const roundedPurchased = Math.round(purchased * 100) / 100;
  const roundedPaid = Math.round(paid * 100) / 100;
  return {
    purchased: roundedPurchased,
    paid: roundedPaid,
    outstanding: Math.max(0, Math.round((roundedPurchased - roundedPaid) * 100) / 100),
  };
}
