import type { Product, SaleItem, Settings } from './types';
import { dkey } from './utils.ts';

export interface SalePromotionLine {
  productId: string;
  qty: number;
  discount?: number;
  price?: number;
  unitIds?: string[];
}

/**
 * Apply the highest eligible category promotion to each sale line.
 * Manual discounts are applied first; the percentage promotion applies only
 * to the remaining line value. This function performs no state or I/O changes.
 */
export function applyCategoryPromotions<T extends SalePromotionLine>(
  lines: T[],
  products: readonly Pick<Product, 'id' | 'category' | 'price'>[],
  settings: Pick<Settings, 'promotions'>,
  now = new Date(),
): T[] {
  const promotions = Array.isArray(settings.promotions) ? settings.promotions : [];
  if (!promotions.length) return lines;
  const day = dkey(now);
  return lines.map(line => {
    const product = products.find(p => p.id === line.productId);
    if (!product) return line;
    const eligible = promotions.filter(p => {
      if (p.active === false) return false;
      if (p.category.trim().toLowerCase() !== product.category.trim().toLowerCase()) return false;
      if (p.startDate && day < p.startDate) return false;
      if (p.endDate && day > p.endDate) return false;
      return Number.isFinite(p.discountPct) && p.discountPct > 0 && p.discountPct <= 100;
    });
    if (!eligible.length) return line;
    const pct = Math.max(...eligible.map(p => p.discountPct));
    const unitPrice = line.price !== undefined && line.price >= 0 ? line.price : product.price;
    const gross = Math.max(0, unitPrice * line.qty);
    const manualDiscount = Math.min(Math.max(line.discount || 0, 0), gross);
    const promoDiscount = Math.round((gross - manualDiscount) * pct / 100 * 100) / 100;
    const discount = Math.min(gross, manualDiscount + promoDiscount);
    return { ...line, discount };
  });
}


export interface SaleFinancials {
  grossTotal: number;
  lineDiscount: number;
  subtotal: number;
  discount: number;
  shipping: number;
  tradeInValue: number;
  taxableSubtotal: number;
  tax: number;
  pointsRedeemed: number;
  loyaltyPointValue: number;
  pointsValue: number;
  preTotal: number;
  appliedPointsValue: number;
  total: number;
  profit: number;
  pointsEarned: number;
}

/** Calculate sale totals and loyalty values without changing POS state. */
export function calculateSaleFinancials(input: {
  items: readonly Pick<SaleItem, 'price' | 'qty' | 'cost' | 'discount'>[];
  discount?: number;
  taxPct?: number;
  shipping?: number;
  rawTradeInValue: number;
  requestedPointsRedeemed?: number;
  customerLoyaltyPoints?: number;
  loyaltyPointValue?: number | null;
  loyaltyPointsPerRs?: number | null;
  hasCustomer: boolean;
  defaultLoyaltyPointValue: number;
}): SaleFinancials {
  const grossTotal = input.items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const lineDiscount = input.items.reduce((sum, item) => sum + (item.discount || 0), 0);
  const subtotal = grossTotal - lineDiscount;
  const discount = Math.min(input.discount || 0, subtotal);
  const shipping = Math.max(0, input.shipping || 0);
  // Trade-in is an additional discount; tax uses the post-trade-in taxable base.
  const tradeInValue = Math.min(input.rawTradeInValue, Math.max(0, subtotal - discount));
  const taxableSubtotal = Math.max(0, subtotal - discount - tradeInValue);
  const tax = Math.round((taxableSubtotal * (input.taxPct || 0)) / 100 * 100) / 100;
  const pointsRedeemed = Math.min(
    Math.max(0, Math.floor(input.requestedPointsRedeemed || 0)),
    input.customerLoyaltyPoints || 0,
  );
  const loyaltyPointValue = Math.max(0, Number(input.loyaltyPointValue ?? input.defaultLoyaltyPointValue));
  const pointsValue = pointsRedeemed * loyaltyPointValue;
  const preTotal = taxableSubtotal + tax + shipping;
  const appliedPointsValue = Math.min(pointsValue, Math.max(0, preTotal));
  const total = Math.max(0, Math.round((preTotal - appliedPointsValue) * 100) / 100);
  // Gross margin − discounts − loyalty value actually applied (+ shipping is revenue).
  const profit = Math.round((
    input.items.reduce((sum, item) => sum + (item.price - item.cost) * item.qty, 0)
    - lineDiscount - discount - appliedPointsValue - tradeInValue + shipping
  ) * 100) / 100;
  const loyaltyPointsPerRs = Math.max(0, Number(input.loyaltyPointsPerRs ?? 0.001));
  const pointsEarned = input.hasCustomer ? Math.floor(Math.max(0, total) * loyaltyPointsPerRs) : 0;

  return {
    grossTotal, lineDiscount, subtotal, discount, shipping, tradeInValue,
    taxableSubtotal, tax, pointsRedeemed, loyaltyPointValue, pointsValue,
    preTotal, appliedPointsValue, total, profit, pointsEarned,
  };
}
