import type { Product, Settings } from './types';
import { dkey } from './utils';

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
