import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { POSState } from '../src/lib/types.ts';
import { getCloudActivityState, setCloudActivityScope, withCloudActivity } from '../src/lib/cloudActivity.ts';
import {
  idbAcknowledgeQueue,
  idbClearQueue,
  idbClearRestoreCheckpoint,
  idbEnqueue,
  idbGetCloudSyncMeta,
  idbSetCloudSyncMeta,
  idbGetCloudRecordSyncStatuses,
  idbMarkCloudRecordSynced,
  idbAcknowledgeCloudRecordQueue,
  idbListQueue,
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

test('cloud sync metadata persists independently per shop and cloud user', async () => {
  const first = {
    lastSuccessAt: '2026-11-27T12:00:00.000Z',
    lastSuccessOperation: 'Cloud sale',
  };
  assert.equal(await idbSetCloudSyncMeta('shop-a', 'cloud-user-a', first), true);
  assert.deepEqual(await idbGetCloudSyncMeta('shop-a', 'cloud-user-a'), first);
  assert.equal(await idbGetCloudSyncMeta('shop-b', 'cloud-user-a'), null);
  assert.equal(await idbGetCloudSyncMeta('shop-a', 'cloud-user-b'), null);
  assert.equal(await idbSetCloudSyncMeta('shop-a', 'cloud-user-a', { ...first, lastSuccessAt: 'invalid' }), false);
  assert.equal((await idbGetCloudSyncMeta('shop-a', 'cloud-user-a'))?.lastSuccessAt, first.lastSuccessAt);
});

test('Cloud record confirmations persist independently per shop and Cloud user', async () => {
  const saleEntry = { confirmedAt: '2026-11-28T04:00:00.000Z', operation: 'Cloud sale' };
  const purchaseEntry = { confirmedAt: '2026-11-28T04:01:00.000Z', operation: 'GRN receive' };

  assert.equal(await idbMarkCloudRecordSynced('record-shop-a', 'record-user-a', 'sale', 'sale-001', 'Cloud sale', saleEntry.confirmedAt), true);
  assert.equal(await idbMarkCloudRecordSynced('record-shop-a', 'record-user-a', 'purchase', 'purchase-001', 'GRN receive', purchaseEntry.confirmedAt), true);
  assert.deepEqual(await idbGetCloudRecordSyncStatuses('record-shop-a', 'record-user-a'), {
    'sale:sale-001': saleEntry,
    'purchase:purchase-001': purchaseEntry,
  });
  assert.deepEqual(await idbGetCloudRecordSyncStatuses('record-shop-b', 'record-user-a'), {});
  assert.deepEqual(await idbGetCloudRecordSyncStatuses('record-shop-a', 'record-user-b'), {});
  assert.equal(await idbMarkCloudRecordSynced('record-shop-a', 'record-user-a', 'sale', '', 'Cloud sale'), false);
  assert.equal(await idbMarkCloudRecordSynced('record-shop-a', 'record-user-a', 'sale', 'sale-001', 'Cloud sale', 'invalid'), false);
});

test('offline sale and GRN queue acknowledgements save Cloud proof and remove only the matching queue entry', async () => {
  assert.equal(await idbEnqueue({
    type: 'sale_create',
    id: 'sale:record-queued-sale',
    payload: JSON.stringify({ saleId: 'record-queued-sale' }),
  }), true);
  assert.equal(await idbEnqueue({
    type: 'purchase_receive',
    id: 'purchase-receive:record-queued-grn',
    payload: JSON.stringify({ purchaseId: 'record-queued-grn' }),
  }), true);
  assert.equal(await idbEnqueue({ type: 'state_write', id: 'record-keep-state' }), true);

  assert.equal(await idbAcknowledgeCloudRecordQueue(
    'record-queue-shop', 'record-queue-user', 'sale', 'record-queued-sale',
    'sale:record-queued-sale', 'Offline sale sync', '2026-11-28T04:02:00.000Z',
  ), true);
  assert.equal(await idbAcknowledgeCloudRecordQueue(
    'record-queue-shop', 'record-queue-user', 'purchase', 'record-queued-grn',
    'purchase-receive:record-queued-grn', 'Offline GRN sync', '2026-11-28T04:03:00.000Z',
  ), true);

  const remaining = (await idbListQueue()).map(item => item.id);
  assert.equal(remaining.includes('sale:record-queued-sale'), false);
  assert.equal(remaining.includes('purchase-receive:record-queued-grn'), false);
  assert.equal(remaining.includes('record-keep-state'), true);
  assert.deepEqual(await idbGetCloudRecordSyncStatuses('record-queue-shop', 'record-queue-user'), {
    'sale:record-queued-sale': { confirmedAt: '2026-11-28T04:02:00.000Z', operation: 'Offline sale sync' },
    'purchase:record-queued-grn': { confirmedAt: '2026-11-28T04:03:00.000Z', operation: 'Offline GRN sync' },
  });
  assert.equal(await idbAcknowledgeCloudRecordQueue(
    'record-queue-shop', 'record-queue-user', 'sale', 'record-queued-sale',
    'sale:another-record', 'Offline sale sync',
  ), false);
});

test('failed Cloud confirmation persistence leaves the offline queue item untouched', async () => {
  const queueId = 'purchase-receive:record-meta-failure';
  assert.equal(await idbEnqueue({
    type: 'purchase_receive',
    id: queueId,
    payload: JSON.stringify({ purchaseId: 'record-meta-failure' }),
  }), true);

  const originalTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
    const stores = Array.isArray(args[0]) ? args[0] : [args[0]];
    if (stores.includes('sync_queue') && stores.includes('meta')) {
      throw new DOMException('Injected confirmation transaction failure', 'InvalidStateError');
    }
    return originalTransaction.apply(this, args);
  } as IDBDatabase['transaction'];

  try {
    assert.equal(await idbAcknowledgeCloudRecordQueue(
      'record-failure-shop', 'record-failure-user', 'purchase', 'record-meta-failure',
      queueId, 'Offline GRN sync',
    ), false);
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
  }

  assert.ok((await idbListQueue()).some(item => item.id === queueId));
  assert.deepEqual(await idbGetCloudRecordSyncStatuses('record-failure-shop', 'record-failure-user'), {});
});

test('cloud activity restores only the active cloud user/shop and persists successful transfers', async () => {
  try {
    await setCloudActivityScope({ shopId: 'shop-scope-a', userId: 'cloud-user-a' });
    assert.equal(getCloudActivityState().lastSuccessAt, null);
    const result = await withCloudActivity('GRN receive', async () => ({ ok: true }), value => value.ok);
    assert.deepEqual(result, { ok: true });
    const persisted = await idbGetCloudSyncMeta('shop-scope-a', 'cloud-user-a');
    assert.ok(persisted);
    assert.equal(persisted?.lastSuccessOperation, 'GRN receive');
    assert.ok(Number.isFinite(Date.parse(persisted!.lastSuccessAt)));

    await setCloudActivityScope({ shopId: 'shop-scope-b', userId: 'cloud-user-a' });
    assert.equal(getCloudActivityState().lastSuccessAt, null);
    await setCloudActivityScope({ shopId: 'shop-scope-a', userId: 'cloud-user-b' });
    assert.equal(getCloudActivityState().lastSuccessAt, null);
    await setCloudActivityScope({ shopId: 'shop-scope-a', userId: 'cloud-user-a' });
    assert.equal(getCloudActivityState().lastSuccessOperation, 'GRN receive');
    assert.ok(getCloudActivityState().lastSuccessAt);
  } finally {
    await setCloudActivityScope(null);
  }
});

test('an active transfer from the previous shop is not shown in the new shop status', async () => {
  await setCloudActivityScope({ shopId: 'shop-active-old', userId: 'cloud-user-a' });
  let finishTransfer!: () => void;
  const pending = withCloudActivity('Old shop sale', () => new Promise(resolve => { finishTransfer = () => resolve('old-sale-confirmed'); }));
  await Promise.resolve();
  assert.equal(getCloudActivityState().active, 1);
  assert.deepEqual(getCloudActivityState().operations, ['Old shop sale']);

  await setCloudActivityScope({ shopId: 'shop-active-new', userId: 'cloud-user-a' });
  assert.equal(getCloudActivityState().active, 0);
  assert.deepEqual(getCloudActivityState().operations, []);
  finishTransfer();
  assert.equal(await pending, 'old-sale-confirmed');
  assert.equal(getCloudActivityState().active, 0);
  await setCloudActivityScope(null);
});

test('a failed cloud request from the previous shop does not contaminate the new shop status', async () => {
  await setCloudActivityScope({ shopId: 'shop-old', userId: 'cloud-user-a' });
  let rejectRequest!: (error: Error) => void;
  const pending = withCloudActivity('Cloud sale', () => new Promise((_resolve, reject) => { rejectRequest = reject; }));
  await Promise.resolve();
  await setCloudActivityScope({ shopId: 'shop-new', userId: 'cloud-user-a' });
  rejectRequest(new Error('old shop network error'));
  await assert.rejects(pending, /old shop network error/);
  assert.equal(getCloudActivityState().lastError, null);
  await setCloudActivityScope(null);
});

test('cloud sync metadata write failure does not block a successful business operation', async () => {
  await setCloudActivityScope({ shopId: 'shop-meta-failure', userId: 'cloud-user-a' });
  const originalTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
    const stores = Array.isArray(args[0]) ? args[0] : [args[0]];
    if (stores.includes('meta')) throw new DOMException('Injected metadata write failure', 'InvalidStateError');
    return originalTransaction.apply(this, args);
  } as IDBDatabase['transaction'];
  try {
    assert.equal(await withCloudActivity('Cloud sale', async () => 'sale-committed'), 'sale-committed');
    await new Promise(resolve => setTimeout(resolve, 0));
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
    await setCloudActivityScope(null);
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
