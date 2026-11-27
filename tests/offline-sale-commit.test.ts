import assert from 'node:assert/strict';
import test from 'node:test';
import { commitLocalSaleDurably, LocalSaleDurabilityError } from '../src/lib/offlineSaleCommit.ts';

type State = { sales: Array<{ id: string }> };

function baseDependencies(overrides: Partial<Parameters<typeof commitLocalSaleDurably<{ id: string }, State>>[0]> = {}) {
  const calls: string[] = [];
  const sale = { id: 'sale-stable-1' };
  const state = { sales: [sale] };
  const dependencies = {
    saleId: sale.id,
    reserveRecoveryMarker: async () => { calls.push('reserve'); return true; },
    createLocalSale: () => { calls.push('create'); return sale; },
    waitForCommittedState: async () => { calls.push('wait-state'); return state; },
    stateContainsSale: (snapshot: State, saleId: string) => snapshot.sales.some(item => item.id === saleId),
    persistState: async () => { calls.push('persist'); return true; },
    readBackState: async () => { calls.push('read-back-state'); return state; },
    enqueueSale: async () => { calls.push('enqueue'); },
    confirmQueueEntry: async () => { calls.push('read-back-queue'); return true; },
    clearRecoveryMarker: async () => { calls.push('clear-marker'); return true; },
    saleNotCreatedMessage: 'Local sale was not created.',
    storageNotConfirmedMessage: 'Local sale storage is not confirmed.',
    ...overrides,
  };
  return { dependencies, calls, sale, state };
}

test('local receipt is returned only after marker, state and queue are confirmed in order', async () => {
  const { dependencies, calls, sale } = baseDependencies();
  const result = await commitLocalSaleDurably(dependencies);
  assert.deepEqual(result, { sale, syncPending: false });
  assert.deepEqual(calls, [
    'reserve', 'create', 'wait-state', 'persist', 'read-back-state',
    'enqueue', 'read-back-queue', 'clear-marker',
  ]);
});

test('queue failure preserves durable local receipt and recovery marker', async () => {
  const { dependencies, calls, sale } = baseDependencies({
    enqueueSale: async () => { calls.push('enqueue'); throw new Error('Queue quota reached'); },
  });
  const result = await commitLocalSaleDurably(dependencies);
  assert.deepEqual(result, { sale, syncPending: true });
  assert.equal(calls.includes('clear-marker'), false);
});

test('queue read-back failure preserves recovery marker for the next sync pass', async () => {
  const { dependencies, calls, sale } = baseDependencies({
    confirmQueueEntry: async () => { calls.push('read-back-queue'); return false; },
  });
  const result = await commitLocalSaleDurably(dependencies);
  assert.deepEqual(result, { sale, syncPending: true });
  assert.equal(calls.includes('clear-marker'), false);
});

test('metadata marker failure blocks sale creation before any local mutation', async () => {
  const { dependencies, calls } = baseDependencies({
    reserveRecoveryMarker: async () => { calls.push('reserve'); return false; },
  });
  await assert.rejects(commitLocalSaleDurably(dependencies), LocalSaleDurabilityError);
  assert.deepEqual(calls, ['reserve']);
});

test('a failed state save is accepted only when read-back proves the exact sale is durable', async () => {
  const { dependencies, calls, sale } = baseDependencies({
    persistState: async () => { calls.push('persist'); return false; },
  });
  const result = await commitLocalSaleDurably(dependencies);
  assert.deepEqual(result, { sale, syncPending: false });
});

test('missing sale on state read-back blocks the receipt and retains its recovery marker', async () => {
  const { dependencies, calls } = baseDependencies({
    readBackState: async () => { calls.push('read-back-state'); return { sales: [] }; },
  });
  await assert.rejects(commitLocalSaleDurably(dependencies), LocalSaleDurabilityError);
  assert.equal(calls.includes('enqueue'), false);
  assert.equal(calls.includes('clear-marker'), false);
});

test('state read-back failure blocks the receipt and retains its recovery marker', async () => {
  const { dependencies, calls } = baseDependencies({
    readBackState: async () => { calls.push('read-back-state'); throw new Error('profile disk unavailable'); },
  });
  await assert.rejects(commitLocalSaleDurably(dependencies), LocalSaleDurabilityError);
  assert.equal(calls.includes('enqueue'), false);
  assert.equal(calls.includes('clear-marker'), false);
});

test('null local sale removes the marker best-effort and does not return a receipt', async () => {
  const { dependencies, calls } = baseDependencies({
    createLocalSale: () => { calls.push('create'); return null; },
  });
  await assert.rejects(commitLocalSaleDurably(dependencies), /Local sale was not created/);
  assert.deepEqual(calls, ['reserve', 'create', 'clear-marker']);
});
