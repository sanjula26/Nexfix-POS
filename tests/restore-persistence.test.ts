import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { POSState } from '../src/lib/types.ts';
import {
  idbClearRestoreCheckpoint,
  idbLoadRestoreCheckpoint,
  idbReadState,
  idbSaveRestoreCheckpoint,
  idbSaveState,
} from '../src/lib/db.ts';
import {
  persistAndVerifyRestoredState,
  rollbackAndVerifyRestore,
} from '../src/lib/restorePersistence.ts';

function candidateState(bill: number): POSState {
  return {
    products: [],
    customers: [],
    suppliers: [],
    sales: [],
    purchases: [],
    expenses: [],
    exchanges: [],
    users: [],
    audit: [],
    held: [],
    sessions: [],
    units: [],
    repairs: [],
    settings: {
      shopName: 'Test Shop', tagline: '', address: '', phone: '', email: '', receiptFooter: '',
      taxDefault: 0, lowStockDefault: 5, exchangeDays: 3, openingFloat: 0,
      adminPinHash: '', whatsappReceipts: false,
    },
    permissions: { admin: { 'page:dashboard': true }, cashier: { 'page:pos': true } },
    counters: { bill, po: 0, ex: 0, job: 0, quote: 0, claim: 0 },
  } as POSState;
}

test('restore persistence verifies the complete committed IndexedDB state', async () => {
  const candidate = candidateState(73);
  await persistAndVerifyRestoredState(candidate);
  assert.deepEqual(await idbReadState(), candidate);
});

test('restore persistence fails closed when the saved row cannot be read back', async () => {
  const originalTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
    if (args[0] === 'app_state' && args[1] === 'readonly') {
      throw new DOMException('Injected restore read-back failure', 'InvalidStateError');
    }
    return originalTransaction.apply(this, args);
  } as IDBDatabase['transaction'];

  try {
    await assert.rejects(
      persistAndVerifyRestoredState(candidateState(74)),
      /could not be verified after saving/,
    );
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
  }
});

test('rollback verifies the checkpointed state before clearing the checkpoint', async () => {
  const original = candidateState(75);
  await idbSaveRestoreCheckpoint(original);
  await idbSaveState(candidateState(76));

  assert.equal(await rollbackAndVerifyRestore(), true);
  assert.deepEqual(await idbReadState(), original);
  assert.equal(await idbLoadRestoreCheckpoint(), null);
});

test('rollback keeps its checkpoint when read-back verification fails', async () => {
  const original = candidateState(77);
  await idbSaveRestoreCheckpoint(original);
  await idbSaveState(candidateState(78));

  const originalTransaction = IDBDatabase.prototype.transaction;
  let stateReadCount = 0;
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
    if (args[0] === 'app_state' && args[1] === 'readonly') {
      stateReadCount += 1;
      // First read loads the checkpoint; fail only the second read, which
      // verifies the restored main row after its write has committed.
      if (stateReadCount === 2) {
        throw new DOMException('Injected rollback read-back failure', 'InvalidStateError');
      }
    }
    return originalTransaction.apply(this, args);
  } as IDBDatabase['transaction'];

  try {
    assert.equal(await rollbackAndVerifyRestore(), false);
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
  }

  assert.deepEqual(await idbLoadRestoreCheckpoint(), original);
  assert.deepEqual(await idbReadState(), original);
  await idbClearRestoreCheckpoint();
});
