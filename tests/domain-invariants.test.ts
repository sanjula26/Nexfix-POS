import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { POSState } from '../src/lib/types.ts';
import type { QueueOp } from '../src/lib/db.ts';
import { cloudRecordScopeKey, getCloudRecordSyncIssue, getCloudRecordSyncStatus, getPendingCloudRecordKeys, hasCloudRecordScope, isCloudRecordReplayScopeValid, resetCloudRecordSyncSnapshotForScope, type CloudRecordSyncSnapshot } from '../src/lib/cloudRecordSync.ts';
import { canAutoBindCloudShop, hasStoredLocalBusinessDataFromEntries } from '../src/lib/shopBindingSafety.ts';
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
  isQueuedOperationBranchValid,
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

test('queued offline mutations retain their exact branch and only allow the single-branch legacy sentinel', () => {
  assert.equal(isQueuedOperationBranchValid('branch-a', 'branch-a', 2), true);
  assert.equal(isQueuedOperationBranchValid('branch-a', 'branch-b', 2), false, 'a queued Branch A write must not be remapped to Branch B');
  assert.equal(isQueuedOperationBranchValid('local-main', 'branch-a', 2), false, 'the sentinel is unsafe in a multi-branch shop');
  assert.equal(isQueuedOperationBranchValid('branch-a', 'branch-a', 1), true, 'an exact single active branch remains valid');
  assert.equal(isQueuedOperationBranchValid('local-main', 'branch-a', 1), true, 'legacy single-branch queues can resolve the only branch');
  assert.equal(isQueuedOperationBranchValid('retired-branch', 'branch-b', 1), false, 'a retired original branch must not be silently mapped to the only remaining branch');
  assert.equal(isQueuedOperationBranchValid(undefined, 'branch-a', 1), false, 'a missing original branch is not guessed');
  assert.equal(isQueuedOperationBranchValid('branch-a', '', 1), false);
  assert.equal(isQueuedOperationBranchValid('branch-a', 'branch-a', 0), false);
  assert.equal(isQueuedOperationBranchValid('branch-a', 'branch-a', 1.5), false);
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


test('async sensitive admin re-auth is invalidated on logout and role switch', () => {
  const storeSource = readFileSync(new URL('../src/lib/store.tsx', import.meta.url), 'utf8');

  assert.ok(storeSource.includes('const clearSensitiveAdminAuthorization = useCallback(() => {'));
  const clearStart = storeSource.indexOf('const clearSensitiveAdminAuthorization = useCallback(() => {');
  const clearEnd = storeSource.indexOf('  }, []);', clearStart);
  assert.ok(clearEnd > clearStart);
  const clearBody = storeSource.slice(clearStart, clearEnd);
  assert.ok(clearBody.includes('sensitiveAuthRef.current = null;'));
  assert.ok(clearBody.includes('resolver(false);'));
  assert.ok(clearBody.includes('sensitiveAdminResolverRef.current = null;'));
  assert.ok(clearBody.includes('setSensitiveAdminPrompt(null);'));

  const sensitiveConfirmStart = storeSource.indexOf('const confirmSensitiveAdmin = useCallback(');
  const sensitiveConfirmEnd = storeSource.indexOf('const resolveSensitiveAdmin =', sensitiveConfirmStart);
  assert.ok(sensitiveConfirmStart >= 0 && sensitiveConfirmEnd > sensitiveConfirmStart);
  assert.ok(storeSource.slice(sensitiveConfirmStart, sensitiveConfirmEnd).includes('sessionRef.current?.userId !== user.id'));

  const verifyPinStart = storeSource.indexOf('const verifyAdminPin = useCallback(');
  const verifyPinEnd = storeSource.indexOf('const unlockSession =', verifyPinStart);
  assert.ok(storeSource.slice(verifyPinStart, verifyPinEnd).includes('sessionRef.current?.userId !== actor.id'));

  const roleSwitchStart = storeSource.indexOf('const switchRole = useCallback(');
  const roleSwitchEnd = storeSource.indexOf('const changeAdminPin = useCallback(', roleSwitchStart);
  assert.ok(storeSource.slice(roleSwitchStart, roleSwitchEnd).includes('sessionRef.current?.userId !== initiatingUser.id'));
  const signOutStart = storeSource.indexOf('const signOut = useCallback(');
  const signOutEnd = storeSource.indexOf('// Role switches create a real authenticated session', signOutStart);
  assert.ok(signOutStart >= 0 && signOutEnd > signOutStart);
  assert.ok(storeSource.slice(signOutStart, signOutEnd).includes('clearSensitiveAdminAuthorization();'));

  const unlockStart = storeSource.indexOf('const unlockSession = useCallback(');
  const unlockEnd = storeSource.indexOf('const sensitiveAuthRef =', unlockStart);
  assert.ok(unlockStart >= 0 && unlockEnd > unlockStart);
  assert.ok(storeSource.slice(unlockStart, unlockEnd).includes('sessionRef.current?.userId !== initiatingUser.id'));

  const roleSwitchStart2 = storeSource.indexOf('const switchRole = useCallback(');
  const roleSwitchEnd2 = storeSource.indexOf('const changeAdminPin = useCallback(', roleSwitchStart2);
  assert.ok(roleSwitchStart2 >= 0 && roleSwitchEnd2 > roleSwitchStart2);
  const roleSwitchSource = storeSource.slice(roleSwitchStart2, roleSwitchEnd2);
  assert.ok(roleSwitchSource.includes('clearSensitiveAdminAuthorization();'));
  assert.ok(roleSwitchSource.includes('sessionRef.current?.userId !== initiatingUser.id'));

  const changePinStart = storeSource.indexOf('const changeAdminPin = useCallback(');
  const changePinEnd = storeSource.indexOf('/* ---------------- products ---------------- */', changePinStart);
  assert.ok(changePinStart >= 0 && changePinEnd > changePinStart);
  assert.ok(storeSource.slice(changePinStart, changePinEnd).includes('sessionRef.current?.userId !== adminSnapshot.id'));
});


test('initial Admin setup is serialized and rechecks account state after async PBKDF2', () => {
  const storeSource = readFileSync(new URL('../src/lib/store.tsx', import.meta.url), 'utf8');
  const start = storeSource.indexOf('const createInitialAdmin = useCallback(async');
  const end = storeSource.indexOf('const changePassword = useCallback(', start);
  assert.ok(start >= 0 && end > start);
  const setup = storeSource.slice(start, end);

  assert.ok(setup.includes('runWithAsyncLock(initialAdminSetupLockRef'));
  const firstEmptyCheck = setup.indexOf("if ((stateRef.current.users || []).length > 0)");
  const pinHash = setup.indexOf('const initialAdminPinHash = await hashPasswordAsync(next)');
  const finalEmptyCheck = setup.indexOf("if ((stateRef.current.users || []).length > 0)", firstEmptyCheck + 1);
  const commit = setup.indexOf('const nextState =', pinHash);

  assert.ok(firstEmptyCheck >= 0);
  assert.ok(pinHash > firstEmptyCheck);
  assert.ok(finalEmptyCheck > pinHash);
  assert.ok(commit > finalEmptyCheck);
  assert.ok(setup.slice(finalEmptyCheck, commit).includes("Administrator setup is already complete"));
});

test('staff account saves await PBKDF2 and report success only after the current Admin and target are revalidated', () => {
  const storeSource = readFileSync(new URL('../src/lib/store.tsx', import.meta.url), 'utf8');
  const usersSource = readFileSync(new URL('../src/pages/Users.tsx', import.meta.url), 'utf8');
  const credentialSource = readFileSync(new URL('../src/lib/userCredentialState.ts', import.meta.url), 'utf8');

  const storeStart = storeSource.indexOf('const saveUser = useCallback(async');
  const storeEnd = storeSource.indexOf('const toggleUserActive =', storeStart);
  assert.ok(storeStart >= 0 && storeEnd > storeStart);
  const saveHandler = storeSource.slice(storeStart, storeEnd);
  assert.ok(saveHandler.includes('await hashPasswordAsync(suppliedPassword)'));
  assert.ok(saveHandler.includes('await confirmSensitiveAdmin('));
  assert.ok(saveHandler.includes('sessionRef.current?.userId !== adminSnapshot.id'));
  assert.ok(saveHandler.includes('saveManagedUserIfCurrent(stateRef.current'));
  assert.ok(saveHandler.includes('setState(current => saveManagedUserIfCurrent(current'));
  assert.ok(saveHandler.includes('return { ok: true };'));

  const pageStart = usersSource.indexOf('const save = async () => {');
  const pageEnd = usersSource.indexOf('  return (', pageStart);
  assert.ok(pageStart >= 0 && pageEnd > pageStart);
  const pageSave = usersSource.slice(pageStart, pageEnd);
  assert.ok(pageSave.includes('const result = await saveUser(toSave);'));
  assert.ok(pageSave.indexOf('if (!result.ok)') < pageSave.indexOf("setFormOk(isNew ? 'User created'"));
  assert.ok(usersSource.includes('saving ? \'Saving…\''));
  assert.ok(usersSource.includes('disabled={saving}'));

  assert.ok(credentialSource.includes('currentAdmin.password !== adminSnapshot.password'));
  assert.ok(credentialSource.includes('currentTarget.password !== targetSnapshot.password'));
  assert.ok(credentialSource.includes('state.users.some(user => user.id !== nextUser.id'));
  assert.ok(saveHandler.includes('const leavesActiveAdmin = stateRef.current.users.some('));
  assert.ok(saveHandler.includes('At least one active Admin account must remain.'));
  assert.ok(credentialSource.includes("if (!nextUsers.some(user => user.role === 'admin' && user.active)) return null;"));

  const toggleStart = storeSource.indexOf('const toggleUserActive = useCallback');
  const deleteStart = storeSource.indexOf('const deleteUser = useCallback', toggleStart);
  const adminEnd = storeSource.indexOf('/* ---------------- admin ---------------- */', deleteStart);
  assert.ok(toggleStart >= 0 && deleteStart > toggleStart && adminEnd > deleteStart);
  const toggleHandler = storeSource.slice(toggleStart, deleteStart);
  const deleteHandler = storeSource.slice(deleteStart, adminEnd);
  assert.ok(toggleHandler.includes('setManagedUserActiveIfCurrent(stateRef.current'));
  assert.ok(toggleHandler.includes('sessionRef.current?.userId !== adminSnapshot.id'));
  assert.ok(toggleHandler.includes('targetSnapshot.id === adminSnapshot.id'));
  assert.ok(deleteHandler.includes('deleteManagedUserIfCurrent(stateRef.current'));
  assert.ok(deleteHandler.includes('sessionRef.current?.userId !== adminSnapshot.id'));
  assert.ok(deleteHandler.includes('targetSnapshot.id === adminSnapshot.id'));
  assert.ok(credentialSource.includes('if (!nextUsers.some(user => user.role === \'admin\' && user.active)) return null;'));
  assert.ok(credentialSource.includes('targetSnapshot.id === adminSnapshot.id) return null;'));
});

test('managed password change and POS reset enforce sensitive Admin confirmation in the store', () => {
  const storeSource = readFileSync(new URL('../src/lib/store.tsx', import.meta.url), 'utf8');
  const settingsSource = readFileSync(new URL('../src/pages/Settings.tsx', import.meta.url), 'utf8');

  const managedStart = storeSource.indexOf('const changeManagedPassword = useCallback(async');
  const managedEnd = storeSource.indexOf('const signOut = useCallback', managedStart);
  assert.ok(managedStart >= 0 && managedEnd > managedStart);
  const managedHandler = storeSource.slice(managedStart, managedEnd);
  assert.ok(managedHandler.includes("await confirmSensitiveAdmin('managed account password change')"));
  assert.ok(managedHandler.includes('sessionRef.current?.userId !== adminSnapshot.id'));

  const resetStart = storeSource.indexOf('const resetData = useCallback(async');
  const resetEnd = storeSource.indexOf('const refreshPOS = useCallback', resetStart);
  assert.ok(resetStart >= 0 && resetEnd > resetStart);
  const resetHandler = storeSource.slice(resetStart, resetEnd);
  assert.ok(resetHandler.includes("await confirmSensitiveAdmin('clear local POS data')"));
  assert.ok(resetHandler.includes('sessionRef.current?.userId !== adminSnapshot.id'));
  assert.ok(resetHandler.includes('latestAdmin.password !== adminSnapshot.password'));
  assert.ok(resetHandler.includes('return true;'));

  const managedUiStart = settingsSource.indexOf('const submitManagedPassword = async () => {');
  const managedUiEnd = settingsSource.indexOf('const submitPin = async () => {', managedUiStart);
  assert.ok(managedUiStart >= 0 && managedUiEnd > managedUiStart);
  assert.ok(settingsSource.slice(managedUiStart, managedUiEnd).includes('await changeManagedPassword('));
  assert.equal(settingsSource.slice(managedUiStart, managedUiEnd).includes('confirmSensitiveAdmin('), false);

  assert.match(settingsSource, /if \(await resetData\(\)\) setConfirmReset\(false\)/);

  const settingsStart = storeSource.indexOf('const updateSettings = useCallback(');
  const settingsEnd = storeSource.indexOf('const closeSession = useCallback', settingsStart);
  assert.ok(settingsStart >= 0 && settingsEnd > settingsStart);
  const settingsHandler = storeSource.slice(settingsStart, settingsEnd);
  assert.ok(settingsHandler.includes("Object.prototype.hasOwnProperty.call(patch, 'adminPinHash')"));
  assert.ok(settingsHandler.includes('Blocked direct Admin PIN hash update'));
  assert.ok(settingsHandler.includes('use the guarded PIN change flow'));
});



test('cashier idle-unlock fallback uses its own persistent scope instead of the shared Admin lockout', () => {
  const storeSource = readFileSync(new URL('../src/lib/store.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = storeSource.indexOf('const unlockSession = useCallback(async (credential: string)');
  const end = storeSource.indexOf('const sensitiveAuthRef =', start);
  assert.ok(start >= 0 && end > start);
  const unlock = storeSource.slice(start, end);
  assert.ok(unlock.includes("current.role === 'admin' ? 'admin' : 'cashier-unlock'"));
  const verifyStart = storeSource.indexOf('const verifyAdminPin = useCallback(');
  const unlockStart = storeSource.indexOf('const unlockSession = useCallback(', verifyStart);
  assert.ok(verifyStart >= 0 && unlockStart > verifyStart);
  assert.ok(storeSource.slice(verifyStart, unlockStart).includes("user.role === 'admin' ? 'admin' : 'cashier-unlock'"));

  const switchStart = storeSource.indexOf('const switchRole = useCallback(');
  const changePinStart = storeSource.indexOf('const changeAdminPin = useCallback(', switchStart);
  assert.ok(switchStart >= 0 && changePinStart > switchStart);
  const switchRole = storeSource.slice(switchStart, changePinStart);
  assert.ok(switchRole.includes("}, 'cashier-unlock');"));
  assert.ok(switchRole.includes("const SWITCH_RATE_KEY = 'nexfix_role_switch_guard_v1'"));
  assert.ok(unlock.includes('if (ownPasswordOk)'));
  assert.ok(unlock.includes('if (!attempt.success)'));
  const guardSource = readFileSync(new URL('../src/lib/localAuthGuard.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(guardSource.includes("const storageKeyForScope = (scope: LocalAuthAttemptScope): string => scope === 'admin'"));
  assert.ok(guardSource.includes('const browserGuards = new Map<LocalAuthAttemptScope'));
});


test('Settings Admin PIN change uses its store-level guarded current credential once without a duplicate confirmation modal', () => {
  const settingsSource = readFileSync(new URL('../src/pages/Settings.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const storeSource = readFileSync(new URL('../src/lib/store.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const submitStart = settingsSource.indexOf('const submitPin = async () => {');
  const submitEnd = settingsSource.indexOf('const onImport =', submitStart);
  assert.ok(submitStart >= 0 && submitEnd > submitStart);
  const submit = settingsSource.slice(submitStart, submitEnd);
  assert.ok(submit.includes('await changeAdminPin(pinCur, pinNew)'));
  assert.ok(!submit.includes('confirmSensitiveAdmin('));
  assert.ok(submit.includes('if (pinBusy) return;'));
  assert.ok(submit.includes('finally {\n      setPinBusy(false);'));
  assert.ok(settingsSource.includes('disabled={pinBusy || !pinNew || !pinConfirm || !pinCur}'));

  const changeStart = storeSource.indexOf('const changeAdminPin = useCallback(');
  const changeEnd = storeSource.indexOf('/* ---------------- products ---------------- */', changeStart);
  assert.ok(changeStart >= 0 && changeEnd > changeStart);
  const change = storeSource.slice(changeStart, changeEnd);
  assert.ok(change.includes('runLocalAuthAttempt(async () =>'));
  assert.ok(change.includes('verifyPasswordWithLegacyUpgrade(currentSecret, storedPinHash)'));
  assert.ok(change.includes('verifyPasswordAsync(currentSecret, adminSnapshot.password)'));
  assert.ok(change.includes('sessionRef.current?.userId !== adminSnapshot.id'));
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


test('first Cloud shop binding requires an empty queue and a clean local POS seed', () => {
  const cleanSeed = {
    products: [], customers: [], suppliers: [], sales: [], purchases: [],
    expenses: [], exchanges: [], purchaseReturns: [], held: [], sessions: [],
    units: [], repairs: [], kitItems: [], quotations: [], warrantyClaims: [],
    inventoryTransactions: [], supplierPayments: [], customerCreditPayments: [],
    grns: [], reverseRequests: [], counters: {},
    settings: {
      shopName: 'Nexfix Solution', tagline: '', address: '', phone: '', email: '',
      receiptFooter: '', taxDefault: 0, lowStockDefault: 5, exchangeDays: 3,
      openingFloat: 10000, loyaltyPointsPerRs: 0.001, loyaltyPointValue: 20,
      taxRegistrationNo: '', invoicePlaceOfSupply: '',
    },
  };
  assert.equal(canAutoBindCloudShop(cleanSeed, 0, false), true);
  assert.equal(canAutoBindCloudShop(cleanSeed, 1, false), false);
  assert.equal(canAutoBindCloudShop(cleanSeed, Number.NaN, false), false);
  assert.equal(canAutoBindCloudShop(cleanSeed, -1, false), false);
  assert.equal(canAutoBindCloudShop({ ...cleanSeed, sales: [{ id: 'old-sale' }] }, 0, false), false);
  assert.equal(canAutoBindCloudShop(cleanSeed, 0, true), false);

  const legacySale = { ...cleanSeed, sales: [{ id: 'sale-v1' }] };
  assert.equal(hasStoredLocalBusinessDataFromEntries([
    { key: 'nexfix_pos_v2', raw: JSON.stringify(cleanSeed) },
    { key: 'nexfix_pos_v1', raw: JSON.stringify(legacySale) },
  ]), true, 'a clean v2 seed must not hide an older populated v1 snapshot');
  assert.equal(hasStoredLocalBusinessDataFromEntries([
    { key: 'nexfix_pos_v2', raw: JSON.stringify(cleanSeed) },
    { key: 'nexfix_shop_state_cache_v1:shop-a', raw: JSON.stringify(legacySale) },
  ]), true, 'per-shop cached business data must block automatic first binding');
  assert.equal(hasStoredLocalBusinessDataFromEntries([
    { key: 'nexfix_pos_v2', raw: JSON.stringify(cleanSeed) },
    { key: 'nexfix_pos_v1', raw: null },
    { key: 'nexfix_shop_state_cache_v1:shop-a', raw: JSON.stringify(cleanSeed) },
  ]), false);
  assert.equal(hasStoredLocalBusinessDataFromEntries([
    { key: 'nexfix_shop_state_cache_v1:shop-a', raw: '{broken' },
  ]), true, 'corrupt per-shop cache must fail closed');
  assert.equal(hasStoredLocalBusinessDataFromEntries([
    { key: 'unrelated-ui-setting', raw: '{broken' },
  ]), false, 'unrelated localStorage entries do not affect Cloud dataset binding');

  const cloudSource = readFileSync(new URL('../src/lib/cloudSync.ts', import.meta.url), 'utf8');
  const ensureStart = cloudSource.indexOf('export async function ensureCloudShop');
  const ensureEnd = cloudSource.indexOf('export async function adjustBranchStockAtomic', ensureStart);
  const ensureBlock = cloudSource.slice(ensureStart, ensureEnd);
  const queueRead = ensureBlock.indexOf('idbListQueue()');
  const queueGuard = ensureBlock.indexOf('if (pendingQueue.length > 0)');
  const stateCheck = ensureBlock.indexOf('canAutoBindCloudShop(localState, pendingQueue.length, hasStoredLocalBusinessData())');
  const bindWrite = ensureBlock.indexOf('if (!setCloudShopId(membership.shop_id))');
  assert.ok(queueRead >= 0 && queueGuard > queueRead);
  assert.ok(stateCheck > queueGuard && bindWrite > stateCheck,
    'first Cloud shop binding must validate queue and local state before persisting the binding');

  assert.ok(cloudSource.includes("const storageValue = target.getItem(SHOP_KEY)?.trim() || '';"));
  assert.ok(cloudSource.includes('if (storageValue !== normalized) return false;'),
    'setCloudShopId must confirm that localStorage stored the requested shop ID');
  const shopSwitcherSource = readFileSync(new URL('../src/components/ShopSwitcher.tsx', import.meta.url), 'utf8');
  assert.ok(shopSwitcherSource.includes('if (pendingQueue.length > 0)'));
  assert.ok(shopSwitcherSource.includes('if (!setCloudShopId(resolved))'));
  assert.ok(shopSwitcherSource.includes('hasLocalBusinessData(state) || hasStoredLocalBusinessData()'),
    'ShopSwitcher must consider legacy localStorage data before automatic first binding');
});

test('per-record Cloud receipts use the authenticated shop membership user, not a stale UI scope', () => {
  const cloudSyncSource = readFileSync(new URL('../src/lib/cloudSync.ts', import.meta.url), 'utf8');
  const storeSource = readFileSync(new URL('../src/lib/store.tsx', import.meta.url), 'utf8');
  const offlineSource = readFileSync(new URL('../src/lib/offline.ts', import.meta.url), 'utf8');

  assert.ok(cloudSyncSource.includes('userId?: string'));
  assert.equal(cloudSyncSource.split('userId: sessionData.session.user.id').length - 1, 2);
  assert.ok(storeSource.includes("shop.userId ? { shopId: cloudShopId, userId: shop.userId } : null"));
  assert.ok(storeSource.includes("shop.userId ? { shopId: shop.shopId, userId: shop.userId } : null"));
  assert.ok(offlineSource.includes("isCloudRecordReplayScopeValid(parsed.cloudScope, verifiedScope, activeScopeBeforeCatalog)"));
  assert.ok(storeSource.includes('cloudScope: getCloudActivityScope() || undefined'),
    'locally completed Sales capture the current Cloud scope without replacing the verified online membership scope');
});

test('legacy offline Sale and GRN jobs without an original Cloud scope are blocked before replay', () => {
  const legacyScope = {} as Parameters<typeof hasCloudRecordScope>[0];
  const scoped = { shopId: 'shop-a', userId: 'user-a' };

  assert.equal(hasCloudRecordScope(undefined), false);
  assert.equal(hasCloudRecordScope(null), false);
  assert.equal(hasCloudRecordScope(legacyScope), false);
  assert.equal(hasCloudRecordScope({ shopId: ' ', userId: 'user-a' }), false);
  assert.equal(hasCloudRecordScope({ shopId: 'shop-a', userId: '' }), false);
  assert.equal(hasCloudRecordScope(scoped), true);

  const offlineSource = readFileSync(new URL('../src/lib/offline.ts', import.meta.url), 'utf8');
  const saleStart = offlineSource.indexOf("if(op.type==='sale_create')");
  const grnStart = offlineSource.indexOf("if(op.type==='purchase_receive')");
  assert.ok(saleStart >= 0 && grnStart > saleStart);
  const saleReplay = offlineSource.slice(saleStart, grnStart);
  const repairStart = offlineSource.indexOf("if(op.type==='repair_delivery')", grnStart);
  assert.ok(repairStart > grnStart);
  const grnReplay = offlineSource.slice(grnStart, repairStart);
  assert.ok(saleReplay.indexOf('if (!hasCloudRecordScope(parsed.cloudScope)) break;') < saleReplay.indexOf("ensureCloudShop('Nexfix Shop')"));
  assert.ok(grnReplay.indexOf('if (!hasCloudRecordScope(parsed.cloudScope)) break;') < grnReplay.indexOf("ensureCloudShop('Nexfix Shop')"));
  assert.ok(!offlineSource.includes('reverifyLegacyReceiptScope'));
});

test('per-record Cloud receipt snapshots clear stale statuses immediately when the Cloud scope changes', () => {
  const shopAUserA = cloudRecordScopeKey({ shopId: 'shop-a', userId: 'user-a' });
  const shopBUserA = cloudRecordScopeKey({ shopId: 'shop-b', userId: 'user-a' });
  const shopBUserB = cloudRecordScopeKey({ shopId: 'shop-b', userId: 'user-b' });

  assert.notEqual(shopAUserA, shopBUserA);
  assert.notEqual(shopBUserA, shopBUserB);
  assert.equal(
    cloudRecordScopeKey({ shopId: ' shop-a ', userId: ' user-a ' }),
    shopAUserA,
  );

  const switched = resetCloudRecordSyncSnapshotForScope(shopAUserA, shopBUserA);
  assert.ok(switched, 'changing shop must discard the prior receipt snapshot immediately');
  assert.equal(switched.ready, false);
  assert.equal(getCloudRecordSyncStatus(switched, 'sale', 'same-local-sale-id'), 'checking');
  assert.deepEqual(Object.keys(switched.confirmed), []);
  assert.equal(switched.pending.size, 0);

  assert.equal(
    resetCloudRecordSyncSnapshotForScope(shopBUserA, shopBUserA),
    null,
    'ordinary refreshes within the same Cloud identity must retain the loaded snapshot',
  );

  const signedOut = resetCloudRecordSyncSnapshotForScope(shopBUserA, null);
  assert.ok(signedOut);
  assert.equal(signedOut.ready, true);
  assert.equal(getCloudRecordSyncStatus(signedOut, 'sale', 'same-local-sale-id'), 'unknown');

  const source = readFileSync(new URL('../src/lib/cloudRecordSync.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('const resetSnapshot = resetCloudRecordSyncSnapshotForScope(scopeKeyRef.current, nextScopeKey);'));
  assert.ok(source.includes('if (resetSnapshot) setSnapshot(resetSnapshot);'));
});

test('per-record Cloud retry status is distinct from waiting, synced and unverified', () => {
  const snapshot: CloudRecordSyncSnapshot = {
    ready: true,
    confirmed: {
      'sale:sale-retry': {
        status: 'retry',
        attemptedAt: '2026-11-28T05:00:00.000Z',
        operation: 'Offline sale sync',
        error: 'Cloud request timed out',
      },
      'sale:sale-confirmed': {
        confirmedAt: '2026-11-28T04:59:00.000Z',
        operation: 'Cloud sale',
      },
    },
    pending: new Set(['sale:sale-retry', 'sale:sale-waiting']),
  };
  assert.equal(getCloudRecordSyncStatus(snapshot, 'sale', 'sale-retry'), 'retry');
  assert.equal(getCloudRecordSyncIssue(snapshot, 'sale', 'sale-retry'), 'Cloud request timed out');
  assert.equal(getCloudRecordSyncStatus(snapshot, 'sale', 'sale-waiting'), 'pending');
  assert.equal(getCloudRecordSyncStatus(snapshot, 'sale', 'sale-confirmed'), 'synced');
  assert.equal(getCloudRecordSyncStatus(snapshot, 'sale', 'sale-unknown'), 'unknown');
  assert.equal(getCloudRecordSyncStatus({ ...snapshot, ready: false }, 'sale', 'sale-unknown'), 'checking');
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
  const layoutSource = readFileSync(new URL('../src/components/AppLayout.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
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


test('customer sync and online bill-reversal RPC writes are tracked by the Cloud activity indicator', () => {
  const storeSource = readFileSync(new URL('../src/lib/store.tsx', import.meta.url), 'utf8');

  const saleStart = storeSource.indexOf('const completeSaleCloud =');
  const saleEnd = storeSource.indexOf('const refundSale =', saleStart);
  assert.ok(saleStart >= 0 && saleEnd > saleStart);
  const saleHandler = storeSource.slice(saleStart, saleEnd);
  assert.ok(saleHandler.includes("withCloudActivity('Customer data', () => ensureCloudCustomerForSale("));

  const reversalSections = [
    {
      start: 'const requestBillReverse =',
      end: 'const approveBillReverse =',
      operation: "withCloudActivity('Bill reversal request', () => requestSaleReversal(",
    },
    {
      start: 'const approveBillReverse =',
      end: 'const rejectBillReverse =',
      operation: "withCloudActivity('Bill reversal approval', () => approveSaleReversal(",
    },
    {
      start: 'const rejectBillReverse =',
      end: '/* ---------------- held sales ---------------- */',
      operation: "withCloudActivity('Bill reversal rejection', () => rejectSaleReversal(",
    },
  ];

  for (const section of reversalSections) {
    const start = storeSource.indexOf(section.start);
    const end = storeSource.indexOf(section.end, start);
    assert.ok(start >= 0 && end > start, section.start + ' handler should be present');
    const handler = storeSource.slice(start, end);
    assert.ok(handler.includes(section.operation), section.start + ' Cloud RPC must be tracked');
    assert.ok(handler.includes('result => result.ok'), section.start + ' must use the explicit server success result');
  }
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

test('first online Sale and GRN publish the verified Cloud scope before tracking the atomic write', () => {
  const storeSource = readFileSync(new URL('../src/lib/store.tsx', import.meta.url), 'utf8');
  const saleStart = storeSource.indexOf('const completeSaleCloud =');
  const saleEnd = storeSource.indexOf('const refundSale =', saleStart);
  const receiveStart = storeSource.indexOf('const receivePurchase =');
  const receiveEnd = storeSource.indexOf('const processGRN =', receiveStart);
  assert.ok(saleStart >= 0 && saleEnd > saleStart);
  assert.ok(receiveStart >= 0 && receiveEnd > receiveStart);
  const saleHandler = storeSource.slice(saleStart, saleEnd);
  const receiveHandler = storeSource.slice(receiveStart, receiveEnd);
  const saleScope = saleHandler.indexOf('if (cloudRecordScope) void setCloudActivityScope(cloudRecordScope);');
  const saleWrite = saleHandler.indexOf("withCloudActivity('Cloud sale', () => completeSaleAtomic(");
  const grnScope = receiveHandler.indexOf('if (cloudRecordScope) void setCloudActivityScope(cloudRecordScope);');
  const grnCatalogWrite = receiveHandler.indexOf('syncNormalizedCatalog(stateRef.current, shop.shopId)');
  const grnWrite = receiveHandler.indexOf("withCloudActivity('GRN receive', () => receivePurchaseAtomic(");
  assert.ok(saleScope >= 0 && saleScope < saleWrite, 'verified Sale scope must be published before its atomic Cloud write');
  assert.ok(grnScope >= 0 && grnScope < grnCatalogWrite, 'verified GRN scope must be published before catalog Cloud writes');
  assert.ok(grnScope < grnWrite, 'verified GRN scope must be published before its atomic Cloud write');
  assert.ok(storeSource.includes("import { getCloudActivityScope, setCloudActivityScope, withCloudActivity } from './cloudActivity';"));
});


test('legacy Sale and GRN replay stays local until an original Cloud scope is reconciled', () => {
  const offlineSource = readFileSync(new URL('../src/lib/offline.ts', import.meta.url), 'utf8');

  const saleStart = offlineSource.indexOf("if(op.type==='sale_create')");
  const purchaseStart = offlineSource.indexOf("if(op.type==='purchase_receive')");
  const repairStart = offlineSource.indexOf("if(op.type==='repair_delivery')");
  assert.ok(saleStart >= 0 && purchaseStart > saleStart && repairStart > purchaseStart);
  const saleReplay = offlineSource.slice(saleStart, purchaseStart);
  const purchaseReplay = offlineSource.slice(purchaseStart, repairStart);

  const assertLegacyQueueBlocked = (source: string, kind: 'Sale' | 'GRN') => {
    const scopeGuard = source.indexOf('if (!hasCloudRecordScope(parsed.cloudScope)) {');
    const blockFlag = source.indexOf('blockedUnsafeScopedTransactionReplay = true;', scopeGuard);
    const stop = source.indexOf('break;', blockFlag);
    const cloudShop = source.indexOf("ensureCloudShop('Nexfix Shop')");
    assert.ok(scopeGuard >= 0 && blockFlag > scopeGuard && stop > blockFlag && cloudShop > stop,
      `${kind} legacy rows must stop before Cloud shop resolution`);
    assert.ok(!source.includes('reverifyLegacyReceiptScope'),
      `${kind} replay must not treat the current uploader as proof of the old queue row's ownership`);
    assert.ok(source.includes('const receiptScope = activeScope;'),
      `${kind} receipts must use the same active scope that passed the original-scope guard`);
    assert.ok(!source.includes('idbAcknowledgeQueue([op.id])'),
      `${kind} must not delete a legacy row without saving its scoped receipt`);
  };

  assertLegacyQueueBlocked(saleReplay, 'Sale');
  assertLegacyQueueBlocked(purchaseReplay, 'GRN');
  assert.ok(offlineSource.includes('let blockedUnsafeScopedTransactionReplay = false;'));
  const branchMismatchStops =
    (saleReplay.split('isQueuedBranchMismatch(').length - 1)
      + (purchaseReplay.split('isQueuedBranchMismatch(').length - 1);
  assert.equal(branchMismatchStops, 4, 'queued Sale/GRN catalog and atomic writes must block on branch mismatch');
  assert.equal(
    (saleReplay.match(/blockedUnsafeScopedTransactionReplay = true;/g) || []).length
      + (purchaseReplay.match(/blockedUnsafeScopedTransactionReplay = true;/g) || []).length,
    13,
    'nine Cloud identity stops plus four original-branch mismatch stops must block the sync cycle',
  );
  const replayScopeGuards = [
    ...saleReplay.split('if (!isCloudRecordReplayScopeValid(').slice(1),
    ...purchaseReplay.split('if (!isCloudRecordReplayScopeValid(').slice(1),
  ];
  assert.equal(replayScopeGuards.length, 7);
  for (const guard of replayScopeGuards) {
    assert.ok(
      guard.slice(0, guard.indexOf('}')).includes('blockedUnsafeScopedTransactionReplay = true;'),
      'each Sale/GRN shop/user mismatch must block the later full-state snapshot',
    );
  }

  const snapshotStart = offlineSource.indexOf('const snapshotOps=remaining.filter');
  const snapshotScopeCheck = offlineSource.indexOf('const snapshotScopeBlocked = snapshotOps.some');
  const snapshotScopeReturn = offlineSource.indexOf('if (snapshotScopeBlocked) {');
  const snapshotUpload = offlineSource.indexOf('syncStateSnapshot(latestState)');

  assert.ok(snapshotScopeCheck > snapshotStart && snapshotScopeReturn > snapshotScopeCheck && snapshotScopeReturn < snapshotUpload,
    'snapshot queue identity must be checked before any full-state upload');
  const queueWriter = offlineSource.slice(
    offlineSource.indexOf('export async function queueWrite'),
    offlineSource.indexOf('export async function queueBranchStockAdjustment'),
  );
  assert.ok(queueWriter.includes("id:`state-write:${scopeKey}`"));
  assert.ok(queueWriter.includes('payload:JSON.stringify({cloudScope:cloudScope||undefined})'));
  assert.ok(queueWriter.includes("const scopeKey = cloudScope"));
  assert.ok(queueWriter.includes('cloudScope: sale.cloudScope || undefined'));
  const storeSource = readFileSync(new URL('../src/lib/store.tsx', import.meta.url), 'utf8');
  assert.ok(storeSource.includes('cloudScope: getCloudActivityScope() || undefined'),
    'new locally completed Sales must capture their original Cloud scope');
  assert.ok(storeSource.includes('cloudScope: cloudRecordScope || undefined'),
    'Cloud-committed Sales must retain the verified shop/user identity');
  const cloudSyncSource = readFileSync(new URL('../src/lib/cloudSync.ts', import.meta.url), 'utf8');
  assert.ok(cloudSyncSource.includes('sales: state.sales.map(({ cloudScope: _localCloudScope, ...sale }) => sale)'),
    'local Sale provenance must not be copied into the Cloud snapshot');
  assert.ok(cloudSyncSource.includes('sales: cloudState.sales.map(sale => ({ ...sale, cloudScope }))'),
    'Sales downloaded from the authenticated shop must receive that verified source scope');
  assert.ok(offlineSource.includes('function getQueuedSnapshotCloudScope(op: QueueOp)'));
  assert.ok(offlineSource.includes('blockedQueueScope: true'));
  const pendingCheck = offlineSource.indexOf('const pendingTransactions = remaining.some');
  const blockedReturn = offlineSource.indexOf('if (blockedUnsafeScopedTransactionReplay || pendingTransactions) {');
  assert.ok(snapshotStart > repairStart, 'snapshot processing must begin after business queue processing');
  assert.ok(pendingCheck > snapshotStart, 'remaining business transactions must be identified before snapshot publication');
  assert.ok(blockedReturn > pendingCheck && blockedReturn < snapshotUpload,
    'unconfirmed business transactions or a Sale/GRN scope mismatch must stop generic snapshot upload');
  assert.ok(offlineSource.slice(blockedReturn, snapshotUpload).includes('pendingTransactions: true'));
  assert.ok(offlineSource.slice(blockedReturn, snapshotUpload).includes('blockedQueueScope: blockedUnsafeScopedTransactionReplay || undefined'));

  const assertInventoryQueueScope = (operation: string, queueFunction: string, writeCall: string) => {
    const writerStart = offlineSource.indexOf('export async function ' + queueFunction);
    const writerEnd = offlineSource.indexOf('\n}', writerStart);
    const writer = offlineSource.slice(writerStart, writerEnd < 0 ? offlineSource.length : writerEnd);
    assert.ok(writerStart >= 0 && writer.includes('payload:JSON.stringify({...input,cloudScope:getCloudActivityScope()||undefined})'),
      operation + ' queue creation must persist enqueue-time Cloud scope');

    const start = offlineSource.indexOf("if(op.type==='" + operation + "')");
    assert.ok(start >= 0, operation + ' replay block must exist');
    const nextStart = offlineSource.indexOf("if(op.type==='", start + 12);
    const block = offlineSource.slice(start, nextStart < 0 ? offlineSource.length : nextStart);
    const scopeGuard = block.indexOf('if (!hasCloudRecordScope(parsed.cloudScope) ||');
    const shopResolve = block.indexOf("ensureCloudShop('Nexfix Shop')");
    const serverScopeGuard = block.indexOf('if(!isCloudRecordReplayScopeValid(parsed.cloudScope,verifiedScope,getCloudActivityScope()))');
    const catalog = block.indexOf('syncNormalizedCatalog(');
    const scopeBeforeWrite = block.indexOf('if(!isCloudRecordReplayScopeValid(parsed.cloudScope,verifiedScope,getCloudActivityScope()))', catalog);
    const write = block.indexOf(writeCall);
    assert.ok(scopeGuard >= 0 && shopResolve > scopeGuard, operation + ' must block unscoped legacy rows before shop resolution');
    assert.ok(serverScopeGuard > shopResolve && catalog > serverScopeGuard, operation + ' must verify the resolved Cloud identity before catalog bootstrap');
    assert.ok(write > scopeBeforeWrite && scopeBeforeWrite > catalog, operation + ' must re-check identity after catalog bootstrap and before the atomic write');
  };
  assertInventoryQueueScope('inventory_unit_delete', 'queueInventoryUnitDelete', 'addInventoryUnitsAtomic(');
  assertInventoryQueueScope('inventory_units_add', 'queueInventoryUnitsAdd', 'addInventoryUnitsAtomic(');
  assertInventoryQueueScope('branch_stock_adjustment', 'queueBranchStockAdjustment', 'adjustBranchStockAtomic(');

  const assertScopedLegacyTransaction = (
    operation: string,
    queueFunction: string,
    firstCloudCall: string,
    secondCloudCall?: string,
  ) => {
    const writerStart = offlineSource.indexOf('export async function ' + queueFunction);
    assert.ok(writerStart >= 0, queueFunction + ' queue writer must exist');
    const nextWriter = offlineSource.indexOf('\nexport async function ', writerStart + 1);
    const writer = offlineSource.slice(writerStart, nextWriter < 0 ? offlineSource.length : nextWriter);
    assert.ok(writer.includes('cloudScope:getCloudActivityScope()||undefined'),
      operation + ' queue must persist enqueue-time Cloud shop/user');

    const start = offlineSource.indexOf("if(op.type==='" + operation + "')");
    assert.ok(start >= 0, operation + ' replay block must exist');
    const nextStart = offlineSource.indexOf("if(op.type==='", start + 12);
    const block = offlineSource.slice(start, nextStart < 0 ? offlineSource.length : nextStart);
    const scopeGuard = block.indexOf('if (!hasCloudRecordScope(parsed.cloudScope) ||');
    const shopResolve = block.indexOf("ensureCloudShop('Nexfix Shop')");
    const verified = block.indexOf('if(!isCloudRecordReplayScopeValid(parsed.cloudScope,verifiedScope,getCloudActivityScope()))');
    const call = block.indexOf(firstCloudCall);
    assert.ok(scopeGuard >= 0 && shopResolve > scopeGuard, operation + ' must stop unscoped legacy rows before Cloud resolution');
    assert.ok(verified > shopResolve && call > verified, operation + ' must verify the resolved Cloud identity before the RPC');
    if (secondCloudCall) {
      const second = block.indexOf(secondCloudCall);
      const recheck = block.indexOf('if(!isCloudRecordReplayScopeValid(parsed.cloudScope,verifiedScope,getCloudActivityScope()))', call + firstCloudCall.length);
      assert.ok(second > call && recheck > call && second > recheck,
        operation + ' must re-check Cloud identity before the final transaction RPC');
    }
  };
  assertScopedLegacyTransaction('repair_delivery', 'queueRepairDelivery', 'processRepairDeliveryAtomic(');
  const repairQueueWriterStart = offlineSource.indexOf('export async function queueRepairDelivery');
  const repairQueueWriterEnd = offlineSource.indexOf('export async function queuePurchaseReceive', repairQueueWriterStart);
  const repairQueueWriter = offlineSource.slice(repairQueueWriterStart, repairQueueWriterEnd);
  assert.ok(repairQueueWriter.includes('branchId') && repairQueueWriter.includes('cloudScope:getCloudActivityScope()||undefined'),
    'repair delivery queue must persist immutable branch and Cloud scope at enqueue time');
  const repairReplayStart = offlineSource.indexOf("if(op.type==='repair_delivery')");
  const saleReversalStart = offlineSource.indexOf("if(op.type==='sale_reversal_request')", repairReplayStart);
  const repairReplay = offlineSource.slice(repairReplayStart, saleReversalStart);
  assert.ok(repairReplay.includes('const queuedBranchId = parsed.branchId || \'local-main\';'));
  assert.ok(repairReplay.includes('branchId:queuedBranchId,requireExactBranch:true') ||
    (repairReplay.includes('branchId:queuedBranchId') && repairReplay.includes('requireExactBranch:true')),
    'repair replay must pass the captured branch and require an exact match');

  const cloudSyncSourceForRepair = readFileSync(new URL('../src/lib/cloudSync.ts', import.meta.url), 'utf8');
  assert.ok(cloudSyncSourceForRepair.includes('resolveCloudBranchId(input.shopId, input.branchId, input.requireExactBranch === true, input.deviceId)'),
    'repair RPC client must check the original branch using the queued device id');
  assert.ok(cloudSyncSourceForRepair.includes('branchId: branch.branchId'),
    'repair RPC payload must carry the expected branch into the atomic SQL function');
  const storeSourceForRepair = readFileSync(new URL('../src/lib/store.tsx', import.meta.url), 'utf8');
  assert.ok(storeSourceForRepair.includes('getCachedPOSDeviceBranchId(shop.shopId)'));
  assert.ok(storeSourceForRepair.includes('await queueRepairDelivery(id, next, machine.id, repairBranchId)'));
  assert.ok(storeSourceForRepair.includes('branchId: resolvedBranch.branchId!, requireExactBranch: true'));

  const repairMigration = readFileSync(new URL('../supabase/migrations/20261128123000_enforce_repair_delivery_original_branch.sql', import.meta.url), 'utf8');
  assert.ok(repairMigration.includes("v_expected_branch_id := nullif(btrim(coalesce(p_repair->>'branchId','')), '');"));
  assert.ok(repairMigration.includes('v_expected_branch_id <> v_branch_id::text'));
  assert.ok(repairMigration.includes('Queued transaction branch no longer matches this POS device assignment'));
  assert.ok(repairMigration.includes('for share of pb, b;'), 'repair delivery must lock the current device binding and active branch during stock deduction');
  assert.ok(repairMigration.includes('for share of b;'), 'single-branch repair delivery must lock the selected active branch during stock deduction');
  assert.ok(offlineSource.includes("message.includes('not assigned to an active branch')") && offlineSource.includes("message.includes('No active branch is configured')") && offlineSource.includes("message.includes('No active branch exists for this shop')"),
    'missing or inactive assigned branches must surface as blocked queue-scope errors');
  assert.ok(repairMigration.indexOf('v_expected_branch_id <> v_branch_id::text') < repairMigration.indexOf("if coalesce(p_repair->>'status','') <> 'delivered'"),
    'SQL must verify expected branch before changing repair status or deducting parts');
  assertScopedLegacyTransaction('sale_reversal_request', 'queueSaleReversalRequest', 'requestSaleReversal(');
  assertScopedLegacyTransaction('sale_reversal_approve', 'queueSaleReversalApproval', 'approveSaleReversal(');
  assertScopedLegacyTransaction('sale_reversal_reject', 'queueSaleReversalRejection', 'rejectSaleReversal(');
  assertScopedLegacyTransaction('return_create', 'queueReturnCreate', 'resolveSaleReturnLines(', 'processSaleReturnAtomic(');

  const syncManagerSource = readFileSync(new URL('../src/lib/syncManager.ts', import.meta.url), 'utf8');
  assert.ok(syncManagerSource.includes('if (result.blockedQueueScope)'));
  assert.ok(syncManagerSource.includes('restore the original shop/branch or ask Admin to reconcile before Cloud sync can continue'));
  assert.ok(syncManagerSource.includes('if (result.pendingTransactions)'));
  assert.ok(syncManagerSource.includes('full-state Cloud snapshot sync is paused until the queued transactions are confirmed'));
});

test('queued Sale and GRN replay requires the original verified Cloud shop/user before any Cloud write', () => {
  const queued = { shopId: 'shop-original', userId: 'cloud-user-original' };
  const verified = { ...queued };
  const active = { ...queued };
  assert.equal(isCloudRecordReplayScopeValid(queued, verified, active), true);
  assert.equal(isCloudRecordReplayScopeValid(queued, { shopId: 'shop-other', userId: queued.userId }, active), false);
  assert.equal(isCloudRecordReplayScopeValid(queued, { shopId: queued.shopId, userId: 'cloud-user-other' }, active), false);
  assert.equal(isCloudRecordReplayScopeValid(queued, verified, { shopId: 'shop-other', userId: queued.userId }), false);
  assert.equal(isCloudRecordReplayScopeValid(queued, verified, { shopId: queued.shopId, userId: 'cloud-user-other' }), false);
  assert.equal(isCloudRecordReplayScopeValid(queued, null, active), false);
  assert.equal(isCloudRecordReplayScopeValid(undefined, verified, active), false);

  const offlineSource = readFileSync(new URL('../src/lib/offline.ts', import.meta.url), 'utf8');
  const queueWriteStart = offlineSource.indexOf('export async function queueWrite');
  const queueWriteEnd = offlineSource.indexOf('export async function queueBranchStockAdjustment', queueWriteStart);
  const queueWriteSource = offlineSource.slice(queueWriteStart, queueWriteEnd);
  assert.ok(queueWriteSource.includes("branchId:sale.branchId || 'local-main'"));
  assert.ok(!queueWriteSource.includes('state.settings.branchId'), 'historical Sales without branch provenance must not inherit the currently selected branch');
  const saleStart = offlineSource.indexOf("if(op.type==='sale_create')");
  const purchaseStart = offlineSource.indexOf("if(op.type==='purchase_receive')");
  const repairStart = offlineSource.indexOf("if(op.type==='repair_delivery')");
  assert.ok(saleStart >= 0 && purchaseStart > saleStart && repairStart > purchaseStart);
  const saleReplay = offlineSource.slice(saleStart, purchaseStart);
  const purchaseReplay = offlineSource.slice(purchaseStart, repairStart);
  const assertBefore = (source: string, guard: string, write: string) => {
    const guardIndex = source.indexOf(guard);
    const writeIndex = source.indexOf(write);
    assert.ok(guardIndex >= 0, `missing pre-write identity guard: ${guard}`);
    assert.ok(writeIndex >= 0, `missing Cloud write: ${write}`);
    assert.ok(guardIndex < writeIndex, `identity guard must run before Cloud write: ${write}`);
  };
  assertBefore(saleReplay, 'isCloudRecordReplayScopeValid(parsed.cloudScope, verifiedScope, activeScopeBeforeCatalog)', 'syncNormalizedCatalog(state, shop.shopId, queuedBranchId)');
  assertBefore(saleReplay, 'isCloudRecordReplayScopeValid(parsed.cloudScope, verifiedScope, activeScopeBeforeSale)', 'completeSaleAtomic({');
  assertBefore(saleReplay, 'isCloudRecordReplayScopeValid(parsed.cloudScope, verifiedScope, activeScopeBeforeTradeIn)', 'registerTradeInAtomic({');
  assertBefore(purchaseReplay, 'isCloudRecordReplayScopeValid(parsed.cloudScope, verifiedScope, activeScopeBeforeCatalog)', 'syncNormalizedCatalog(catalogState, shop.shopId, queuedBranchId)');
  assertBefore(purchaseReplay, 'isCloudRecordReplayScopeValid(parsed.cloudScope, verifiedScope, activeScopeBeforeReceive)', 'receivePurchaseAtomic({');
  assert.ok(saleReplay.includes("const queuedBranchId = parsed.input.branchId || 'local-main';"));
  assert.ok(saleReplay.includes('branchId: queuedBranchId,') && saleReplay.includes('requireExactBranch: true,'));
  assert.ok(purchaseReplay.includes("const queuedBranchId = parsed.input.purchase.branchId || 'local-main';"));
  assert.ok(purchaseReplay.includes('branchId: queuedBranchId,') && purchaseReplay.includes('requireExactBranch: true,'));

  const cloudSyncSource = readFileSync(new URL('../src/lib/cloudSync.ts', import.meta.url), 'utf8');
  assert.ok(cloudSyncSource.includes('requireExactBranchMatch && !isQueuedOperationBranchValid(preferredBranchId, branches[0].id, branches.length)'));
  assert.ok(cloudSyncSource.includes('requireExactBranchMatch && !isQueuedOperationBranchValid(preferredBranchId, boundBranch.id, branches.length)'));
  assert.ok(cloudSyncSource.includes('input.requireExactBranch === true'));
  assert.ok(cloudSyncSource.includes('expectedBranchId !== undefined'));
  const catalogStart = cloudSyncSource.indexOf('export async function syncNormalizedCatalog(');
  const selectedBranchCheck = cloudSyncSource.indexOf('resolveCloudBranchId(shopId, expectedBranchId ?? state.settings.branchId, expectedBranchId !== undefined)', catalogStart);
  const catalogWritesStart = cloudSyncSource.indexOf('const result = await cache.run(', selectedBranchCheck);
  assert.ok(catalogStart >= 0 && selectedBranchCheck > catalogStart && catalogWritesStart > selectedBranchCheck,
    'queued branch validation must finish before normalized catalog writes begin');

  for (const operation of ['inventory_unit_delete', 'inventory_units_add', 'branch_stock_adjustment']) {
    const start = offlineSource.indexOf("if(op.type==='" + operation + "')");
    const next = offlineSource.indexOf("if(op.type==='", start + 12);
    const block = offlineSource.slice(start, next < 0 ? offlineSource.length : next);
    assert.ok(start >= 0 && block.includes('requireExactBranch:true'), operation + ' replay must require its enqueue-time branch');
    assert.ok(block.includes('syncNormalizedCatalog(') && block.includes(',parsed.branchId)'), operation + ' catalog bootstrap must be branch-bound');
  }
});


test('cloud sync conflicts take precedence over pending labels and disable retry actions', () => {
  const layoutSource = readFileSync(new URL('../src/components/AppLayout.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

  assert.ok(layoutSource.includes("const showRetryCloudSync = syncManagerState.status !== 'conflict'\n    && (syncManagerState.pending > 0 || syncManagerState.status === 'error');"));
  assert.ok(layoutSource.includes("syncManagerState.status === 'conflict' ? 'Conflict' : syncManagerState.pending > 0 ? 'Pending'"));
  const conflictTitle = "syncManagerState.status === 'conflict'\n      ? `Cloud sync conflict";
  const issueTitle = ": cloudLastIssue\n        ? `Cloud operation needs attention";
  assert.ok(layoutSource.indexOf(conflictTitle) >= 0, 'conflict title must be present');
  assert.ok(layoutSource.indexOf(conflictTitle) < layoutSource.indexOf(issueTitle), 'conflict must take precedence over the generic issue title');
});


test('safe verification workflows trigger for integration and focused fix pull requests', () => {
  const workflowPaths = [
    '../.github/workflows/ci.yml',
    '../.github/workflows/security-audit.yml',
    '../.github/workflows/desktop-build-only.yml',
    '../.github/workflows/windows-no-publish-qa.yml',
    '../.github/workflows/database-tests.yml',
  ];

  for (const workflowPath of workflowPaths) {
    const source = readFileSync(new URL(workflowPath, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    const expectedPullRequestFilter = [
      '  pull_request:',
      "    branches: [main, 'integration/**', 'fix/**']",
    ].join('\\n');
    assert.ok(source.includes(expectedPullRequestFilter), `${workflowPath} must run for main, integration and fix PRs`);
  }
});
