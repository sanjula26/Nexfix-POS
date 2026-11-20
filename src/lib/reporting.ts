import type { Exchange, Sale } from './types';
import { dkey } from './utils';

export interface DailySalesSummary {
  day: string;
  bills: number;
  units: number;
  grossSales: number;
  refunds: number;
  netSales: number;
  recordedProfit: number;
}

const amount = (value: unknown) => Math.max(0, Number(value) || 0);
const inRange = (day: string, from: string, to: string) =>
  (!from || day >= from) && (!to || day <= to);

/**
 * Builds daily sales using the date of each sale and the date of each refund.
 * Legacy fully-refunded bills without refund events are reconciled on the
 * original bill date, matching the POS day-end compatibility behavior.
 */
export function buildDailySalesSummary(
  sales: Sale[],
  exchanges: Exchange[],
  from: string,
  to: string,
): DailySalesSummary[] {
  const days = new Map<string, DailySalesSummary>();
  const getDay = (day: string) => {
    const existing = days.get(day);
    if (existing) return existing;
    const created: DailySalesSummary = {
      day, bills: 0, units: 0, grossSales: 0, refunds: 0, netSales: 0, recordedProfit: 0,
    };
    days.set(day, created);
    return created;
  };

  for (const sale of sales) {
    const saleDay = dkey(sale.date);
    const includedStatus = sale.status === 'completed' || sale.status === 'exchanged' || sale.status === 'refunded';
    if (includedStatus && inRange(saleDay, from, to)) {
      const row = getDay(saleDay);
      row.grossSales += amount(sale.total);
      if (sale.status === 'completed' || sale.status === 'exchanged') {
        row.bills += 1;
        row.units += sale.items.reduce((sum, item) => sum + amount(item.qty), 0);
        row.recordedProfit += Number(sale.profit) || 0;
      } else if (!(sale.refunds || []).length) {
        // Older fully-refunded bills may not have a separate refund event.
        row.refunds += amount(sale.total);
      }
    }

    for (const refund of sale.refunds || []) {
      const refundDay = dkey(refund.date);
      if (inRange(refundDay, from, to)) getDay(refundDay).refunds += amount(refund.amount);
    }
  }

  for (const exchange of exchanges) {
    const refund = amount(exchange.refund);
    if (refund <= 0) continue;
    const refundDay = dkey(exchange.date);
    if (inRange(refundDay, from, to)) getDay(refundDay).refunds += refund;
  }

  return [...days.values()]
    .map(row => ({ ...row, netSales: row.grossSales - row.refunds }))
    .sort((a, b) => a.day.localeCompare(b.day));
}
