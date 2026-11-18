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

test('IndexedDB read-only state probe distinguishes an empty store from a read failure', async () => {
  await clearAuthoritativeStateRow();
  await idbClearQueue();
  await clearStore('meta');
  assert.equal(await idbReadState(), undefined);
  assert.equal(await idbHasPriorUseEvidence(), false);
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

test('IndexedDB read-only state probe rejects a malformed authoritative row', async () => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('nexfix_pos_db', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open test IndexedDB'));
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('app_state', 'readwrite');
    tx.objectStore('app_state').put({ key: 'main' });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Could not write malformed test row'));
    tx.onabort = () => reject(tx.error || new Error('Malformed test row write aborted'));
  });
  db.close();
  assert.equal(await idbReadState(), null);
  await clearAuthoritativeStateRow();
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
