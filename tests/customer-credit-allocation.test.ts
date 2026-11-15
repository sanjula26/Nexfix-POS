import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allocateCreditPaymentFIFO,
  getOpenCreditInvoiceBalance,
  type CustomerCreditPayment,
} from '../src/lib/customerCredit.ts';

const customerId = 'customer-1';

function sale(overrides: Partial<{
  id: string;
  billNo: string;
  customerId: string;
  total: number;
  amountPaid: number;
  date: string;
  status: string;
}> = {}) {
  return {
    id: 'sale-1',
    billNo: 'NFX-001',
    customerId,
    total: 1000,
    amountPaid: 200,
    date: '2026-01-01T10:00:00.000Z',
    status: 'completed',
    ...overrides,
  };
}

function payment(overrides: Partial<CustomerCreditPayment> = {}): CustomerCreditPayment {
  return {
    id: 'payment-1',
    customerId,
    amount: 100,
    method: 'cash',
    date: '2026-01-02T10:00:00.000Z',
    by: 'Cashier',
    ...overrides,
  };
}

test('open invoice balance subtracts allocations across multiple settlements', () => {
  const invoice = sale();
  const payments = [
    payment({ id: 'p-1', allocations: [{ saleId: invoice.id, billNo: invoice.billNo, amount: 125 }] }),
    payment({ id: 'p-2', allocations: [{ saleId: invoice.id, billNo: invoice.billNo, amount: 75 }] }),
  ];

  assert.equal(getOpenCreditInvoiceBalance(invoice, payments), 600);
});

test('open invoice balance ignores non-completed invoices and clamps excess legacy allocations', () => {
  const invoice = sale({ total: 500, amountPaid: 100 });
  assert.equal(getOpenCreditInvoiceBalance({ ...invoice, status: 'refunded' }, []), 0);
  assert.equal(getOpenCreditInvoiceBalance(invoice, [
    payment({ allocations: [{ saleId: invoice.id, billNo: invoice.billNo, amount: 900 }] }),
  ]), 0);
});

test('FIFO allocation only considers completed invoices for the requested customer', () => {
  const invoices = [
    sale({ id: 'other-customer', customerId: 'customer-2', billNo: 'NFX-000', total: 900, amountPaid: 0 }),
    sale({ id: 'refunded', billNo: 'NFX-002', total: 900, amountPaid: 0, status: 'refunded' }),
    sale({ id: 'older', billNo: 'NFX-003', total: 300, amountPaid: 0, date: '2026-01-01T08:00:00.000Z' }),
    sale({ id: 'newer', billNo: 'NFX-004', total: 500, amountPaid: 0, date: '2026-01-03T08:00:00.000Z' }),
  ];

  assert.deepEqual(allocateCreditPaymentFIFO(customerId, 400, invoices, []), [
    { saleId: 'older', billNo: 'NFX-003', amount: 300 },
    { saleId: 'newer', billNo: 'NFX-004', amount: 100 },
  ]);
});

test('FIFO allocation is deterministic when invoice timestamps match', () => {
  const invoices = [
    sale({ id: 'bill-b', billNo: 'NFX-002', total: 100, amountPaid: 0, date: '2026-01-01T08:00:00.000Z' }),
    sale({ id: 'bill-a', billNo: 'NFX-001', total: 100, amountPaid: 0, date: '2026-01-01T08:00:00.000Z' }),
  ];

  assert.deepEqual(allocateCreditPaymentFIFO(customerId, 150, invoices, []), [
    { saleId: 'bill-a', billNo: 'NFX-001', amount: 100 },
    { saleId: 'bill-b', billNo: 'NFX-002', amount: 50 },
  ]);
});

test('FIFO partial payments preserve cents and never allocate above total open invoices', () => {
  const invoices = [
    sale({ id: 'fractional', billNo: 'NFX-010', total: 10.01, amountPaid: 0 }),
    sale({ id: 'small', billNo: 'NFX-011', total: 0.05, amountPaid: 0, date: '2026-01-02T10:00:00.000Z' }),
  ];

  assert.deepEqual(allocateCreditPaymentFIFO(customerId, 10.03, invoices, []), [
    { saleId: 'fractional', billNo: 'NFX-010', amount: 10.01 },
    { saleId: 'small', billNo: 'NFX-011', amount: 0.02 },
  ]);
  assert.deepEqual(allocateCreditPaymentFIFO(customerId, 50, invoices, []), [
    { saleId: 'fractional', billNo: 'NFX-010', amount: 10.01 },
    { saleId: 'small', billNo: 'NFX-011', amount: 0.05 },
  ]);
});

test('FIFO allocation subtracts prior settlements before allocating the next payment', () => {
  const invoiceA = sale({ id: 'sale-a', billNo: 'NFX-020', total: 500, amountPaid: 100 });
  const invoiceB = sale({ id: 'sale-b', billNo: 'NFX-021', total: 400, amountPaid: 0, date: '2026-01-02T10:00:00.000Z' });
  const previous = [
    payment({ allocations: [{ saleId: invoiceA.id, billNo: invoiceA.billNo, amount: 250 }] }),
  ];

  assert.deepEqual(allocateCreditPaymentFIFO(customerId, 500, [invoiceA, invoiceB], previous), [
    { saleId: 'sale-a', billNo: 'NFX-020', amount: 150 },
    { saleId: 'sale-b', billNo: 'NFX-021', amount: 350 },
  ]);
});
