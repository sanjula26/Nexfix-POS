import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { IDBFactory } from 'fake-indexeddb';
import { idbInspectExistingState, idbReadLegacyProfileSnapshot } from '../src/lib/db.ts';

const DB_NAME = 'nexfix_pos_db';

function createIsolatedFactory(): IDBFactory {
  const Factory = indexedDB.constructor as unknown as new () => IDBFactory;
  return new Factory();
}

async function createDatabase(factory: IDBFactory, storeNames: string[]): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      for (const name of storeNames) request.result.createObjectStore(name, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Test database could not be created.'));
  });
}

async function commitRow(db: IDBDatabase, row: unknown): Promise<void> {
  const tx = db.transaction('app_state', 'readwrite');
  tx.objectStore('app_state').put(row);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Test transaction failed.'));
    tx.onabort = () => reject(tx.error || new Error('Test transaction aborted.'));
  });
}

test('profile inspection reports a missing database without creating or seeding one', async () => {
  const factory = createIsolatedFactory();
  assert.deepEqual(await idbInspectExistingState(factory), { status: 'missing_database' });
  assert.deepEqual(await factory.databases(), []);
});

test('profile inspection reports a missing state store without creating it', async () => {
  const factory = createIsolatedFactory();
  const db = await createDatabase(factory, ['other_store']);
  db.close();

  const result = await idbInspectExistingState(factory);
  assert.equal(result.status, 'invalid_database');
  assert.deepEqual((await factory.databases()).map(item => item.name), [DB_NAME]);
});

test('profile inspection distinguishes an empty existing database from a new database', async () => {
  const factory = createIsolatedFactory();
  const db = await createDatabase(factory, ['app_state']);
  db.close();

  assert.deepEqual(await idbInspectExistingState(factory), { status: 'missing_state' });
  const reopened = await createDatabase(factory, ['app_state']);
  const row = await new Promise((resolve, reject) => {
    const request = reopened.transaction('app_state', 'readonly').objectStore('app_state').get('main');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  reopened.close();
  assert.equal(row, undefined);
});

test('profile inspection reads an existing valid POS state without modifying it', async () => {
  const factory = createIsolatedFactory();
  const db = await createDatabase(factory, ['app_state']);
  const state = { products: [], users: [], sales: [], settings: {} };
  await commitRow(db, { key: 'main', value: state, updatedAt: '2026-11-20T08:00:00.000Z' });
  db.close();

  const result = await idbInspectExistingState(factory);
  assert.equal(result.status, 'present');
  if (result.status === 'present') {
    assert.deepEqual(result.state, state);
    assert.equal(result.updatedAt, '2026-11-20T08:00:00.000Z');
  }
});

test('profile inspection rejects an incomplete saved state instead of treating it as a new shop', async () => {
  const factory = createIsolatedFactory();
  const db = await createDatabase(factory, ['app_state']);
  await commitRow(db, { key: 'main', value: { products: [], users: [] } });
  db.close();

  const result = await idbInspectExistingState(factory);
  assert.equal(result.status, 'invalid_state');
});


test('legacy profile snapshot reads state, restore checkpoint, offline queue and backup metadata without mutation', async () => {
  const factory = createIsolatedFactory();
  const db = await createDatabase(factory, ['app_state', 'sync_queue', 'meta']);
  const state = { products: [{ id: 'p1' }], users: [{ id: 'u1' }], sales: [], settings: {} };
  const checkpoint = { ...state, products: [{ id: 'checkpoint-product' }] };
  const queue = { id: 'queue-1', ts: '2026-11-20T08:00:00.000Z', type: 'sale_create', payload: '{"saleId":"S1"}' };
  const meta = { autoBackupHours: 4, backupCount: 7, lastManualBackupAt: '2026-11-20T07:00:00.000Z' };
  const tx = db.transaction(['app_state', 'sync_queue', 'meta'], 'readwrite');
  tx.objectStore('app_state').put({ key: 'main', value: state, updatedAt: '2026-11-20T08:00:00.000Z' });
  tx.objectStore('app_state').put({ key: 'restore_checkpoint', value: checkpoint });
  tx.objectStore('sync_queue').put(queue);
  tx.objectStore('meta').put({ key: 'backup', value: meta });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Test transaction failed.'));
    tx.onabort = () => reject(tx.error || new Error('Test transaction aborted.'));
  });
  db.close();

  const result = await idbReadLegacyProfileSnapshot(factory);
  assert.equal(result.status, 'present');
  if (result.status === 'present') {
    assert.deepEqual(result.snapshot.state, state);
    assert.equal(result.snapshot.stateUpdatedAt, '2026-11-20T08:00:00.000Z');
    assert.deepEqual(result.snapshot.restoreCheckpoint, checkpoint);
    assert.deepEqual(result.snapshot.queue, [queue]);
    assert.deepEqual(result.snapshot.meta, meta);
    assert.equal(result.snapshot.hasAnyBusinessData, true);
  }
  const reopened = await factory.open(DB_NAME);
  const readBack = await new Promise<unknown>((resolve, reject) => {
    const request = reopened.transaction('sync_queue', 'readonly').objectStore('sync_queue').get('queue-1');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  reopened.close();
  assert.deepEqual(readBack, queue);
});

test('legacy profile snapshot flags queue-only data when the state row is missing', async () => {
  const factory = createIsolatedFactory();
  const db = await createDatabase(factory, ['app_state', 'sync_queue', 'meta']);
  const queue = { id: 'pending-1', ts: '2026-11-20T08:00:00.000Z', type: 'custom', note: 'pending operation' };
  const tx = db.transaction('sync_queue', 'readwrite');
  tx.objectStore('sync_queue').put(queue);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Test transaction failed.'));
    tx.onabort = () => reject(tx.error || new Error('Test transaction aborted.'));
  });
  db.close();

  const result = await idbReadLegacyProfileSnapshot(factory);
  assert.equal(result.status, 'missing_state');
  if (result.status === 'missing_state') {
    assert.equal(result.snapshot.state, null);
    assert.deepEqual(result.snapshot.queue, [queue]);
    assert.equal(result.snapshot.hasAnyBusinessData, true);
  }
});
