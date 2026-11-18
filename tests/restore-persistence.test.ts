import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { POSState } from '../src/lib/types.ts';
import { idbReadState } from '../src/lib/db.ts';
import { persistAndVerifyRestoredState } from '../src/lib/restorePersistence.ts';

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
    settings: {},
    permissions: {},
    counters: { bill, po: 0, ex: 0, job: 0, quote: 0, claim: 0 },
  } as unknown as POSState;
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
