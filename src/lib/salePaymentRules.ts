import type { Customer, PaymentLeg, PaymentMethod } from './types';

export type SalePaymentFailure =
  | 'invalid_payment_method'
  | 'invalid_payment_leg'
  | 'split_credit_not_supported'
  | 'split_amount_mismatch'
  | 'credit_requires_customer'
  | 'credit_limit_exceeded'
  | 'credit_overpayment';

export type SalePaymentResolution =
  | {
      ok: true;
      legs: PaymentLeg[];
      isSplit: boolean;
      isCredit: boolean;
      amountPaid: number;
      balanceDue: number;
      change: number;
    }
  | { ok: false; reason: SalePaymentFailure };

/** Validate tender legs and resolve paid, credit-due and change amounts. */
export function resolveSalePayment(input: {
  payment: PaymentMethod;
  payments?: PaymentLeg[];
  amountPaid: number;
  total: number;
  customer?: Pick<Customer, 'creditBalance' | 'creditLimit'>;
}): SalePaymentResolution {
  const validPaymentMethods = new Set<PaymentMethod>(['cash', 'card', 'bank', 'mobile', 'credit']);
  if (!validPaymentMethods.has(input.payment)) return { ok: false, reason: 'invalid_payment_method' };

  const rawLegs = Array.isArray(input.payments) ? input.payments : [];
  if (rawLegs.some(l => !l || !validPaymentMethods.has(l.method) || !Number.isFinite(l.amount) || l.amount < 0)) {
    return { ok: false, reason: 'invalid_payment_leg' };
  }
  const legs = rawLegs
    .filter(l => l.amount > 0)
    .map(l => ({ method: l.method, amount: Math.round(l.amount * 100) / 100 }));
  const isSplit = legs.length > 1;
  if (isSplit && legs.some(l => l.method === 'credit')) {
    return { ok: false, reason: 'split_credit_not_supported' };
  }
  if (isSplit && Math.abs(
    legs.reduce((sum, leg) => sum + leg.amount, 0) - Math.max(0, Number(input.amountPaid) || 0),
  ) > 0.01) {
    return { ok: false, reason: 'split_amount_mismatch' };
  }

  const isCredit = legs.some(l => l.method === 'credit') || input.payment === 'credit';
  if (isCredit) {
    if (!input.customer) return { ok: false, reason: 'credit_requires_customer' };
    const creditLimit = input.customer.creditLimit ?? 0;
    const projectedBalance = input.customer.creditBalance + Math.max(
      0,
      input.total - (isSplit
        ? legs.filter(l => l.method !== 'credit').reduce((sum, leg) => sum + leg.amount, 0)
        : input.amountPaid),
    );
    if (creditLimit > 0 && projectedBalance > creditLimit) {
      return { ok: false, reason: 'credit_limit_exceeded' };
    }
  }

  const amountPaid = isSplit
    ? legs.reduce((sum, leg) => sum + leg.amount, 0)
    : (isCredit ? input.amountPaid : Math.max(input.amountPaid, input.total));
  if (isCredit && amountPaid > input.total) return { ok: false, reason: 'credit_overpayment' };
  const balanceDue = isCredit ? Math.max(0, input.total - amountPaid) : 0;
  const change = isCredit ? 0 : Math.max(0, amountPaid - input.total);

  return { ok: true, legs, isSplit, isCredit, amountPaid, balanceDue, change };
}
