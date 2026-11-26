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
  idbDeleteMetaValue,
  idbGetMetaValue,
  idbPutMetaValue,
  idbLoadRestoreCheckpoint,
  idbLoadState,
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

test('IndexedDB metadata stores, restores and deletes incomplete GRN recovery drafts', async () => {
  const key = 'test_grn_working_draft_recovery';
  const draft = {
    id: 'draft-recovery-1',
    editingId: null,
    supplierId: 'supplier-1',
    invoiceNo: 'INV-PARTIAL',
    notes: 'Stopped before finishing',
    rows: [{ productId: 'product-1', qty: 3, cost: 120, sellingPrice: 150, updateSellingPrice: false, unitText: 'IMEI-PARTIAL' }],
    savedAt: '2026-11-26T08:00:00.000Z',
  };

  assert.equal(await idbPutMetaValue(key, draft), true);
  assert.deepEqual(await idbGetMetaValue<typeof draft>(key), draft);

  const reopenedDb = await import(`../src/lib/db.ts?grn-recovery=${Date.now()}`);
  assert.deepEqual(await reopenedDb.idbGetMetaValue<typeof draft>(key), draft);
  assert.equal(await reopenedDb.idbDeleteMetaValue(key), true);
  assert.equal(await idbGetMetaValue(key), null);
});

test('IndexedDB metadata read failures are not treated as missing GRN recovery drafts', async () => {
  const reopenedDb = await import(`../src/lib/db.ts?meta-read-failure=${Date.now()}`);
  const originalTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
    if (args[0] === 'meta') throw new DOMException('Injected metadata read failure', 'InvalidStateError');
    return originalTransaction.apply(this, args);
  } as IDBDatabase['transaction'];

  try {
    await assert.rejects(
      reopenedDb.idbGetMetaValue('test_grn_read_failure'),
      /Injected metadata read failure/,
    );
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
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
