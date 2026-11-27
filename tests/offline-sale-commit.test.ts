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

test('durable local receipt returns before background queue finalization', async () => {
  const { dependencies, calls, sale } = baseDependencies();
  const result = await commitLocalSaleDurably(dependencies);

  assert.equal(result.sale, sale);
  assert.deepEqual(calls, ['reserve', 'create', 'wait-state', 'persist', 'read-back-state']);

  const firstFinalization = result.finalizeQueue();
  assert.strictEqual(result.finalizeQueue(), firstFinalization, 'queue finalization must be idempotent');
  assert.equal(await firstFinalization, false);
  assert.deepEqual(calls, [
    'reserve', 'create', 'wait-state', 'persist', 'read-back-state',
    'enqueue', 'read-back-queue', 'clear-marker',
  ]);
});

test('receipt does not wait for a slow normalized queue write', async () => {
  let releaseQueue!: () => void;
  const queueGate = new Promise<void>(resolve => { releaseQueue = resolve; });
  const { dependencies, calls, sale } = baseDependencies({
    enqueueSale: async () => {
      calls.push('enqueue-start');
      await queueGate;
      calls.push('enqueue-finished');
    },
  });

  const result = await commitLocalSaleDurably(dependencies);
  assert.equal(result.sale, sale);
  assert.deepEqual(calls, ['reserve', 'create', 'wait-state', 'persist', 'read-back-state']);

  const finalization = result.finalizeQueue();
  await Promise.resolve();
  assert.equal(calls.includes('enqueue-start'), true);
  assert.equal(calls.includes('enqueue-finished'), false);
  releaseQueue();
  assert.equal(await finalization, false);
  assert.equal(calls.includes('enqueue-finished'), true);
});

test('queue failure preserves durable local receipt and recovery marker', async () => {
  const { dependencies, calls, sale } = baseDependencies({
    enqueueSale: async () => { calls.push('enqueue'); throw new Error('Queue quota reached'); },
  });
  const result = await commitLocalSaleDurably(dependencies);
  assert.equal(result.sale, sale);
  assert.equal(await result.finalizeQueue(), true);
  assert.equal(calls.includes('clear-marker'), false);
});

test('queue read-back failure preserves recovery marker for the next sync pass', async () => {
  const { dependencies, calls, sale } = baseDependencies({
    confirmQueueEntry: async () => { calls.push('read-back-queue'); return false; },
  });
  const result = await commitLocalSaleDurably(dependencies);
  assert.equal(result.sale, sale);
  assert.equal(await result.finalizeQueue(), true);
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
  assert.equal(result.sale, sale);
  assert.equal(await result.finalizeQueue(), false);
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
