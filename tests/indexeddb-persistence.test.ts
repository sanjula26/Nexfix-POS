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
  idbSaveRestoreCheckpoint,
  idbSaveState,
  idbSaveStateDetailed,
  estimateIndexedDBQuota,
  classifyIndexedDBWriteFailure,
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
  const original = { counters: { bill: 10 } } as unknown as POSState;
  assert.equal(await idbSaveState(original), true);
  assert.equal(await idbSaveRestoreCheckpoint(original), true);

  const changed = {
    ...original,
    counters: { ...original.counters, bill: original.counters.bill + 1 },
  };
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


test('IndexedDB quota estimator uses runtime estimates and the conservative threshold', async () => {
  const below = await estimateIndexedDBQuota({
    estimate: async () => ({ usage: 840, quota: 1000 }),
  });
  assert.equal(below.status, 'available');
  if (below.status === 'available') {
    assert.equal(below.usageRatio, 0.84);
    assert.equal(below.nearQuota, false);
    assert.equal(below.remainingBytes, 160);
  }

  const above = await estimateIndexedDBQuota({
    estimate: async () => ({ usage: 860, quota: 1000 }),
  });
  assert.equal(above.status, 'available');
  if (above.status === 'available') assert.equal(above.nearQuota, true);
});

test('IndexedDB quota estimator safely handles unsupported and failed estimates', async () => {
  assert.deepEqual(await estimateIndexedDBQuota(null), { status: 'unsupported' });
  assert.deepEqual(await estimateIndexedDBQuota({
    estimate: async () => { throw new Error('estimate unavailable'); },
  }), { status: 'unavailable' });
  assert.deepEqual(await estimateIndexedDBQuota({
    estimate: async () => ({ usage: undefined, quota: 1000 }),
  }), { status: 'unavailable' });
  await assert.rejects(
    estimateIndexedDBQuota({ estimate: async () => ({ usage: 1, quota: 2 }) }, 0),
    /threshold/,
  );
});

test('IndexedDB write failure classifier distinguishes quota exhaustion', () => {
  assert.deepEqual(
    classifyIndexedDBWriteFailure(new DOMException('full', 'QuotaExceededError')),
    { kind: 'quota_exceeded', message: 'IndexedDB storage quota has been exceeded.' },
  );
  assert.equal(classifyIndexedDBWriteFailure(new Error('other')).kind, 'write_failed');
});

test('detailed IndexedDB state writes preserve the quota failure type', async () => {
  const reopenedDb = await import(`../src/lib/db.ts?quota-write-failure=${Date.now()}`);
  const originalTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
    const stores = args[0];
    const isStateStore = stores === 'app_state' || (Array.isArray(stores) && stores.includes('app_state'));
    if (isStateStore && args[1] === 'readwrite') throw new DOMException('Injected quota failure', 'QuotaExceededError');
    return originalTransaction.apply(this, args);
  } as IDBDatabase['transaction'];

  try {
    const result = await reopenedDb.idbSaveStateDetailed({ products: [], users: [], sales: [] } as unknown as POSState);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, 'quota_exceeded');
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
  }
});
