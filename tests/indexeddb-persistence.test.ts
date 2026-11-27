import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { POSState } from '../src/lib/types.ts';
import { subscribeToStorageQuotaWarnings } from '../src/lib/storageOverflowEvents.ts';
import {
  idbAcknowledgeQueue,
  idbAddPendingSaleQueueId,
  idbGetPendingSaleQueueIds,
  idbRemovePendingSaleQueueIds,
  idbClearQueue,
  idbClearRestoreCheckpoint,
  idbEnqueue,
  idbListQueue,
  idbLoadRestoreCheckpoint,
  idbLoadState,
  idbReadLegacyProfileSnapshot,
  idbSaveRestoreCheckpoint,
  idbSaveState,
  idbSaveStateDetailed,
  idbGetMetaDetailed,
  idbSetMetaDetailed,
  idbInspectExistingState,
  idbAvailable,
  idbGetMetaValue,
  idbPutMetaValue,
  idbDeleteMetaValue,
  setDesktopProfilePrimary,
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

test('folder-primary backend routes POS domains to encrypted profile and never falls back to IndexedDB', async () => {
  const payloads = new Map<string, string>();
  const revisions = new Map<string, number>();
  const fakeApi = {
    isDesktop: true,
    readPOSProfileData: async (purpose: string) => ({
      ok: true,
      found: payloads.has(purpose),
      payload: payloads.get(purpose),
    }),
    writePOSProfileData: async (purpose: string, payload: string) => {
      const revision = (revisions.get(purpose) || 0) + 1;
      revisions.set(purpose, revision);
      payloads.set(purpose, payload);
      return { ok: true, revision, bytes: new TextEncoder().encode(payload).byteLength };
    },
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { nexfixDesktop: fakeApi },
  });
  setDesktopProfilePrimary(true);
  try {
    const state = { products: [], users: [], sales: [] } as unknown as POSState;
    payloads.set('meta', JSON.stringify({ autoBackupHours: 6, backupCount: 0 }));
    payloads.set('sync_queue', '[]');
    payloads.set('restore_checkpoint', 'null');

    assert.equal(idbAvailable(), true);
    assert.deepEqual(await idbSaveStateDetailed(state), { ok: true });
    assert.deepEqual(await idbLoadState(), state);
    assert.equal(await idbEnqueue({ type: 'state_write', id: 'folder-queue-1', ts: '2026-11-23T01:00:00.000Z' }), true);
    assert.equal((await idbListQueue()).some(item => item.id === 'folder-queue-1'), true);
    assert.equal(await idbSaveRestoreCheckpoint(state), true);
    assert.deepEqual(await idbLoadRestoreCheckpoint(), state);
    assert.equal(await idbClearRestoreCheckpoint(), true);
    assert.equal(await idbLoadRestoreCheckpoint(), null);
    assert.equal((await idbGetMetaDetailed()).ok, true);
    const metaWrite = await idbSetMetaDetailed({ autoBackupHours: 3 });
    assert.equal(metaWrite.ok, true);
    assert.equal((await idbGetMetaDetailed()).value?.autoBackupHours, 3);

    const folderDraftKey = 'grn_working_draft_v1:profile-test';
    const folderDraft = { id: 'folder-draft-1', supplierId: 'supplier-1', rows: [{ productId: 'product-1', qty: 2 }] };
    assert.equal(await idbPutMetaValue(folderDraftKey, folderDraft), true);
    assert.deepEqual(await idbGetMetaValue<typeof folderDraft>(folderDraftKey), folderDraft);
    assert.deepEqual(JSON.parse(payloads.get('meta') || '{}').grnWorkingDrafts?.[folderDraftKey], folderDraft);
    assert.equal((await idbGetMetaDetailed()).value?.autoBackupHours, 3);
    assert.equal(await idbDeleteMetaValue(folderDraftKey), true);
    assert.equal(await idbGetMetaValue(folderDraftKey), null);

    assert.equal((await idbInspectExistingState()).status, 'present');
    assert.equal((await idbReadLegacyProfileSnapshot()).status, 'unavailable');

    payloads.delete('app_state');
    await assert.rejects(idbLoadState(), /missing required app_state data/);
  } finally {
    setDesktopProfilePrimary(false);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
});

test('GRN recovery metadata round-trips in the IndexedDB metadata domain', async () => {
  const key = 'grn_working_draft_v1:indexeddb-test';
  const baseline = await idbGetMetaDetailed();
  assert.equal(baseline.ok, true);
  const draft = {
    id: 'indexeddb-draft-1',
    editingId: null,
    supplierId: 'supplier-1',
    invoiceNo: 'INV-PARTIAL',
    notes: 'Saved before quota migration',
    rows: [{ productId: 'product-1', qty: 3, cost: 120, unitText: 'IMEI-PARTIAL' }],
    savedAt: '2026-11-26T11:00:00.000Z',
  };

  assert.equal(await idbPutMetaValue(key, draft), true);
  assert.deepEqual(await idbGetMetaValue<typeof draft>(key), draft);
  const afterSave = await idbGetMetaDetailed();
  assert.equal(afterSave.ok, true);
  if (afterSave.ok && baseline.ok) {
    assert.equal(afterSave.value.autoBackupHours, baseline.value.autoBackupHours);
    assert.equal(afterSave.value.backupCount, baseline.value.backupCount);
  }
  assert.equal(await idbDeleteMetaValue(key), true);
  assert.equal(await idbGetMetaValue(key), null);
});

test('GRN recovery metadata read failures are not mistaken for missing drafts', async () => {
  const originalTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
    if (args[0] === 'meta') throw new DOMException('Injected metadata read failure', 'InvalidStateError');
    return originalTransaction.apply(this, args);
  } as IDBDatabase['transaction'];

  try {
    await assert.rejects(idbGetMetaValue('grn_working_draft_v1:read-failure'), /could not commit the requested data/i);
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


test('detailed offline queue writes preserve quota failure type', async () => {
  const reopenedDb = await import(`../src/lib/db.ts?queue-quota-failure=${Date.now()}`);
  const originalTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
    if (args[0] === 'sync_queue' && args[1] === 'readwrite') {
      throw new DOMException('Injected queue quota failure', 'QuotaExceededError');
    }
    return originalTransaction.apply(this, args);
  } as IDBDatabase['transaction'];

  try {
    const result = await reopenedDb.idbEnqueueDetailed({
      type: 'state_write',
      id: 'quota-test-queue-entry',
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, 'quota_exceeded');
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
  }
});

test('detailed backup metadata writes preserve quota failure type', async () => {
  const reopenedDb = await import(`../src/lib/db.ts?meta-quota-failure=${Date.now()}`);
  const originalTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
    if (args[0] === 'meta' && args[1] === 'readwrite') {
      throw new DOMException('Injected metadata quota failure', 'QuotaExceededError');
    }
    return originalTransaction.apply(this, args);
  } as IDBDatabase['transaction'];

  try {
    const result = await reopenedDb.idbSetMetaDetailed({ backupCount: 3 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, 'quota_exceeded');
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
  }
});


test('backup metadata write does not overwrite existing metadata when the read fails', async () => {
  const reopenedDb = await import(`../src/lib/db.ts?meta-read-failure=${Date.now()}`);
  await reopenedDb.idbSetMeta({ backupCount: 7, autoBackupHours: 12 });
  const originalGet = IDBObjectStore.prototype.get;
  const originalPut = IDBObjectStore.prototype.put;
  let writeAttempts = 0;
  IDBObjectStore.prototype.get = function (...args: Parameters<IDBObjectStore['get']>) {
    if (this.name === 'meta') throw new DOMException('Injected metadata read failure', 'InvalidStateError');
    return originalGet.apply(this, args);
  };
  IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
    if (this.name === 'meta') writeAttempts += 1;
    return originalPut.apply(this, args);
  };

  try {
    const result = await reopenedDb.idbSetMetaDetailed({ backupCount: 99 });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.kind, 'write_failed');
      assert.equal(result.value, undefined);
    }
    assert.equal(writeAttempts, 0, 'must not attempt a write after metadata read failure');
  } finally {
    IDBObjectStore.prototype.get = originalGet;
    IDBObjectStore.prototype.put = originalPut;
  }

  const preserved = await reopenedDb.idbGetMeta();
  assert.equal(preserved.backupCount, 7);
  assert.equal(preserved.autoBackupHours, 12);
});


test('concurrent backup metadata patches are merged atomically without losing fields', async () => {
  const reopenedDb = await import(`../src/lib/db.ts?meta-concurrent=${Date.now()}`);
  await reopenedDb.idbSetMeta({ backupCount: 4, autoBackupHours: 6 });

  const results = await Promise.all([
    reopenedDb.idbSetMetaDetailed({ lastManualBackupAt: '2026-11-22T10:00:00.000Z' }),
    reopenedDb.idbSetMetaDetailed({ lastCloudBackupAt: '2026-11-22T10:01:00.000Z' }),
  ]);
  assert.equal(results.every((result) => result.ok), true);

  await Promise.all([
    reopenedDb.idbSetMetaDetailed((current) => ({ backupCount: current.backupCount + 1 })),
    reopenedDb.idbSetMetaDetailed((current) => ({ backupCount: current.backupCount + 1 })),
  ]);

  const finalMeta = await reopenedDb.idbGetMetaDetailed();
  assert.equal(finalMeta.ok, true);
  if (finalMeta.ok) {
    assert.equal(finalMeta.value.backupCount, 6, 'concurrent increments must not overwrite each other');
    assert.equal(finalMeta.value.lastManualBackupAt, '2026-11-22T10:00:00.000Z');
    assert.equal(finalMeta.value.lastCloudBackupAt, '2026-11-22T10:01:00.000Z');
  }
});

test('detailed backup metadata reads report storage failures instead of returning defaults', async () => {
  const reopenedDb = await import(`../src/lib/db.ts?meta-detailed-read-failure=${Date.now()}`);
  const originalTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
    if (args[0] === 'meta' && args[1] === 'readonly') {
      throw new DOMException('Injected metadata read failure', 'InvalidStateError');
    }
    return originalTransaction.apply(this, args);
  } as IDBDatabase['transaction'];

  try {
    const result = await reopenedDb.idbGetMetaDetailed();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, 'write_failed');
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
  }
});


test('legacy POS profile snapshot captures state, restore checkpoint, queue and metadata', async () => {
  await idbClearQueue();
  await idbClearRestoreCheckpoint();

  const state = {
    products: [{ id: 'snapshot-product' }],
    users: [{ id: 'snapshot-user' }],
    sales: [{ id: 'snapshot-sale' }],
  } as unknown as POSState;
  const checkpoint = {
    products: [{ id: 'checkpoint-product' }],
    users: [{ id: 'checkpoint-user' }],
    sales: [],
  } as unknown as POSState;

  assert.equal(await idbSaveState(state), true);
  assert.equal(await idbSaveRestoreCheckpoint(checkpoint), true);
  assert.equal(await idbEnqueue({
    type: 'state_write',
    id: 'snapshot-queue-entry',
    ts: '2026-11-23T01:00:00.000Z',
  }), true);

  const metadata = await (await import('../src/lib/db.ts')).idbSetMetaDetailed({
    autoBackupHours: 12,
    backupCount: 5,
  });
  assert.equal(metadata.ok, true);

  const result = await idbReadLegacyProfileSnapshot();
  assert.equal(result.status, 'present');
  if (result.status !== 'present') return;
  assert.deepEqual(result.snapshot.state, state);
  assert.deepEqual(result.snapshot.restoreCheckpoint, checkpoint);
  assert.deepEqual(result.snapshot.queue.map((item) => item.id), ['snapshot-queue-entry']);
  assert.equal(result.snapshot.meta.autoBackupHours, 12);
  assert.equal(result.snapshot.meta.backupCount, 5);
  assert.equal(result.snapshot.hasAnyBusinessData, true);
});


test('all detailed IndexedDB write domains emit the quota warning used by automatic folder migration', async () => {
  const reopenedDb = await import(`../src/lib/db.ts?quota-warning-handoff=${Date.now()}`);
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const target = new EventTarget();
  const warnings: Array<{ reason: string }> = [];
  const unsubscribe = subscribeToStorageQuotaWarnings(target, detail => warnings.push(detail));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });

  const originalTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
    const stores = Array.isArray(args[0]) ? args[0] : [args[0]];
    const isWrite = args[1] === 'readwrite';
    if (isWrite && stores.some(name => ['app_state', 'sync_queue', 'meta'].includes(String(name)))) {
      throw new DOMException('Injected quota failure', 'QuotaExceededError');
    }
    return originalTransaction.apply(this, args);
  } as IDBDatabase['transaction'];

  try {
    const state = { products: [], users: [], sales: [] } as unknown as POSState;
    const results = await Promise.all([
      reopenedDb.idbSaveStateDetailed(state),
      reopenedDb.idbSaveRestoreCheckpointDetailed(state),
      reopenedDb.idbEnqueueDetailed({ type: 'state_write', id: 'quota-warning-queue-test' }),
      reopenedDb.idbSetMetaDetailed({ backupCount: 1 }),
    ]);
    assert.equal(results.every(result => !result.ok && result.error.kind === 'quota_exceeded'), true);
    assert.equal(warnings.length, 4);
    assert.deepEqual(warnings.map(item => item.reason), [
      'quota_exceeded', 'quota_exceeded', 'quota_exceeded', 'quota_exceeded',
    ]);
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
    unsubscribe();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
});

test('pending offline sale queue markers survive reopen and clear only selected Sale IDs', async () => {
  const saleIds = ['sale-recovery-a', 'sale-recovery-b'];
  await idbRemovePendingSaleQueueIds(await idbGetPendingSaleQueueIds());
  assert.equal(await idbAddPendingSaleQueueId(saleIds[0]), true);
  assert.equal(await idbAddPendingSaleQueueId(saleIds[1]), true);
  assert.equal(await idbAddPendingSaleQueueId(saleIds[0]), true);

  const reopenedDb = await import(`../src/lib/db.ts?pending-sale-reopen=${Date.now()}`);
  assert.deepEqual((await reopenedDb.idbGetPendingSaleQueueIds()).sort(), saleIds);

  assert.equal(await reopenedDb.idbRemovePendingSaleQueueIds([saleIds[0]]), true);
  assert.deepEqual(await idbGetPendingSaleQueueIds(), [saleIds[1]]);
  assert.equal(await idbRemovePendingSaleQueueIds([saleIds[1]]), true);
  assert.deepEqual(await idbGetPendingSaleQueueIds(), []);
});

test('pending offline sale marker write fails closed when metadata transaction cannot commit', async () => {
  const originalTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
    const stores = Array.isArray(args[0]) ? args[0] : [args[0]];
    if (stores.some(name => String(name) === 'meta') && args[1] === 'readwrite') {
      throw new DOMException('Injected pending sale marker failure', 'QuotaExceededError');
    }
    return originalTransaction.apply(this, args);
  } as IDBDatabase['transaction'];
  try {
    assert.equal(await idbAddPendingSaleQueueId('sale-marker-failure'), false);
    assert.equal((await idbGetPendingSaleQueueIds()).includes('sale-marker-failure'), false);
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
  }
});

