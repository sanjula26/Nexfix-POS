import assert from 'node:assert/strict';
import test from 'node:test';
import type { POSState } from '../src/lib/types.ts';
import { clearUpdaterCredentialsForRecovery, isUpdaterAuthorizationError } from '../src/lib/updaterErrors.ts';
import { hasValidCustomerCreditPayment } from '../src/lib/creditPaymentBackupValidation.ts';
import { buildCreditSettlementSyncFingerprint } from '../src/lib/creditSettlementSyncFingerprint.ts';
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
import {
  applyBranchStockDeltas,
  cacheBranchStock,
  cacheBranchStockProduct,
  getCachedBranchStock,
  isBranchStockCacheReady,
  isLocalMainStockReady,
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
