import type { Sale, SaleItem } from './types';

export interface SaleRefundFinancials {
  merchandiseGross: number;
  merchandiseDiscount: number;
  returnedMerchandise: number;
  saleSubtotal: number;
  saleDiscount: number;
  postDiscountSubtotal: number;
  allocatedDiscount: number;
  taxableReturned: number;
  taxRefund: number;
  allocatedTradeIn: number;
  shippingRefund: number;
  refundValue: number;
}

/** Calculate the money value of remaining returned sale lines without side effects. */
export function calculateSaleRefundValue(input: {
  sale: Pick<Sale, 'items' | 'subtotal' | 'discount' | 'tax' | 'tradeIn' | 'shipping'>;
  remainingItems: ReadonlyArray<{ item: SaleItem; qty: number }>;
}): SaleRefundFinancials {
  const { sale, remainingItems } = input;
  const merchandiseGross = remainingItems.reduce((sum, { item, qty }) => sum + item.price * qty, 0);
  const merchandiseDiscount = remainingItems.reduce(
    (sum, { item, qty }) => sum + (item.qty > 0 ? (item.discount || 0) * (qty / item.qty) : 0),
    0,
  );
  const returnedMerchandise = Math.max(0, merchandiseGross - merchandiseDiscount);
  const saleSubtotal = Math.max(0, sale.subtotal);
  const saleDiscount = Math.min(Math.max(0, sale.discount || 0), saleSubtotal);
  const postDiscountSubtotal = Math.max(0, saleSubtotal - saleDiscount);
  const allocatedDiscount = Math.min(
    saleDiscount,
    returnedMerchandise * (saleSubtotal > 0 ? saleDiscount / saleSubtotal : 0),
  );
  const taxableReturned = Math.max(0, returnedMerchandise - allocatedDiscount);
  const taxRefund = postDiscountSubtotal > 0
    ? Math.round((sale.tax || 0) * (taxableReturned / postDiscountSubtotal) * 100) / 100
    : 0;
  const tradeInValue = Math.max(0, Number(sale.tradeIn?.value || 0));
  const allocatedTradeIn = saleSubtotal > 0
    ? Math.min(tradeInValue, tradeInValue * (returnedMerchandise / saleSubtotal))
    : 0;
  const fullReturn = remainingItems.length === sale.items.length &&
    remainingItems.every(({ item, qty }) => qty === item.qty);
  const shippingRefund = fullReturn ? Math.max(0, sale.shipping || 0) : 0;
  const refundValue = Math.max(
    0,
    Math.round((taxableReturned + taxRefund + shippingRefund - allocatedTradeIn) * 100) / 100,
  );

  return {
    merchandiseGross, merchandiseDiscount, returnedMerchandise, saleSubtotal,
    saleDiscount, postDiscountSubtotal, allocatedDiscount, taxableReturned,
    taxRefund, allocatedTradeIn, shippingRefund, refundValue,
  };
}
