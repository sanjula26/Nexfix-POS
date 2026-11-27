import type { PaymentMethod, Sale } from './types';

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
    discount: sale.discount + tradeInValue,
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
    salesmanId: sale.cashierId,
    lines: sale.items.map(item => ({
      productId: item.productId,
      qty: item.qty,
      discount: item.discount,
      price: item.price,
      unitIds: item.unitIds,
    })),
    payment: sale.payment,
    amountPaid: sale.amountPaid,
    payments: sale.payments,
  };
}
