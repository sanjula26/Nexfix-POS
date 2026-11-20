import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { IDBFactory } from 'fake-indexeddb';
import { idbInspectExistingState } from '../src/lib/db.ts';

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
