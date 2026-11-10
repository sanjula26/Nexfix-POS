type CreditSyncCustomer = {
  id: string;
  name: string;
  phone: string;
  email?: string | null;
  nic?: string | null;
  address?: string | null;
  creditLimit?: number | null;
  creditBalance?: number | null;
};

type CreditSyncPayment = {
  id: string;
  customerId: string;
  cashierId?: string;
  amount: number;
  method: string;
  methods?: readonly { method: string; amount: number }[];
  date: string;
  balanceBefore: number;
  balanceAfter: number;
  branchId?: string;
  by: string;
  note?: string;
  allocations?: readonly { saleId: string; billNo: string; amount: number }[];
};

/** Stable local fingerprint for changes that must wake legacy cloud snapshot sync. */
export function buildCreditSettlementSyncFingerprint(
  customers: readonly CreditSyncCustomer[],
  payments: readonly CreditSyncPayment[],
): string {
  return JSON.stringify({
    customers: customers.map(customer => [
      customer.id, customer.name, customer.phone, customer.email, customer.nic,
      customer.address, customer.creditLimit, customer.creditBalance,
    ]),
    payments: payments.map(payment => [
      payment.id, payment.customerId, payment.cashierId, payment.amount,
      payment.method, payment.methods, payment.date, payment.balanceBefore,
      payment.balanceAfter, payment.branchId, payment.by, payment.note,
      (payment.allocations || []).map(allocation => [
        allocation.saleId, allocation.billNo, allocation.amount,
      ]),
    ]),
  });
}
