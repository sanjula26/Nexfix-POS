import assert from 'node:assert/strict';
import test from 'node:test';
import type { POSState } from '../src/lib/types.ts';
import { hasValidCustomerCreditPayment } from '../src/lib/creditPaymentBackupValidation.ts';
import { buildCreditSettlementSyncFingerprint } from '../src/lib/creditSettlementSyncFingerprint.ts';
import { applyCategoryPromotions, calculateSaleFinancials } from '../src/lib/salePricing.ts';
import { resolveSalePayment } from '../src/lib/salePaymentRules.ts';
import {
  allocateCreditPaymentFIFO,
  getOpenCreditInvoiceBalance,
  resolveCreditPaymentAllocations,
} from '../src/lib/customerCredit.ts';
import {
  applyInventoryLedger,
  appendInventoryTransaction,
  buildInventoryTransaction,
  isValidInventoryTransaction,
} from '../src/lib/inventoryLedger.ts';
import {
  buildSupplierLedger,
  getSupplierOutstanding,
} from '../src/lib/supplierPayments.ts';
import {
  applyBranchStockDeltas,
  cacheBranchStock,
  cacheBranchStockProduct,
  getCachedBranchStock,
} from '../src/lib/branchStock.ts';

test('credit balance excludes allocations for other invoices', () => {
  const sale = {
    id: 'sale-1',
    total: 1000,
    amountPaid: 200,
    status: 'completed',
  };
  const payments = [{
    id: 'payment-1',
    customerId: 'customer-1',
    amount: 100,
    method: 'cash',
    date: '2026-01-01T10:00:00.000Z',
    by: 'cashier-1',
    allocations: [{ saleId: 'sale-other', billNo: 'B-OTHER', amount: 100 }],
  }];

  assert.equal(getOpenCreditInvoiceBalance(sale, payments), 800);
});

test('credit invoice balance subtracts only allocations assigned to that invoice', () => {
  const sale = {
    id: 'sale-1',
    total: 1000,
    amountPaid: 200,
    status: 'completed',
  };
  const payments = [{
    id: 'payment-1',
    customerId: 'customer-1',
    amount: 150,
    method: 'cash',
    date: '2026-01-01T10:00:00.000Z',
    by: 'cashier-1',
    allocations: [{ saleId: 'sale-1', billNo: 'B-001', amount: 125 }],
  }];

  assert.equal(getOpenCreditInvoiceBalance(sale, payments), 675);
});

test('credit payment allocation is FIFO and never exceeds invoice balance', () => {
  const sales = [
    { id: 'sale-2', billNo: 'B-002', customerId: 'customer-1', total: 500, amountPaid: 0, date: '2026-01-02T10:00:00.000Z', status: 'completed' },
    { id: 'sale-1', billNo: 'B-001', customerId: 'customer-1', total: 300, amountPaid: 0, date: '2026-01-01T10:00:00.000Z', status: 'completed' },
  ];

  assert.deepEqual(allocateCreditPaymentFIFO('customer-1', 600, sales, []), [
    { saleId: 'sale-1', billNo: 'B-001', amount: 300 },
    { saleId: 'sale-2', billNo: 'B-002', amount: 300 },
  ]);
  assert.deepEqual(allocateCreditPaymentFIFO('customer-1', 1200, sales, []), [
    { saleId: 'sale-1', billNo: 'B-001', amount: 300 },
    { saleId: 'sale-2', billNo: 'B-002', amount: 500 },
  ]);
});

test('inventory transaction builder rejects zero quantities and invalid dates', () => {
  const base = {
    id: 'tx-1',
    type: 'SALE',
    productId: 'product-1',
    quantity: -1,
  };

  assert.equal(buildInventoryTransaction({ ...base, quantity: 0 }), null);
  assert.equal(buildInventoryTransaction({ ...base, occurredAt: 'not-a-date' }), null);
  assert.equal(isValidInventoryTransaction(buildInventoryTransaction(base)), true);
});

test('inventory ledger append is idempotent by transaction id', () => {
  const transaction = buildInventoryTransaction({
    id: 'tx-1',
    type: 'SALE',
    productId: 'product-1',
    quantity: -1,
  });
  assert.ok(transaction);

  const once = appendInventoryTransaction([], transaction);
  const twice = appendInventoryTransaction(once, transaction);
  assert.equal(once.length, 1);
  assert.equal(twice.length, 1);
  assert.deepEqual(twice, once, 'a duplicate id must not replace the original ledger record');
});

test('supplier outstanding excludes pending purchases, other suppliers and excess payments', () => {
  const supplier = { id: 'supplier-1', name: 'Supplier 1' };
  const purchases = [
    { id: 'purchase-1', poNo: 'PO-001', date: '2026-01-01T10:00:00.000Z', supplierId: 'supplier-1', supplierName: 'Supplier 1', items: [], total: 1000, status: 'received' },
    { id: 'purchase-2', poNo: 'PO-002', date: '2026-01-02T10:00:00.000Z', supplierId: 'supplier-1', supplierName: 'Supplier 1', items: [], total: 500, status: 'draft' },
    { id: 'purchase-3', poNo: 'PO-003', date: '2026-01-03T10:00:00.000Z', supplierId: 'supplier-2', supplierName: 'Supplier 2', items: [], total: 900, status: 'received' },
  ];
  const payments = [
    { id: 'payment-1', supplierId: 'supplier-1', amount: 250, method: 'cash', date: '2026-01-04T10:00:00.000Z', by: 'admin' },
    { id: 'payment-2', supplierId: 'supplier-1', amount: 1000, method: 'bank', date: '2026-01-05T10:00:00.000Z', by: 'admin' },
  ];
  const returns = [{ id: 'return-1', dnNo: 'DN-001', date: '2026-01-03T10:00:00.000Z', supplierId: 'supplier-1', supplierName: 'Supplier 1', items: [], total: 100 }];

  assert.equal(getSupplierOutstanding(supplier.id, purchases, payments, returns), 0);
});

test('supplier ledger is chronological and calculates running balance', () => {
  const supplier = { id: 'supplier-1', name: 'Supplier 1' };
  const purchases = [{ id: 'purchase-1', poNo: 'PO-001', date: '2026-01-02T10:00:00.000Z', supplierId: 'supplier-1', supplierName: 'Supplier 1', items: [], total: 1000, status: 'received' }];
  const payments = [{ id: 'payment-1', supplierId: 'supplier-1', amount: 250, method: 'cash', date: '2026-01-03T10:00:00.000Z', by: 'admin' }];

  assert.deepEqual(buildSupplierLedger(supplier, purchases, payments), [
    { date: '2026-01-02T10:00:00.000Z', type: 'purchase', reference: 'PO-001', amount: 1000, balance: 1000 },
    { date: '2026-01-03T10:00:00.000Z', type: 'payment', reference: 'payment-1', amount: -250, balance: 750, paymentMethod: 'cash' },
  ]);
});

test('branch stock cache applies valid deltas and rejects negative stock', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  (globalThis as { localStorage?: typeof storage }).localStorage = storage;

  cacheBranchStock('branch-1', [{ product_id: 'product-1', qty: 10 }]);
  assert.equal(getCachedBranchStock('branch-1', 'product-1'), 10);
  assert.equal(applyBranchStockDeltas('branch-1', { 'product-1': -3 }), true);
  assert.equal(getCachedBranchStock('branch-1', 'product-1'), 7);
  assert.equal(applyBranchStockDeltas('branch-1', { 'product-1': -8 }), false);
  assert.equal(getCachedBranchStock('branch-1', 'product-1'), 7);
});


test('credit settlement sync fingerprint changes when balance or payment history changes', () => {
  const customers = [{
    id: 'customer-1',
    name: 'Customer 1',
    phone: '0771234567',
    creditLimit: 5000,
    creditBalance: 1000,
  }];
  const before = buildCreditSettlementSyncFingerprint(customers, []);
  const balanceChanged = buildCreditSettlementSyncFingerprint(
    [{ ...customers[0], creditBalance: 900 }],
    [],
  );
  const paymentAdded = buildCreditSettlementSyncFingerprint(
    [{ ...customers[0], creditBalance: 900 }],
    [{
      id: 'credit-payment-1',
      customerId: 'customer-1',
      cashierId: 'cashier-1',
      amount: 100,
      method: 'cash',
      date: '2026-11-10T10:00:00.000Z',
      balanceBefore: 1000,
      balanceAfter: 900,
      branchId: 'branch-1',
      by: 'Cashier',
      allocations: [{ saleId: 'sale-1', billNo: 'NFX-001', amount: 100 }],
    }],
  );

  assert.notEqual(balanceChanged, before);
  assert.notEqual(paymentAdded, balanceChanged);
});


test('backup validation accepts valid and legacy customer credit payments', () => {
  const valid = {
    id: 'credit-payment-1', customerId: 'customer-1', by: 'Cashier',
    date: '2026-11-10T10:00:00.000Z', amount: 100, method: 'cash',
    balanceBefore: 500, balanceAfter: 400,
    allocations: [{ saleId: 'sale-1', billNo: 'NFX-001', amount: 100 }],
  };
  assert.equal(hasValidCustomerCreditPayment(valid), true);
  const legacy = { id: 'legacy-payment', customerId: 'customer-1', by: 'Cashier', date: '2026-11-10', amount: 50, method: 'bank' };
  assert.equal(hasValidCustomerCreditPayment(legacy), true);
});

test('backup validation rejects malformed or financially inconsistent credit payments', () => {
  const base = {
    id: 'credit-payment-1', customerId: 'customer-1', by: 'Cashier',
    date: '2026-11-10T10:00:00.000Z', amount: 100, method: 'cash',
    balanceBefore: 500, balanceAfter: 400,
  };
  assert.equal(hasValidCustomerCreditPayment({ ...base, amount: -1 }), false);
  assert.equal(hasValidCustomerCreditPayment({ ...base, balanceAfter: 450 }), false);
  assert.equal(hasValidCustomerCreditPayment({ ...base, methods: [{ method: 'cash', amount: 40 }] }), false);
  assert.equal(hasValidCustomerCreditPayment({ ...base, allocations: [{ saleId: 'sale-1', billNo: 'NFX-001', amount: 110 }] }), false);
  assert.equal(hasValidCustomerCreditPayment({ ...base, method: 'credit' }), false);
});

test('branch stock single-row cache refresh preserves other cached products', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  (globalThis as { localStorage?: typeof storage }).localStorage = storage;

  cacheBranchStock('branch-1', [{ product_id: 'product-1', qty: 5 }]);
  assert.equal(cacheBranchStockProduct('branch-1', 'product-2', 9), true);
  assert.equal(getCachedBranchStock('branch-1', 'product-1'), 5);
  assert.equal(getCachedBranchStock('branch-1', 'product-2'), 9);
  assert.equal(cacheBranchStockProduct('branch-1', 'product-3', -1), false);
});


function ledgerState(overrides: Record<string, unknown> = {}): POSState {
  return {
    products: [],
    sales: [],
    purchases: [],
    exchanges: [],
    kitItems: [],
    purchaseReturns: [],
    repairs: [],
    units: [],
    inventoryTransactions: [],
    ...overrides,
  } as unknown as POSState;
}

test('inventory ledger state builder records a new sale as a negative stock movement', () => {
  const previous = ledgerState();
  const next = ledgerState({
    sales: [{
      id: 'sale-1',
      billNo: 'NFX-001',
      items: [{ productId: 'product-1', qty: 2, unitIds: ['unit-1', 'unit-2'] }],
    }],
  });

  const updated = applyInventoryLedger(previous, next, 'SALE', 'Cashier');

  assert.equal(updated.inventoryTransactions?.length, 1);
  assert.deepEqual(updated.inventoryTransactions?.[0], {
    id: 'inv:sale:sale-1:product-1',
    type: 'SALE',
    productId: 'product-1',
    quantity: -2,
    referenceId: 'sale-1',
    referenceNo: 'NFX-001',
    unitIds: ['unit-1', 'unit-2'],
    occurredAt: updated.inventoryTransactions?.[0].occurredAt,
    by: 'Cashier',
  });
});

test('inventory ledger state builder records only a pending-to-received purchase transition', () => {
  const previous = ledgerState({
    purchases: [{
      id: 'purchase-1',
      poNo: 'GRN-001',
      status: 'pending',
      items: [{ productId: 'product-1', qty: 5 }],
    }],
  });
  const next = ledgerState({
    purchases: [{
      id: 'purchase-1',
      poNo: 'GRN-001',
      status: 'received',
      items: [{ productId: 'product-1', qty: 5 }],
    }],
  });

  const updated = applyInventoryLedger(previous, next, 'PURCHASE_RECEIVE', 'Admin');

  assert.equal(updated.inventoryTransactions?.length, 1);
  assert.equal(updated.inventoryTransactions?.[0].type, 'PURCHASE_RECEIVE');
  assert.equal(updated.inventoryTransactions?.[0].quantity, 5);
  assert.equal(updated.inventoryTransactions?.[0].referenceId, 'purchase-1');
  assert.equal(updated.inventoryTransactions?.[0].by, 'Admin');

  const unchanged = applyInventoryLedger(previous, updated, 'PURCHASE_RECEIVE', 'Admin');
  assert.equal(unchanged.inventoryTransactions?.length, 1);
});


test('credit settlement allocation respects selected invoice balance and customer ownership', () => {
  const sales = [
    { id: 'sale-1', billNo: 'B-001', customerId: 'customer-1', total: 500, amountPaid: 100, date: '2026-01-01T10:00:00.000Z', status: 'completed' },
    { id: 'sale-2', billNo: 'B-002', customerId: 'customer-2', total: 900, amountPaid: 0, date: '2026-01-02T10:00:00.000Z', status: 'completed' },
  ];
  const payments = [{
    id: 'payment-1', customerId: 'customer-1', amount: 100, method: 'cash',
    date: '2026-01-03T10:00:00.000Z', by: 'cashier-1',
    allocations: [{ saleId: 'sale-1', billNo: 'B-001', amount: 100 }],
  }];

  assert.deepEqual(resolveCreditPaymentAllocations({
    customerId: 'customer-1', amount: 250, customerOutstanding: 300,
    saleId: 'sale-1', sales, payments,
  }), {
    ok: true,
    allocations: [{ saleId: 'sale-1', billNo: 'B-001', amount: 250 }],
    allocatedTotal: 250,
  });
  assert.deepEqual(resolveCreditPaymentAllocations({
    customerId: 'customer-1', amount: 50, customerOutstanding: 300,
    saleId: 'sale-2', sales, payments,
  }), { ok: false, reason: 'invoice_not_found' });
});

test('credit settlement allocation rejects paid and overpaid selected invoices', () => {
  const sales = [{
    id: 'sale-1', billNo: 'B-001', customerId: 'customer-1',
    total: 500, amountPaid: 0, date: '2026-01-01T10:00:00.000Z', status: 'completed',
  }];
  const payments = [{
    id: 'payment-1', customerId: 'customer-1', amount: 500, method: 'cash',
    date: '2026-01-02T10:00:00.000Z', by: 'cashier-1',
    allocations: [{ saleId: 'sale-1', billNo: 'B-001', amount: 500 }],
  }];

  assert.deepEqual(resolveCreditPaymentAllocations({
    customerId: 'customer-1', amount: 10, customerOutstanding: 500,
    saleId: 'sale-1', sales, payments,
  }), { ok: false, reason: 'invoice_paid', invoiceDue: 0, billNo: 'B-001' });
  assert.deepEqual(resolveCreditPaymentAllocations({
    customerId: 'customer-1', amount: 101, customerOutstanding: 100,
    saleId: 'sale-1', sales, payments: [],
  }), {
    ok: false, reason: 'invoice_exceeded', invoiceDue: 100, billNo: 'B-001',
  });
});

test('credit settlement FIFO allocation fails closed when open invoices cannot cover payment', () => {
  const sales = [
    { id: 'sale-1', billNo: 'B-001', customerId: 'customer-1', total: 100, amountPaid: 0, date: '2026-01-01T10:00:00.000Z', status: 'completed' },
    { id: 'sale-2', billNo: 'B-002', customerId: 'customer-1', total: 200, amountPaid: 0, date: '2026-01-02T10:00:00.000Z', status: 'completed' },
    { id: 'sale-other', billNo: 'B-OTHER', customerId: 'customer-2', total: 1000, amountPaid: 0, date: '2026-01-03T10:00:00.000Z', status: 'completed' },
  ];

  assert.deepEqual(resolveCreditPaymentAllocations({
    customerId: 'customer-1', amount: 400, customerOutstanding: 400,
    sales, payments: [],
  }), { ok: false, reason: 'fifo_incomplete', allocatedTotal: 300 });
});


test('credit settlement FIFO allocation accounts for earlier payments before applying oldest-first', () => {
  const sales = [
    { id: 'sale-1', billNo: 'B-001', customerId: 'customer-1', total: 100, amountPaid: 0, date: '2026-01-01T10:00:00.000Z', status: 'completed' },
    { id: 'sale-2', billNo: 'B-002', customerId: 'customer-1', total: 100, amountPaid: 0, date: '2026-01-02T10:00:00.000Z', status: 'completed' },
  ];
  const payments = [{
    id: 'payment-1', customerId: 'customer-1', amount: 30, method: 'cash',
    date: '2026-01-03T10:00:00.000Z', by: 'cashier-1',
    allocations: [{ saleId: 'sale-1', billNo: 'B-001', amount: 30 }],
  }];

  assert.deepEqual(resolveCreditPaymentAllocations({
    customerId: 'customer-1', amount: 120, customerOutstanding: 170,
    sales, payments,
  }), {
    ok: true,
    allocations: [
      { saleId: 'sale-1', billNo: 'B-001', amount: 70 },
      { saleId: 'sale-2', billNo: 'B-002', amount: 50 },
    ],
    allocatedTotal: 120,
  });
});


test('category promotions apply the highest active matching percentage after manual discount', () => {
  const lines = [{ productId: 'product-1', qty: 2, price: 100, discount: 20 }];
  const products = [{ id: 'product-1', category: 'Accessories', price: 120 }];
  const settings = {
    promotions: [
      { id: 'inactive', name: 'Inactive', category: 'Accessories', discountPct: 50, active: false },
      { id: 'wrong-category', name: 'Wrong', category: 'Phones', discountPct: 60, active: true },
      { id: 'future', name: 'Future', category: 'Accessories', discountPct: 70, startDate: '2026-11-12', active: true },
      { id: 'expired', name: 'Expired', category: 'Accessories', discountPct: 80, endDate: '2026-11-10', active: true },
      { id: 'valid-10', name: 'Ten', category: 'accessories', discountPct: 10, startDate: '2026-11-11', endDate: '2026-11-11', active: true },
      { id: 'valid-15', name: 'Fifteen', category: 'ACCESSORIES', discountPct: 15, active: true },
      { id: 'invalid-100-plus', name: 'Invalid', category: 'Accessories', discountPct: 120, active: true },
    ],
  };

  assert.deepEqual(applyCategoryPromotions(
    lines, products, settings, new Date('2026-11-11T12:00:00'),
  ), [{ ...lines[0], discount: 47 }]);
});

test('category promotions cap manual discounts at gross and respect an overridden unit price', () => {
  const lines = [{ productId: 'product-1', qty: 2, price: 50, discount: 200 }];
  const products = [{ id: 'product-1', category: 'Accessories', price: 100 }];
  const settings = {
    promotions: [{ id: 'promo-1', name: 'Promo', category: 'Accessories', discountPct: 20, active: true }],
  };

  assert.deepEqual(applyCategoryPromotions(
    lines, products, settings, new Date('2026-11-11T12:00:00'),
  ), [{ ...lines[0], discount: 100 }]);
});

test('category promotions preserve lines when no promotion applies', () => {
  const lines = [{ productId: 'missing-product', qty: 1 }];
  const products = [{ id: 'product-1', category: 'Accessories', price: 100 }];
  const settings = { promotions: [] };

  assert.equal(applyCategoryPromotions(lines, products, settings), lines);
});


test('sale financial calculation preserves discounts, trade-in tax base, loyalty and profit', () => {
  assert.deepEqual(calculateSaleFinancials({
    items: [
      { price: 100, qty: 2, cost: 60, discount: 10 },
      { price: 50, qty: 1, cost: 20 },
    ],
    discount: 20,
    taxPct: 10,
    shipping: 15,
    rawTradeInValue: 50,
    requestedPointsRedeemed: 3,
    customerLoyaltyPoints: 10,
    loyaltyPointValue: 20,
    loyaltyPointsPerRs: 0.01,
    hasCustomer: true,
    defaultLoyaltyPointValue: 20,
  }), {
    grossTotal: 250,
    lineDiscount: 10,
    subtotal: 240,
    discount: 20,
    shipping: 15,
    tradeInValue: 50,
    taxableSubtotal: 170,
    tax: 17,
    pointsRedeemed: 3,
    loyaltyPointValue: 20,
    pointsValue: 60,
    preTotal: 202,
    appliedPointsValue: 60,
    total: 142,
    profit: -15,
    pointsEarned: 1,
  });
});

test('sale financial calculation caps trade-in at the post-discount subtotal and requires a customer for loyalty', () => {
  const result = calculateSaleFinancials({
    items: [{ price: 100, qty: 2, cost: 50 }],
    discount: 20,
    taxPct: 10,
    rawTradeInValue: 500,
    requestedPointsRedeemed: 5,
    customerLoyaltyPoints: undefined,
    loyaltyPointValue: 20,
    loyaltyPointsPerRs: 1,
    hasCustomer: false,
    defaultLoyaltyPointValue: 20,
  });

  assert.equal(result.tradeInValue, 180);
  assert.equal(result.taxableSubtotal, 0);
  assert.equal(result.tax, 0);
  assert.equal(result.pointsRedeemed, 0);
  assert.equal(result.total, 0);
  assert.equal(result.pointsEarned, 0);
});


test('sale payment rules resolve cash, split tender and change without credit', () => {
  assert.deepEqual(resolveSalePayment({
    payment: 'cash', amountPaid: 80, total: 100,
  }), {
    ok: true, legs: [], isSplit: false, isCredit: false,
    amountPaid: 100, balanceDue: 0, change: 0,
  });
  assert.deepEqual(resolveSalePayment({
    payment: 'cash', payments: [
      { method: 'cash', amount: 40.004 },
      { method: 'card', amount: 60 },
    ],
    amountPaid: 100, total: 90,
  }), {
    ok: true,
    legs: [{ method: 'cash', amount: 40 }, { method: 'card', amount: 60 }],
    isSplit: true, isCredit: false, amountPaid: 100, balanceDue: 0, change: 10,
  });
});

test('sale payment rules preserve credit balance, limit and overpayment guards', () => {
  assert.deepEqual(resolveSalePayment({
    payment: 'credit', amountPaid: 40, total: 100,
    customer: { creditBalance: 50, creditLimit: 200 },
  }), {
    ok: true, legs: [], isSplit: false, isCredit: true,
    amountPaid: 40, balanceDue: 60, change: 0,
  });
  assert.deepEqual(resolveSalePayment({
    payment: 'credit', amountPaid: 40, total: 100,
    customer: { creditBalance: 151, creditLimit: 200 },
  }), { ok: false, reason: 'credit_limit_exceeded' });
  assert.deepEqual(resolveSalePayment({
    payment: 'credit', amountPaid: 101, total: 100,
    customer: { creditBalance: 0, creditLimit: 0 },
  }), { ok: false, reason: 'credit_overpayment' });
  assert.deepEqual(resolveSalePayment({
    payment: 'credit', amountPaid: 10, total: 100,
  }), { ok: false, reason: 'credit_requires_customer' });
});

test('sale payment rules reject invalid split totals and split credit tenders', () => {
  assert.deepEqual(resolveSalePayment({
    payment: 'cash', payments: [
      { method: 'cash', amount: 30 }, { method: 'card', amount: 30 },
    ],
    amountPaid: 70, total: 60,
  }), { ok: false, reason: 'split_amount_mismatch' });
  assert.deepEqual(resolveSalePayment({
    payment: 'cash', payments: [
      { method: 'cash', amount: 30 }, { method: 'credit', amount: 30 },
    ],
    amountPaid: 60, total: 60,
    customer: { creditBalance: 0, creditLimit: 100 },
  }), { ok: false, reason: 'split_credit_not_supported' });
});
