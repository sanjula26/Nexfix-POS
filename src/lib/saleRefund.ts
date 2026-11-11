import type { SaleItem } from './types';

export interface SaleRefundCalculation {
  remainingItems: Array<{ it: SaleItem; idx: number; qty: number }>;
  fullReturn: boolean;
  returnedMerchandise: number;
  taxableReturned: number;
  taxRefund: number;
  allocatedTradeIn: number;
  shippingRefund: number;
  refundValue: number;
}

/**
 * Calculate the local POS refund value for the still-unreturned sale lines.
 * This is a pure calculation: exchange history is supplied by the caller and
 * no sale, stock, customer, unit, cloud or offline state is mutated here.
 */
export function calculateSaleRefund(input: {
  items: readonly SaleItem[];
  priorReturnedByLine: ReadonlyMap<number, number>;
  subtotal: number;
  discount?: number;
  tax?: number;
  shipping?: number;
  tradeInValue?: number;
}): SaleRefundCalculation {
  const remainingItems = input.items
    .map((it, idx) => ({
      it,
      idx,
      qty: Math.max(0, it.qty - (input.priorReturnedByLine.get(idx) || 0)),
    }))
    .filter(x => x.qty > 0);

  const merchandiseGross = remainingItems.reduce((sum, { it, qty }) => sum + it.price * qty, 0);
  const merchandiseDiscount = remainingItems.reduce(
    (sum, { it, qty }) => sum + (it.qty > 0 ? (it.discount || 0) * (qty / it.qty) : 0),
    0,
  );
  const returnedMerchandise = Math.max(0, merchandiseGross - merchandiseDiscount);
  const saleSubtotal = Math.max(0, input.subtotal);
  const saleDiscount = Math.min(Math.max(0, input.discount || 0), saleSubtotal);
  const postDiscountSubtotal = Math.max(0, saleSubtotal - saleDiscount);
  const allocatedDiscount = Math.min(
    saleDiscount,
    returnedMerchandise * (saleSubtotal > 0 ? saleDiscount / saleSubtotal : 0),
  );
  const taxableReturned = Math.max(0, returnedMerchandise - allocatedDiscount);
  const taxRefund = postDiscountSubtotal > 0
    ? Math.round(((input.tax || 0) * (taxableReturned / postDiscountSubtotal)) * 100) / 100
    : 0;
  const tradeInValue = Math.max(0, Number(input.tradeInValue || 0));
  const allocatedTradeIn = saleSubtotal > 0
    ? Math.min(tradeInValue, tradeInValue * (returnedMerchandise / saleSubtotal))
    : 0;
  const fullReturn = remainingItems.length === input.items.length
    && remainingItems.every(({ it, qty }) => qty === it.qty);
  const shippingRefund = fullReturn ? Math.max(0, input.shipping || 0) : 0;
  const refundValue = Math.max(
    0,
    Math.round((taxableReturned + taxRefund + shippingRefund - allocatedTradeIn) * 100) / 100,
  );

  return {
    remainingItems,
    fullReturn,
    returnedMerchandise,
    taxableReturned,
    taxRefund,
    allocatedTradeIn,
    shippingRefund,
    refundValue,
  };
}
