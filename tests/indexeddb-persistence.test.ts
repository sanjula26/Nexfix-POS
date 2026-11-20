import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { POSState } from '../src/lib/types.ts';
import {
  idbAcknowledgeQueue,
  idbClearQueue,
  idbClearRestoreCheckpoint,
  idbEnqueue,
  idbListQueue,
  idbLoadRestoreCheckpoint,
  idbLoadState,
  idbReadState,
  idbHasPriorUseEvidence,
  idbInitializeStateIfAbsent,
  idbSetMeta,
  idbSaveRestoreCheckpoint,
  idbSaveState,
} from '../src/lib/db.ts';

before(async () => {
  assert.ok(typeof indexedDB !== 'undefined', 'Node test runtime must provide IndexedDB');
  await idbClearQueue();
  await idbClearRestoreCheckpoint();
});

after(async () => {
  await idbClearQueue();
  await idbClearRestoreCheckpoint();
});

async function clearStore(storeName: string): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('nexfix_pos_db', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open test IndexedDB'));
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error(`Could not clear test store: ${storeName}`));
    tx.onabort = () => reject(tx.error || new Error(`Test store clear aborted: ${storeName}`));
  });
  db.close();
}

async function clearAuthoritativeStateRow(): Promise<void> {
  await clearStore('app_state');
}

function validTestState(billCounter = 0): POSState {
  return {
    products: [], customers: [], suppliers: [], sales: [], purchases: [], expenses: [], exchanges: [],
    users: [], audit: [], held: [], sessions: [], units: [], repairs: [],
    settings: {
      shopName: 'Test Shop', tagline: '', address: '', phone: '', email: '', receiptFooter: '',
      taxDefault: 0, lowStockDefault: 5, exchangeDays: 3, openingFloat: 0,
      adminPinHash: '', whatsappReceipts: false,
    },
    permissions: { admin: { 'page:dashboard': true }, cashier: { 'page:pos': true } },
    counters: { bill: billCounter, po: 0, ex: 0, job: 0, quote: 0, claim: 0 },
  };
}

async function writeMainStateRow(value: unknown): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('nexfix_pos_db', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open test IndexedDB'));
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('app_state', 'readwrite');
    tx.objectStore('app_state').put({ key: 'main', value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Could not write test state row'));
    tx.onabort = () => reject(tx.error || new Error('Test state row write aborted'));
  });
  db.close();
}

async function readMainStateRow(): Promise<unknown> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('nexfix_pos_db', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open test IndexedDB'));
  });
  const value = await new Promise<unknown>((resolve, reject) => {
    const tx = db.transaction('app_state', 'readonly');
    const request = tx.objectStore('app_state').get('main');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not read test state row'));
  });
  db.close();
  return value;
}

test('IndexedDB read-only state probe distinguishes an empty store from a read failure', async () => {
  await clearAuthoritativeStateRow();
  await idbClearQueue();
  await clearStore('meta');
  assert.equal(await idbReadState(), undefined);
  assert.equal(await idbHasPriorUseEvidence(), false);
});

test('concurrent first-run initialization never overwrites a state created by another window', async () => {
  await clearAuthoritativeStateRow();
  const firstCandidate = validTestState(111);
  const secondCandidate = validTestState(222);
  const [firstResult, secondResult] = await Promise.all([
    idbInitializeStateIfAbsent(firstCandidate),
    idbInitializeStateIfAbsent(secondCandidate),
  ]);
  const persisted = await idbReadState();
  assert.ok(persisted);
  assert.deepEqual(firstResult, persisted);
  assert.deepEqual(secondResult, persisted);
  assert.ok(persisted.counters.bill === 111 || persisted.counters.bill === 222);
  await clearAuthoritativeStateRow();
});

test('IndexedDB prior-use probe detects queue, restore checkpoint and backup metadata', async () => {
  await clearAuthoritativeStateRow();
  await idbClearQueue();
  await clearStore('meta');
  assert.equal(await idbHasPriorUseEvidence(), false);

  assert.equal(await idbEnqueue({
    type: 'state_write',
    id: 'test-prior-use-queue',
    ts: '2026-11-18T10:00:00.000Z',
  }), true);
  assert.equal(await idbHasPriorUseEvidence(), true);
  await idbClearQueue();

  const checkpoint = { counters: { bill: 20 } } as unknown as POSState;
  assert.equal(await idbSaveRestoreCheckpoint(checkpoint), true);
  assert.equal(await idbHasPriorUseEvidence(), true);
  assert.equal(await idbClearRestoreCheckpoint(), true);

  await idbSetMeta({ backupCount: 1 });
  assert.equal(await idbHasPriorUseEvidence(), true);
  await clearStore('meta');
  assert.equal(await idbHasPriorUseEvidence(), false);
});

test('IndexedDB read accepts legacy state fields that migrate() supplies after hydration', async () => {
  const legacy = validTestState(80) as unknown as Record<string, unknown>;
  legacy.customers = [{
    id: 'customer-legacy',
    name: 'Legacy customer',
    phone: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    creditBalance: 0,
  }];
  delete legacy.suppliers;
  delete legacy.units;
  delete legacy.repairs;
  delete (legacy.settings as Record<string, unknown>).adminPinHash;
  delete (legacy.settings as Record<string, unknown>).openingFloat;
  delete (legacy.settings as Record<string, unknown>).whatsappReceipts;
  legacy.permissions = {};
  legacy.counters = {};

  await writeMainStateRow(legacy);
  assert.deepEqual(await idbReadState(), legacy);
  await clearAuthoritativeStateRow();
});

test('IndexedDB read-only state probe rejects a malformed authoritative row', async () => {
  await writeMainStateRow(undefined);
  assert.equal(await idbReadState(), null);
  await clearAuthoritativeStateRow();
});

test('IndexedDB read and concurrent initialization reject malformed state without rewriting it', async () => {
  const valid = validTestState(77);
  const malformedStates: unknown[] = [
    {},
    { ...valid, products: [{ id: 'product-without-required-fields' }] },
    { ...valid, settings: {} },
    { ...valid, settings: { ...valid.settings, taxDefault: 'not-a-number' } },
    { ...valid, permissions: { admin: { 'page:dashboard': true }, cashier: { 'page:pos': 'yes' } } },
    { ...valid, counters: { ...valid.counters, bill: -1 } },
    {
      ...valid,
      sales: [{
        id: 'sale-with-malformed-line', billNo: 'NFX-TEST', date: '2026-11-19T00:00:00.000Z',
        cashierId: 'cashier-1', cashierName: 'Cashier', customerName: 'Walk-in',
        items: [{ productId: 'product-1' }], subtotal: 0, discount: 0, tax: 0, total: 0,
        payment: 'cash', amountPaid: 0, change: 0, profit: 0, status: 'completed',
      }],
    },
  ];

  for (const malformed of malformedStates) {
    await writeMainStateRow(malformed);
    const before = await readMainStateRow();
    assert.equal(await idbReadState(), null, 'malformed persisted state must fail closed');
    assert.equal(await idbInitializeStateIfAbsent(validTestState(999)), null,
      'concurrent initializer must reject an already-present malformed row');
    assert.deepEqual(await readMainStateRow(), before, 'invalid row must not be overwritten or normalized');
    await clearAuthoritativeStateRow();
  }
});

test('IndexedDB queue commits operations and returns them in timestamp order', async () => {
  assert.equal(await idbEnqueue({
    type: 'state_write',
    id: 'test-state-later',
    ts: '2026-11-12T10:00:02.000Z',
  }), true);
  assert.equal(await idbEnqueue({
    type: 'sale_create',
    id: 'test-sale-earlier',
    ts: '2026-11-12T10:00:01.000Z',
    payload: JSON.stringify({ saleId: 'sale-test-1' }),
  }), true);

  const queued = await idbListQueue();
  assert.deepEqual(
    queued.filter((item) => item.id.startsWith('test-')).map((item) => item.id),
    ['test-sale-earlier', 'test-state-later'],
  );
});

test('IndexedDB acknowledgement removes only acknowledged operations', async () => {
  assert.equal(await idbEnqueue({
    type: 'state_write',
    id: 'test-ack-one',
    ts: '2026-11-12T10:01:00.000Z',
  }), true);
  assert.equal(await idbEnqueue({
    type: 'state_write',
    id: 'test-keep-two',
    ts: '2026-11-12T10:01:01.000Z',
  }), true);

  await idbAcknowledgeQueue(['test-ack-one']);

  const remainingIds = (await idbListQueue()).map((item) => item.id);
  assert.equal(remainingIds.includes('test-ack-one'), false);
  assert.equal(remainingIds.includes('test-keep-two'), true);
});

test('restore checkpoint can recover the previous IndexedDB state after a failed replacement', async () => {
  const original = validTestState(10);
  assert.equal(await idbSaveState(original), true);
  assert.equal(await idbSaveRestoreCheckpoint(original), true);

  const changed = validTestState(11);
  assert.equal(await idbSaveState(changed), true);
  assert.equal((await idbLoadState())?.counters.bill, changed.counters.bill);

  const checkpoint = await idbLoadRestoreCheckpoint();
  assert.ok(checkpoint);
  assert.equal(checkpoint.counters.bill, original.counters.bill);
  assert.equal(await idbSaveState(checkpoint), true);
  assert.equal((await idbLoadState())?.counters.bill, original.counters.bill);
  assert.equal(await idbClearRestoreCheckpoint(), true);
  assert.equal(await idbLoadRestoreCheckpoint(), null);
});

test('committed queue entries survive a fresh IndexedDB module connection', async () => {
  const operationId = 'test-reopen-queue-operation';
  assert.equal(await idbEnqueue({
    type: 'state_write',
    id: operationId,
    ts: '2026-11-12T10:02:00.000Z',
  }), true);

  const reopenedDb = await import(`../src/lib/db.ts?reopen=${Date.now()}`);
  const reopenedQueue = await reopenedDb.idbListQueue();
  assert.ok(reopenedQueue.some((item) => item.id === operationId));

  await reopenedDb.idbAcknowledgeQueue([operationId]);
  assert.equal((await idbListQueue()).some((item) => item.id === operationId), false);
});

test('IndexedDB queue read failures are surfaced instead of treated as an empty queue', async () => {
  const reopenedDb = await import(`../src/lib/db.ts?queue-read-failure=${Date.now()}`);
  const originalTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
    if (args[0] === 'sync_queue') throw new DOMException('Injected queue read failure', 'InvalidStateError');
    return originalTransaction.apply(this, args);
  } as IDBDatabase['transaction'];

  try {
    await assert.rejects(reopenedDb.idbListQueue(), /Injected queue read failure/);
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
  }
});


test('IndexedDB state read failures return null instead of being treated as an empty shop', async () => {
  const reopenedDb = await import(`../src/lib/db.ts?state-read-failure=${Date.now()}`);
  const originalTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
    if (args[0] === 'app_state' && args[1] === 'readonly') {
      throw new DOMException('Injected state read failure', 'InvalidStateError');
    }
    return originalTransaction.apply(this, args);
  } as IDBDatabase['transaction'];

  try {
    assert.equal(await reopenedDb.idbLoadState(), null);
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
  }
});


test('restore checkpoint read rejects a transaction that aborts after its request succeeds', async () => {
  await idbSaveRestoreCheckpoint(validTestState(43));
  const originalTransaction = IDBDatabase.prototype.transaction;
  const originalGet = IDBObjectStore.prototype.get;
  let activeCheckpointRead: IDBTransaction | null = null;

  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
    const tx = originalTransaction.apply(this, args);
    if (args[0] === 'app_state' && args[1] === 'readonly') activeCheckpointRead = tx;
    return tx;
  } as IDBDatabase['transaction'];
  IDBObjectStore.prototype.get = function (...args: Parameters<IDBObjectStore['get']>) {
    const request = originalGet.apply(this, args);
    if (this.name === 'app_state' && args[0] === 'restore_checkpoint') {
      request.addEventListener('success', () => activeCheckpointRead?.abort(), { once: true });
    }
    return request;
  } as IDBObjectStore['get'];

  try {
    assert.equal(await idbLoadRestoreCheckpoint(), null,
      'an aborted checkpoint read must not be treated as a valid rollback point');
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
    IDBObjectStore.prototype.get = originalGet;
  }
});


test('offline queue read rejects a transaction that aborts after its request succeeds', async () => {
  await idbEnqueue({ type: 'state_write_offline', note: 'transaction-abort-test' });
  const originalTransaction = IDBDatabase.prototype.transaction;
  const originalGetAll = IDBObjectStore.prototype.getAll;
  let activeQueueRead: IDBTransaction | null = null;

  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
    const tx = originalTransaction.apply(this, args);
    if (args[0] === 'sync_queue' && args[1] === 'readonly') activeQueueRead = tx;
    return tx;
  } as IDBDatabase['transaction'];
  IDBObjectStore.prototype.getAll = function (...args: Parameters<IDBObjectStore['getAll']>) {
    const request = originalGetAll.apply(this, args);
    if (this.name === 'sync_queue') {
      request.addEventListener('success', () => activeQueueRead?.abort(), { once: true });
    }
    return request;
  } as IDBObjectStore['getAll'];

  try {
    await assert.rejects(idbListQueue(), /Offline queue read failed|aborted/i);
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
    IDBObjectStore.prototype.getAll = originalGetAll;
  }
});


test('IndexedDB state read rejects a transaction that aborts after its request succeeds', async () => {
  await writeMainStateRow(validTestState(42));
  const originalTransaction = IDBDatabase.prototype.transaction;
  const originalGet = IDBObjectStore.prototype.get;
  let activeStateRead: IDBTransaction | null = null;

  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
    const tx = originalTransaction.apply(this, args);
    if (args[0] === 'app_state' && args[1] === 'readonly') activeStateRead = tx;
    return tx;
  } as IDBDatabase['transaction'];
  IDBObjectStore.prototype.get = function (...args: Parameters<IDBObjectStore['get']>) {
    const request = originalGet.apply(this, args);
    if (this.name === 'app_state' && args[0] === 'main') {
      request.addEventListener('success', () => activeStateRead?.abort(), { once: true });
    }
    return request;
  } as IDBObjectStore['get'];

  try {
    assert.equal(await idbReadState(), null,
      'a successful request followed by transaction abort must fail closed');
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
    IDBObjectStore.prototype.get = originalGet;
  }
});


test('IndexedDB state write failures return false instead of reporting a durable save', async () => {
  const reopenedDb = await import(`../src/lib/db.ts?state-write-failure=${Date.now()}`);
  const originalTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
    if (args[0] === 'app_state' && args[1] === 'readwrite') {
      throw new DOMException('Injected state write failure', 'InvalidStateError');
    }
    return originalTransaction.apply(this, args);
  } as IDBDatabase['transaction'];

  try {
    const state = { counters: { bill: 12 } } as unknown as POSState;
    assert.equal(await reopenedDb.idbSaveState(state), false);
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
  }
});
