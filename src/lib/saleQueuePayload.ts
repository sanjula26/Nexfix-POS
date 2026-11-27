import type { PaymentLeg, PaymentMethod, Sale } from './types';

export interface SaleCreateQueueInput {
  branchId?: string;
  customerId?: string;
  shipping?: number;
  discount: number;
  tradeInValue?: number;
  tradeIn?: {
    unitId?: string;
    productId: string;
    value: number;
    imei?: string;
    serial?: string;
  };
  taxPct: number;
  pointsRedeemed?: number;
  note?: string;
  salesmanId?: string;
  lines: Array<{
    productId: string;
    qty: number;
    discount?: number;
    price?: number;
    unitIds?: string[];
  }>;
  payment: PaymentMethod;
  amountPaid: number;
  creditDue: number;
  payments?: Array<{ method: PaymentMethod; amount: number }>;
}

/**
 * Build the normalized offline replay payload from the exact local sale that
 * has already passed POS validation and has been persisted locally.
 */
export function buildSaleCreateQueueInput(sale: Sale, fallbackBranchId?: string): SaleCreateQueueInput {
  const tradeInValue = Math.max(0, Number(sale.tradeIn?.value) || 0);
  const taxableBase = Math.max(0, sale.subtotal - sale.discount - tradeInValue);
  return {
    branchId: sale.branchId || fallbackBranchId || 'local-main',
    customerId: sale.customerId,
    shipping: sale.shipping,
    // The replay worker adds tradeInValue to discount exactly once.
    discount: sale.discount,
    tradeInValue,
    tradeIn: sale.tradeIn?.addToInventory && sale.tradeIn.productId ? {
      unitId: sale.tradeIn.unitId,
      productId: sale.tradeIn.productId,
      value: tradeInValue,
      imei: sale.tradeIn.imei,
      serial: sale.tradeIn.serial,
    } : undefined,
    taxPct: taxableBase > 0 ? (sale.tax / taxableBase) * 100 : 0,
    pointsRedeemed: sale.pointsRedeemed,
    note: sale.note,
    // Preserve the existing queue contract: this resolves through the local
    // POS user/profile mapping during replay, not through a Supabase UID.
    salesmanId: sale.salesmanId || sale.cashierId,
    lines: sale.items.map(item => ({
      productId: item.productId,
      qty: item.qty,
      discount: item.discount,
      price: item.price,
      unitIds: item.unitIds,
    })),
    payment: sale.payment,
    amountPaid: sale.amountPaid,
    creditDue: Math.max(0, Math.round((sale.total - sale.amountPaid) * 100) / 100),
    payments: sale.payments,
  };
}

/**
 * Reconstruct the exact tender legs for an offline sale replay. Local Sale
 * records keep real tender legs in payments[] and the outstanding credit
 * balance separately as total - amountPaid.
 */
export function buildSaleReplayPayments(input: {
  payment: PaymentMethod;
  amountPaid: number;
  creditDue?: number;
  payments?: PaymentLeg[];
}): PaymentLeg[] {
  const tenders = (input.payments || []).filter(leg => leg.method !== 'credit' && leg.amount > 0);
  const creditDue = Math.max(0, Math.round((Number(input.creditDue) || 0) * 100) / 100);
  if (creditDue > 0.009) return [...tenders, { method: 'credit', amount: creditDue }];
  if (tenders.length) return tenders;
  if (input.payment !== 'credit' && input.amountPaid > 0) {
    return [{ method: input.payment, amount: input.amountPaid }];
  }
  return [];
}
