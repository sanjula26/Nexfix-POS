import assert from 'node:assert/strict';
import test from 'node:test';
import type { POSState } from '../src/lib/types.ts';
import { hasValidCustomerCreditPayment } from '../src/lib/creditPaymentBackupValidation.ts';
import { buildCreditSettlementSyncFingerprint } from '../src/lib/creditSettlementSyncFingerprint.ts';
import {
  allocateCreditPaymentFIFO,
  getOpenCreditInvoiceBalance,
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
