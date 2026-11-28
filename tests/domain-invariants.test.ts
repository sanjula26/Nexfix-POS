import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { POSState } from '../src/lib/types.ts';
import type { QueueOp } from '../src/lib/db.ts';
import { getPendingCloudRecordKeys } from '../src/lib/cloudRecordSync.ts';
import { clearUpdaterCredentialsForRecovery, isUpdaterAuthorizationError } from '../src/lib/updaterErrors.ts';
import { hasValidCustomerCreditPayment } from '../src/lib/creditPaymentBackupValidation.ts';
import { buildCreditSettlementSyncFingerprint } from '../src/lib/creditSettlementSyncFingerprint.ts';
import { buildNormalizedCatalogSyncFingerprint } from '../src/lib/cloudSyncFingerprint.ts';
import { beginCloudActivity, getCloudActivityState, withCloudActivity } from '../src/lib/cloudActivity.ts';
import { createSuccessfulSingleFlightCache } from '../src/lib/successfulSyncCache.ts';
import {
  allocateCreditPaymentFIFO,
  getOpenCreditInvoiceBalance,
} from '../src/lib/customerCredit.ts';
import { getCreditPaymentSessionBlockReason, getEffectiveOpeningFloat, parseOpeningFloatInput, sumEffectiveOpeningFloats } from '../src/lib/openingFloat.ts';
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
import { getExpectedBranchQtyForStockAdjustment, validateBranchStockEdit } from '../src/lib/branchStockEditor.ts';
import {
  applyBranchStockDeltas,
  cacheBranchStock,
  cacheBranchStockProduct,
  getCachedBranchStock,
  isBranchStockCacheReady,
  isLocalMainStockReady,
  shouldReadBranchStockProductFallback,
  invalidateCachedBranchStockProduct,
  isStaleBranchStockConflict,
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

test('credit FIFO allocation excludes other customers and non-completed invoices and honors prior partial settlements', () => {
  const sales = [
    { id: 'sale-old', billNo: 'B-001', customerId: 'customer-1', total: 100, amountPaid: 0, date: '2026-01-01T10:00:00.000Z', status: 'completed' },
    { id: 'sale-other-customer', billNo: 'B-002', customerId: 'customer-2', total: 900, amountPaid: 0, date: '2026-01-02T10:00:00.000Z', status: 'completed' },
    { id: 'sale-pending', billNo: 'B-003', customerId: 'customer-1', total: 800, amountPaid: 0, date: '2026-01-03T10:00:00.000Z', status: 'pending' },
    { id: 'sale-next', billNo: 'B-004', customerId: 'customer-1', total: 200, amountPaid: 0, date: '2026-01-04T10:00:00.000Z', status: 'completed' },
  ];
  const priorPayments = [{
    id: 'prior-payment',
    customerId: 'customer-1',
    amount: 40,
    method: 'cash',
    date: '2026-01-05T10:00:00.000Z',
    by: 'cashier-1',
    allocations: [{ saleId: 'sale-old', billNo: 'B-001', amount: 40 }],
  }];

  assert.deepEqual(allocateCreditPaymentFIFO('customer-1', 120, sales, priorPayments), [
    { saleId: 'sale-old', billNo: 'B-001', amount: 60 },
    { saleId: 'sale-next', billNo: 'B-004', amount: 60 },
  ]);
});

test('credit settlement sync fingerprint changes when branch attribution changes', () => {
  const customer = [{ id: 'customer-1', name: 'Customer 1', phone: '0771234567', creditBalance: 900 }];
  const payment = {
    id: 'credit-payment-1',
    customerId: 'customer-1',
    cashierId: 'cashier-1',
    amount: 100,
    method: 'cash',
    date: '2026-11-17T05:00:00.000Z',
    branchId: 'branch-a',
    by: 'Cashier',
  };
  const branchA = buildCreditSettlementSyncFingerprint(customer, [payment]);
  const branchB = buildCreditSettlementSyncFingerprint(customer, [{ ...payment, branchId: 'branch-b' }]);
  assert.notEqual(branchA, branchB);
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

test('Inventory does not expose stale stock from a previously cached branch', () => {
  assert.equal(isBranchStockCacheReady('branch-a', '', true), false, 'a cache alone is not proof the current Inventory view loaded this branch');
  assert.equal(isBranchStockCacheReady('branch-b', 'branch-a', true), false, 'a different branch cache must not be shown or edited');
  assert.equal(isBranchStockCacheReady('branch-a', 'branch-a', false), false, 'the loaded branch must contain a valid cache');
  assert.equal(isBranchStockCacheReady('branch-a', 'branch-a', true), true, 'the exact branch loaded by this view is ready');
  assert.equal(isBranchStockCacheReady('branch-a', '', true, 'branch-a', true), true, 'a previously server-verified device branch can use its cached quantity offline');
  assert.equal(isBranchStockCacheReady('branch-a', '', true, 'branch-a', false), false, 'online mode must refresh and re-verify the branch before using cached values');
  assert.equal(isBranchStockCacheReady('branch-a', '', true, 'branch-b', true), false, 'offline cache for a different branch must not be used');
});

test('cloud-bound POS cannot use legacy local-main stock before branch resolution', () => {
  assert.equal(isLocalMainStockReady('shop-1', false), false, 'a cloud shop must resolve its branch even when cached branch metadata is not loaded yet');
  assert.equal(isLocalMainStockReady('shop-1', true), false, 'multi-branch cloud shops must never fall back to aggregate stock');
  assert.equal(isLocalMainStockReady('', true), false, 'a multi-branch local cache must not use the local-main sentinel');
  assert.equal(isLocalMainStockReady('', false), true, 'legacy local-only single-branch mode remains available');
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

test('unconfirmed or legacy-unconfirmed opening float contributes zero to drawer cash', () => {
  assert.equal(getEffectiveOpeningFloat({ opening: 2500, openingConfirmed: false }), 0);
  assert.equal(getEffectiveOpeningFloat({ opening: 2500 }), 0);
  assert.equal(getEffectiveOpeningFloat({ opening: 0, openingConfirmed: false }), 0);
});

test('unconfirmed opening float does not block credit collection in an open cashier session', () => {
  assert.equal(getCreditPaymentSessionBlockReason({ closed: false, openingConfirmed: false }), '');
  assert.equal(getCreditPaymentSessionBlockReason({ closed: false, openingConfirmed: true }), '');
  assert.equal(getCreditPaymentSessionBlockReason({ closed: true, openingConfirmed: false }), "Today's cashier drawer is already closed. Credit payments cannot be collected in a closed session.");
  assert.equal(getCreditPaymentSessionBlockReason(undefined), "Open a cashier drawer session for today first. Go to Cashier Balance Report and open today's session.");
});

test('confirmed opening float remains included in drawer cash', () => {
  assert.equal(getEffectiveOpeningFloat({ opening: 2500, openingConfirmed: true }), 2500);
  assert.equal(getEffectiveOpeningFloat({ opening: -20, openingConfirmed: true }), 0);
  assert.equal(getEffectiveOpeningFloat({ opening: Number.POSITIVE_INFINITY, openingConfirmed: true }), 0);
  assert.equal(getEffectiveOpeningFloat({ opening: Number.NaN, openingConfirmed: true }), 0);
});

test('whole-day opening total includes only explicitly confirmed cashier floats', () => {
  assert.equal(sumEffectiveOpeningFloats([
    { opening: 500, openingConfirmed: true },
    { opening: 1200, openingConfirmed: false },
    { opening: 2500 },
  ]), 500);
});

test('blank opening float starts an unconfirmed zero-float session', () => {
  assert.deepEqual(parseOpeningFloatInput(''), { opening: 0, confirmed: false });
  assert.deepEqual(parseOpeningFloatInput('   '), { opening: 0, confirmed: false });
});

test('explicit zero or positive opening float is confirmed and rounded to cents', () => {
  assert.deepEqual(parseOpeningFloatInput('0'), { opening: 0, confirmed: true });
  assert.deepEqual(parseOpeningFloatInput('125.678'), { opening: 125.68, confirmed: true });
});

test('invalid or negative opening float is rejected', () => {
  assert.equal(parseOpeningFloatInput('-1'), null);
  assert.equal(parseOpeningFloatInput('not-a-number'), null);
  assert.equal(parseOpeningFloatInput('Infinity'), null);
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

test('updater reauthorization clears both native credentials before retrying', async () => {
  const calls: string[] = [];
  const result = await clearUpdaterCredentialsForRecovery(
    async () => { calls.push('active'); return { ok: true }; },
    async () => { calls.push('device'); return { ok: true }; },
  );
  assert.deepEqual(calls, ['active', 'device']);
  assert.deepEqual(result, { ok: true });
});

test('updater reauthorization stops when active credential clearing fails', async () => {
  let deviceClearCalled = false;
  const result = await clearUpdaterCredentialsForRecovery(
    async () => ({ ok: false, error: 'IPC failed' }),
    async () => { deviceClearCalled = true; return { ok: true }; },
  );
  assert.equal(result.ok, false);
  assert.equal(deviceClearCalled, false);
});

test('updater reauthorization reports device-token storage failures', async () => {
  const result = await clearUpdaterCredentialsForRecovery(
    async () => ({ ok: true }),
    async () => ({ ok: false, error: 'Secure storage failed' }),
  );
  assert.deepEqual(result, { ok: false, error: 'Secure storage failed' });
});

test('updater reauthorization handles rejected native clear operations', async () => {
  const result = await clearUpdaterCredentialsForRecovery(
    async () => { throw new Error('Native IPC unavailable'); },
    async () => ({ ok: true }),
  );
  assert.deepEqual(result, { ok: false, error: 'Native IPC unavailable' });
});

test('updater authorization recovery recognizes HTTP 401 responses', () => {
  assert.equal(isUpdaterAuthorizationError('HTTP 401 Unauthorized'), true);
  assert.equal(isUpdaterAuthorizationError('Request failed with status 401'), true);
});

test('updater authorization recovery recognizes explicit device-token failures', () => {
  assert.equal(isUpdaterAuthorizationError('Invalid updater device credential'), true);
  assert.equal(isUpdaterAuthorizationError('This device is not authorized for private updates'), true);
  assert.equal(isUpdaterAuthorizationError('POS device is registered to a different cloud account'), true);
});

test('updater authorization recovery does not match unrelated or partial status codes', () => {
  assert.equal(isUpdaterAuthorizationError('HTTP 500 Internal Server Error'), false);
  assert.equal(isUpdaterAuthorizationError('HTTP 1401 Internal Error'), false);
  assert.equal(isUpdaterAuthorizationError('network timeout'), false);
});


test('normalized catalog sync fingerprint ignores operational stock and credit-balance changes', () => {
  const base = {
    products: [{ id: 'product-1', name: 'Laptop', price: 100, cost: 80, stock: 4, attributes: { color: 'black' } }],
    customers: [{ id: 'customer-1', name: 'Customer', phone: '0771234567', creditLimit: 500, creditBalance: 40 }],
    suppliers: [{ id: 'supplier-1', name: 'Supplier', phone: '0777654321' }],
    kitItems: [{ id: 'kit-1', kitProductId: 'product-1', componentProductId: 'product-2', qty: 1 }],
    settings: { branchId: 'branch-a' },
  } as unknown as POSState;
  const baseline = buildNormalizedCatalogSyncFingerprint(base);
  const operationalOnly = {
    ...base,
    products: base.products.map(product => ({ ...product, stock: 50 })),
    customers: base.customers.map(customer => ({ ...customer, creditBalance: 10 })),
  };
  assert.equal(buildNormalizedCatalogSyncFingerprint(operationalOnly), baseline);
});

test('normalized catalog sync fingerprint changes for catalog metadata, customer details, suppliers, kits, and branch changes', () => {
  const base = {
    products: [{ id: 'product-1', name: 'Laptop', price: 100, cost: 80, stock: 4, attributes: { color: 'black' } }],
    customers: [{ id: 'customer-1', name: 'Customer', phone: '0771234567', creditLimit: 500, creditBalance: 40 }],
    suppliers: [{ id: 'supplier-1', name: 'Supplier', phone: '0777654321' }],
    kitItems: [{ id: 'kit-1', kitProductId: 'product-1', componentProductId: 'product-2', qty: 1 }],
    settings: { branchId: 'branch-a' },
  } as unknown as POSState;
  const baseline = buildNormalizedCatalogSyncFingerprint(base);
  assert.notEqual(buildNormalizedCatalogSyncFingerprint({ ...base, products: base.products.map(product => ({ ...product, price: 120 })) }), baseline);
  assert.notEqual(buildNormalizedCatalogSyncFingerprint({ ...base, customers: base.customers.map(customer => ({ ...customer, name: 'Updated customer' })) }), baseline);
  assert.notEqual(buildNormalizedCatalogSyncFingerprint({ ...base, suppliers: base.suppliers.map(supplier => ({ ...supplier, phone: '0711111111' })) }), baseline);
  assert.notEqual(buildNormalizedCatalogSyncFingerprint({ ...base, kitItems: base.kitItems?.map(item => ({ ...item, qty: 2 })) }), baseline);
  assert.notEqual(buildNormalizedCatalogSyncFingerprint({ ...base, settings: { branchId: 'branch-b' } }), baseline);
});


test('catalog sync retry budget is not reset by unrelated POS state updates', () => {
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.ok(appSource.includes('const stateRef = useRef(state);'));
  assert.match(appSource, /useEffect\(\(\) => \{\s*stateRef\.current = state;\s*\}, \[state\]\);/);
  assert.ok(appSource.includes('syncNormalizedCatalog(stateRef.current)'));
  assert.ok(appSource.includes('}, [catalogSyncTrigger, userId, userRole, connectivity]);'));
  assert.ok(!appSource.includes('}, [catalogSyncTrigger, userId, userRole, connectivity, state]);'));
});


test('branch stock editor accepts a verified quantity increase and decrease', () => {
  const base = {
    expectedShopId: 'shop-a',
    expectedBranchId: 'branch-a',
    selectedShopId: 'shop-a',
    selectedBranchId: 'branch-a',
    expectedQuantity: 50,
  };
  assert.deepEqual(validateBranchStockEdit({ ...base, nextQuantity: 55 }), { ok: true, delta: 5 });
  assert.deepEqual(validateBranchStockEdit({ ...base, nextQuantity: 42 }), { ok: true, delta: -8 });
  assert.deepEqual(validateBranchStockEdit({ ...base, nextQuantity: 50 }), { ok: true, delta: 0 });
});

test('branch stock editor rejects a changed shop or branch baseline', () => {
  const base = {
    expectedShopId: 'shop-a',
    expectedBranchId: 'branch-a',
    selectedShopId: 'shop-a',
    selectedBranchId: 'branch-a',
    expectedQuantity: 50,
    nextQuantity: 55,
  };
  assert.equal(validateBranchStockEdit({ ...base, selectedBranchId: 'branch-b' }).ok, false);
  assert.equal(validateBranchStockEdit({ ...base, selectedShopId: 'shop-b' }).ok, false);
});

test('branch stock editor rejects missing, negative, fractional, and unsafe quantities', () => {
  const base = {
    expectedShopId: 'shop-a',
    expectedBranchId: 'branch-a',
    selectedShopId: 'shop-a',
    selectedBranchId: 'branch-a',
    nextQuantity: 55,
  };
  assert.equal(validateBranchStockEdit({ ...base, expectedQuantity: null }).ok, false);
  assert.equal(validateBranchStockEdit({ ...base, expectedQuantity: -1 }).ok, false);
  assert.equal(validateBranchStockEdit({ ...base, expectedQuantity: 1.5 }).ok, false);
  assert.equal(validateBranchStockEdit({ ...base, expectedQuantity: Number.MAX_SAFE_INTEGER }).ok, false);
  assert.equal(validateBranchStockEdit({ ...base, expectedQuantity: 50, nextQuantity: -1 }).ok, false);
  assert.equal(validateBranchStockEdit({ ...base, expectedQuantity: 50, nextQuantity: 1.5 }).ok, false);
});

test('branch stock editor rejects oversized or invalid adjustment limits', () => {
  const base = {
    expectedShopId: 'shop-a',
    expectedBranchId: 'branch-a',
    selectedShopId: 'shop-a',
    selectedBranchId: 'branch-a',
    expectedQuantity: 0,
    nextQuantity: 1_000_001,
  };
  assert.equal(validateBranchStockEdit(base).ok, false);
  assert.equal(validateBranchStockEdit({ ...base, maxDelta: -1, nextQuantity: 1 }).ok, false);
  assert.equal(validateBranchStockEdit({ ...base, maxDelta: 1.5, nextQuantity: 1 }).ok, false);
});


test('branch stock refresh falls back to an authoritative product read only when the full branch refresh fails', () => {
  assert.equal(shouldReadBranchStockProductFallback(true), false);
  assert.equal(shouldReadBranchStockProductFallback(false), true);
});


test('stale branch stock conflict invalidates only the affected cached product', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  const fakeStorage = {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, String(value)); },
    removeItem: (name: string) => { values.delete(name); },
    clear: () => { values.clear(); },
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() { return values.size; },
  } as Storage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: fakeStorage });
  try {
    cacheBranchStock('branch-a', [
      { product_id: 'product-a', qty: 4 },
      { product_id: 'product-b', qty: 8 },
    ]);
    assert.equal(getCachedBranchStock('branch-a', 'product-a'), 4);
    assert.equal(invalidateCachedBranchStockProduct('branch-a', 'product-a'), true);
    assert.equal(getCachedBranchStock('branch-a', 'product-a'), null);
    assert.equal(getCachedBranchStock('branch-a', 'product-b'), 8);
    assert.equal(isStaleBranchStockConflict('Stock changed on another POS (expected 4, current 50.00).'), true);
    assert.equal(isStaleBranchStockConflict('permission denied'), false);
    assert.equal(isStaleBranchStockConflict(null), false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('stock adjustment uses compare-and-set for verified online cloud quantities only', () => {
  assert.equal(getExpectedBranchQtyForStockAdjustment('shop-1', false, 12), 12);
  assert.equal(getExpectedBranchQtyForStockAdjustment('shop-1', true, 12), undefined);
  assert.equal(getExpectedBranchQtyForStockAdjustment('', false, 12), undefined);
  // Invalid online cloud baselines fail closed instead of selecting the legacy non-CAS RPC.
  assert.equal(getExpectedBranchQtyForStockAdjustment('shop-1', false, null), -1);
  assert.equal(getExpectedBranchQtyForStockAdjustment('shop-1', false, -1), -1);
  assert.equal(getExpectedBranchQtyForStockAdjustment('shop-1', false, 1.5), -1);
});

test('Adjust Stock and Stock Take pass verified online quantities to the store', () => {
  const inventorySource = readFileSync(new URL('../src/pages/Inventory.tsx', import.meta.url), 'utf8');
  assert.match(inventorySource, /adjustStock\(product\.id, delta, stockTakeReason\.trim\(\) \|\| 'Stock take adjustment', getExpectedBranchQtyForStockAdjustment\(shopId, offline, systemQty\)\)/);
  assert.match(inventorySource, /adjustStock\(stockAdj\.id, parseFloat\(adjDelta\) \|\| 0, adjReason, getExpectedBranchQtyForStockAdjustment\(shopId, offline, stockAdj\.stock\)\)/);
  assert.ok(inventorySource.includes('earlier adjustment(s) were already committed and were not rolled back'));
});


test('successful catalog sync results are reused for an unchanged key', async () => {
  const cache = createSuccessfulSingleFlightCache<{ ok: boolean; value: number }>();
  let calls = 0;
  const action = async () => ({ ok: true, value: ++calls });
  assert.deepEqual(await cache.run('shop:user:branch:fingerprint-a', action), { ok: true, value: 1 });
  assert.deepEqual(await cache.run('shop:user:branch:fingerprint-a', action), { ok: true, value: 1 });
  assert.equal(calls, 1);
});

test('concurrent catalog sync callers share one in-flight request', async () => {
  const cache = createSuccessfulSingleFlightCache<{ ok: boolean; value: number }>();
  let calls = 0;
  let release!: (value: { ok: boolean; value: number }) => void;
  const action = () => {
    calls += 1;
    return new Promise<{ ok: boolean; value: number }>(resolve => { release = resolve; });
  };
  const first = cache.run('same-key', action);
  const second = cache.run('same-key', action);
  await Promise.resolve();
  assert.equal(calls, 1);
  release({ ok: true, value: 7 });
  assert.deepEqual(await Promise.all([first, second]), [
    { ok: true, value: 7 },
    { ok: true, value: 7 },
  ]);
});

test('failed catalog sync results are not cached and can be retried', async () => {
  const cache = createSuccessfulSingleFlightCache<{ ok: boolean; value: number }>();
  let calls = 0;
  const action = async () => ({ ok: ++calls > 1, value: calls });
  assert.deepEqual(await cache.run('retry-key', action), { ok: false, value: 1 });
  assert.deepEqual(await cache.run('retry-key', action), { ok: true, value: 2 });
  assert.deepEqual(await cache.run('retry-key', action), { ok: true, value: 2 });
  assert.equal(calls, 2);
});

test('catalog sync cache separates shops, users, branches and changed fingerprints', async () => {
  const cache = createSuccessfulSingleFlightCache<{ ok: boolean; value: number }>();
  let calls = 0;
  const action = async () => ({ ok: true, value: ++calls });
  const keys = [
    'shop-a:user:branch-a:fingerprint-a',
    'shop-b:user:branch-a:fingerprint-a',
    'shop-a:other-user:branch-a:fingerprint-a',
    'shop-a:user:branch-b:fingerprint-a',
    'shop-a:user:branch-a:fingerprint-b',
  ];
  for (const key of keys) await cache.run(key, action);
  assert.equal(calls, keys.length);
});


test('per-record Cloud receipts use the authenticated shop membership user, not a stale UI scope', () => {
  const cloudSyncSource = readFileSync(new URL('../src/lib/cloudSync.ts', import.meta.url), 'utf8');
  const storeSource = readFileSync(new URL('../src/lib/store.tsx', import.meta.url), 'utf8');
  const offlineSource = readFileSync(new URL('../src/lib/offline.ts', import.meta.url), 'utf8');

  assert.ok(cloudSyncSource.includes('userId?: string'));
  assert.equal(cloudSyncSource.split('userId: sessionData.session.user.id').length - 1, 2);
  assert.ok(storeSource.includes("shop.userId ? { shopId: cloudShopId, userId: shop.userId } : null"));
  assert.ok(storeSource.includes("shop.userId ? { shopId: shop.shopId, userId: shop.userId } : null"));
  assert.ok(offlineSource.includes("parsed.cloudScope.userId !== shop.userId"));
  assert.ok(!storeSource.includes('getCloudActivityScope'));
});

test('per-record Cloud pending markers never leak across shops or Cloud users', () => {
  const queue: QueueOp[] = [
    { id: 'sale:sale-a', ts: '2026-11-28T04:00:00.000Z', type: 'sale_create', payload: JSON.stringify({ cloudScope: { shopId: 'shop-a', userId: 'user-a' } }) },
    { id: 'purchase-receive:purchase-a', ts: '2026-11-28T04:01:00.000Z', type: 'purchase_receive', payload: JSON.stringify({ cloudScope: { shopId: 'shop-a', userId: 'user-a' } }) },
    { id: 'sale:sale-other-user', ts: '2026-11-28T04:02:00.000Z', type: 'sale_create', payload: JSON.stringify({ cloudScope: { shopId: 'shop-a', userId: 'user-b' } }) },
    { id: 'sale:sale-other-shop', ts: '2026-11-28T04:03:00.000Z', type: 'sale_create', payload: JSON.stringify({ cloudScope: { shopId: 'shop-b', userId: 'user-a' } }) },
    { id: 'sale:sale-legacy', ts: '2026-11-28T04:04:00.000Z', type: 'sale_create', payload: JSON.stringify({ saleId: 'sale-legacy' }) },
  ];

  assert.deepEqual(
    [...getPendingCloudRecordKeys(queue, { shopId: 'shop-a', userId: 'user-a' })],
    ['sale:sale-a', 'purchase:purchase-a'],
  );
  assert.deepEqual(
    [...getPendingCloudRecordKeys(queue, { shopId: 'shop-a', userId: 'user-b' })],
    ['sale:sale-other-user'],
  );
  assert.deepEqual(
    [...getPendingCloudRecordKeys(queue, { shopId: 'shop-b', userId: 'user-a' })],
    ['sale:sale-other-shop'],
  );
});

test('cloud activity indicator tracks overlapping uploads and clears when each completes', () => {
  const finishSale = beginCloudActivity('Cloud sale');
  const finishCatalog = beginCloudActivity('Catalog data');
  assert.equal(getCloudActivityState().active, 2);
  assert.deepEqual(getCloudActivityState().operations, ['Cloud sale', 'Catalog data']);
  finishSale();
  finishSale();
  assert.equal(getCloudActivityState().active, 1);
  finishCatalog();
  assert.deepEqual(getCloudActivityState(), { active: 0, operations: [], startedAt: null, lastError: null, lastSuccessAt: null, lastSuccessOperation: null });
});

test('cloud activity wrapper clears the indicator after success and failure', async () => {
  assert.equal(await withCloudActivity('No-op check', async () => false, result => result), false);
  assert.equal(getCloudActivityState().lastSuccessAt, null);
  await withCloudActivity('Stock adjustment', async () => ({ ok: false, error: 'server rejected stock change' }), result => result.ok);
  assert.equal(getCloudActivityState().lastError, 'server rejected stock change');
  assert.equal(await withCloudActivity('POS data', async () => 42), 42);
  const successfulState = getCloudActivityState();
  assert.equal(successfulState.active, 0);
  assert.equal(successfulState.lastError, null);
  assert.equal(typeof successfulState.lastSuccessAt, 'number');
  assert.equal(successfulState.lastSuccessOperation, 'POS data');
  await assert.rejects(
    withCloudActivity('POS data', async () => { throw new Error('network failure'); }),
    /network failure/,
  );
  const failedState = getCloudActivityState();
  assert.equal(failedState.active, 0);
  assert.equal(failedState.lastError, 'network failure');
  assert.equal(failedState.lastSuccessAt, successfulState.lastSuccessAt);
  assert.equal(failedState.lastSuccessOperation, successfulState.lastSuccessOperation);
});

test('cloud sync details explain local queue, confirmed transfers, issues and safe retry', () => {
  const layoutSource = readFileSync(new URL('../src/components/AppLayout.tsx', import.meta.url), 'utf8');
  assert.ok(layoutSource.includes('aria-expanded={cloudDetailsOpen}'));
  assert.ok(layoutSource.includes('aria-controls="nexfix-cloud-sync-details"'));
  assert.ok(layoutSource.includes('Updates are saved on this PC and waiting to sync'));
  assert.ok(layoutSource.includes("These updates are stored in this PC's local queue and are waiting for cloud confirmation."));
  assert.ok(layoutSource.includes('Last successful transfer'));
  assert.ok(layoutSource.includes('Latest issue:'));
  assert.ok(layoutSource.includes('The Internet indicator does not guarantee the cloud server is reachable.'));
  assert.ok(layoutSource.includes('onClick={() => { void runSyncNow(); }}'));
  assert.ok(layoutSource.includes("syncManagerState.status !== 'conflict'"));
  assert.ok(layoutSource.includes("connectivity === 'online'"));
});


test('cloud sale activity highlights only the atomic sale and trade-in writes', () => {
  const storeSource = readFileSync(new URL('../src/lib/store.tsx', import.meta.url), 'utf8');
  const start = storeSource.indexOf('const completeSaleCloud =');
  const end = storeSource.indexOf('const refundSale =', start);
  assert.ok(start >= 0 && end > start, 'cloud sale handler should be present');
  const saleHandler = storeSource.slice(start, end);

  assert.ok(saleHandler.includes("withCloudActivity('Cloud sale', () => completeSaleAtomic("));
  assert.ok(saleHandler.includes("withCloudActivity('Trade-in unit', () => registerTradeInAtomic("));
  assert.ok(!saleHandler.includes("withCloudActivity('Cloud sale', execute"));
  assert.ok(!saleHandler.includes('cloudSaleCommitted'));
  assert.ok(saleHandler.indexOf("withCloudActivity('Trade-in unit'") < saleHandler.indexOf("markCloudRecordSynced('sale'"), 'bill receipt must wait until the optional trade-in Cloud write succeeds');
});
