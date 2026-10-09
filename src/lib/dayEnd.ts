import type { DaySession, PaymentLeg, POSState, Sale, PaymentMethod } from './types';
import type { CustomerCreditPayment } from './customerCredit';
import { dkey } from './utils';

export type TenderTotals = Record<Exclude<PaymentMethod, 'credit'>, number>;

export interface DayEndTotals {
  opening: number;
  grossSales: number;
  refunds: number;
  cashRefunds: number;
  netSales: number;
  cash: number;
  card: number;
  bank: number;
  mobile: number;
  creditSales: number;
  creditSettled: TenderTotals;
  creditSettledTotal: number;
  expenses: number;
  cashExpenses: number;
  discounts: number;
  expected: number;
  bills: number;
  averageTicket: number;
}

const money = (value: number) => Math.round((Number(value) || 0) * 100) / 100;
const emptyTenders = (): TenderTotals => ({ cash: 0, card: 0, bank: 0, mobile: 0 });
const METHODS = ['cash', 'card', 'bank', 'mobile'] as const;

function belongsToSession(
  item: { cashierId?: string; cashierName?: string; by?: string },
  session?: DaySession,
): boolean {
  if (!session) return true;
  if (item.cashierId) return item.cashierId === session.cashierId;
  return (item.cashierName || item.by || '') === session.cashierName;
}

function tenderLegs(sale: Sale): PaymentLeg[] {
  if (sale.payments?.length) return sale.payments.filter(leg => leg.method !== 'credit' && leg.amount > 0);
  const paid = Math.max(0, Number(sale.amountPaid) || 0);
  const received = Math.min(Math.max(0, sale.total), paid > 0 ? paid : sale.payment === 'credit' ? 0 : Math.max(0, sale.total));
  if (received <= 0) return [];
  // Legacy credit bills did not always persist tender legs. Their received-now
  // amount is conservatively treated as cash, never as a credit tender.
  return [{ method: sale.payment === 'credit' ? 'cash' : sale.payment, amount: received }];
}

function settlementLegs(payment: CustomerCreditPayment): PaymentLeg[] {
  return payment.methods?.length
    ? payment.methods.filter(leg => leg.method !== 'credit' && leg.amount > 0)
    : [{ method: payment.method, amount: payment.amount }];
}

/** Shared calculation used by the live drawer and historical day-close report. */
export function calculateDayEndTotals(
  state: POSState,
  date: string,
  session?: DaySession,
): DayEndTotals {
  const billedSales = state.sales.filter(sale =>
    dkey(sale.date) === date &&
    (!session || sale.cashierId === session.cashierId) &&
    (sale.status === 'completed' || sale.status === 'exchanged' || sale.status === 'refunded'),
  );
  const sales = billedSales.filter(sale => sale.status === 'completed' || sale.status === 'exchanged');
  const grossSales = billedSales.reduce((sum, sale) => sum + Math.max(0, Number(sale.total) || 0), 0);
  const discounts = billedSales.reduce((sum, sale) =>
    sum + Math.max(0, Number(sale.discount) || 0)
      + sale.items.reduce((items, item) => items + Math.max(0, Number(item.discount) || 0), 0), 0);
  const tenders = emptyTenders();
  let creditSales = 0;
  // Count the original tender on a bill even if fully refunded later the same day;
  // the separate refund event then subtracts the money actually returned.
  for (const sale of billedSales) {
    for (const leg of tenderLegs(sale)) {
      if (METHODS.includes(leg.method as typeof METHODS[number])) {
        tenders[leg.method as keyof TenderTotals] += Math.max(0, Number(leg.amount) || 0);
      }
    }
  }
  for (const sale of sales) {
    creditSales += Math.max(0, (Number(sale.total) || 0) - (Number(sale.amountPaid) || 0));
  }

  const allRefundEvents = state.sales.flatMap(sale => (sale.refunds || [])
    .filter(refund => dkey(refund.date) === date && belongsToSession(refund, session))
    .map(refund => ({ amount: Math.max(0, Number(refund.amount) || 0), cashAmount: refund.cashAmount == null ? undefined : Math.max(0, Number(refund.cashAmount) || 0), method: refund.method || 'cash' })));
  // Compatibility for pre-upgrade records, which had no refund timestamp/event.
  for (const sale of state.sales) {
    if (sale.status !== 'refunded' || (sale.refunds || []).length || dkey(sale.date) !== date) continue;
    if (session && sale.cashierId !== session.cashierId) continue;
    allRefundEvents.push({ amount: Math.max(0, Number(sale.total) || 0), cashAmount: Math.max(0, Number(sale.total) || 0), method: 'cash' });
  }
  // Exchanges are dated independently from the original bill. The existing
  // model does not store an exchange tender method, so refunds are treated as cash.
  for (const exchange of state.exchanges || []) {
    if (dkey(exchange.date) !== date || (session && exchange.by !== session.cashierName)) continue;
    if (Number(exchange.refund) > 0) allRefundEvents.push({ amount: Number(exchange.refund), cashAmount: Number(exchange.refund), method: 'cash' });
  }
  const refunds = allRefundEvents.reduce((sum, refund) => sum + refund.amount, 0);
  const cashRefunds = allRefundEvents.reduce((sum, refund) => sum + (refund.method === 'cash' ? (refund.cashAmount ?? refund.amount) : 0), 0);

  const creditSettled = emptyTenders();
  const creditPayments = (state.customerCreditPayments || []).filter(payment =>
    dkey(payment.date) === date && belongsToSession({ cashierId: payment.cashierId, by: payment.by }, session),
  );
  for (const payment of creditPayments) {
    for (const leg of settlementLegs(payment)) {
      if (METHODS.includes(leg.method as typeof METHODS[number])) {
        creditSettled[leg.method as keyof TenderTotals] += Math.max(0, Number(leg.amount) || 0);
      }
    }
  }
  const creditSettledTotal = METHODS.reduce((sum, method) => sum + creditSettled[method], 0);

  const expenses = (state.expenses || []).filter(expense =>
    dkey(expense.date) === date && (!session || expense.by === session.cashierName),
  );
  const expenseTotal = expenses.reduce((sum, expense) => sum + Math.max(0, Number(expense.amount) || 0), 0);
  const cashExpenses = expenses
    .filter(expense => (expense.paymentMethod || 'cash') === 'cash')
    .reduce((sum, expense) => sum + Math.max(0, Number(expense.amount) || 0), 0);
  const opening = session
    ? Math.max(0, Number(session.opening) || 0)
    : (state.sessions.filter(item => item.date === date).reduce((sum, item) => sum + Math.max(0, item.opening), 0)
      || Math.max(0, Number(state.settings.openingFloat) || 0));
  const cash = money(tenders.cash);
  const expected = money(opening + cash + creditSettled.cash - cashRefunds - cashExpenses);

  return {
    opening: money(opening),
    grossSales: money(grossSales),
    refunds: money(refunds),
    cashRefunds: money(cashRefunds),
    netSales: money(grossSales - refunds),
    cash,
    card: money(tenders.card),
    bank: money(tenders.bank),
    mobile: money(tenders.mobile),
    creditSales: money(creditSales),
    creditSettled: {
      cash: money(creditSettled.cash),
      card: money(creditSettled.card),
      bank: money(creditSettled.bank),
      mobile: money(creditSettled.mobile),
    },
    creditSettledTotal: money(creditSettledTotal),
    expenses: money(expenseTotal),
    cashExpenses: money(cashExpenses),
    discounts: money(discounts),
    expected,
    bills: sales.length,
    averageTicket: sales.length ? money(grossSales / sales.length) : 0,
  };
}
