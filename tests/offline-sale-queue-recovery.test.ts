import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverPendingSaleQueueIds } from '../src/lib/offlineSaleQueueRecovery.ts';

const sales = [{ id: 'sale-1', billNo: 'NFX-001' }, { id: 'sale-2', billNo: 'NFX-002' }];

test('restores missing stable-ID queue entries and clears markers after read-back', async () => {
  const stored = new Set<string>();
  let cleared: string[] = [];
  const restored = await recoverPendingSaleQueueIds({
    pendingSaleIds: ['sale-1'],
    sales,
    queuedSaleIds: new Set(),
    enqueueSale: async sale => { stored.add(`sale:${sale.id}`); },
    confirmQueueEntry: async queueId => stored.has(queueId),
    clearRecoveryMarkers: async ids => { cleared = ids; return true; },
  });
  assert.equal(restored, 1);
  assert.deepEqual(cleared, ['sale-1']);
});

test('does not rewrite an already-present stable-ID queue entry', async () => {
  let enqueueCalls = 0;
  let cleared: string[] = [];
  const restored = await recoverPendingSaleQueueIds({
    pendingSaleIds: ['sale-1'],
    sales,
    queuedSaleIds: new Set(['sale-1']),
    enqueueSale: async () => { enqueueCalls += 1; },
    confirmQueueEntry: async queueId => queueId === 'sale:sale-1',
    clearRecoveryMarkers: async ids => { cleared = ids; return true; },
  });
  assert.equal(restored, 0);
  assert.equal(enqueueCalls, 0);
  assert.deepEqual(cleared, ['sale-1']);
});

test('keeps a marker when its sale is absent from the durable state snapshot', async () => {
  let clearCalls = 0;
  const restored = await recoverPendingSaleQueueIds({
    pendingSaleIds: ['sale-not-saved'],
    sales,
    queuedSaleIds: new Set(),
    enqueueSale: async () => { assert.fail('must not enqueue an absent sale'); },
    confirmQueueEntry: async () => false,
    clearRecoveryMarkers: async () => { clearCalls += 1; return true; },
  });
  assert.equal(restored, 0);
  assert.equal(clearCalls, 0);
});

test('does not clear recovery marker if queue read-back confirmation fails', async () => {
  let clearCalls = 0;
  await assert.rejects(recoverPendingSaleQueueIds({
    pendingSaleIds: ['sale-1'],
    sales,
    queuedSaleIds: new Set(),
    enqueueSale: async () => undefined,
    confirmQueueEntry: async () => false,
    clearRecoveryMarkers: async () => { clearCalls += 1; return true; },
  }), /could not be confirmed/);
  assert.equal(clearCalls, 0);
});

test('does not clear recovery marker if writing the queue throws', async () => {
  let clearCalls = 0;
  await assert.rejects(recoverPendingSaleQueueIds({
    pendingSaleIds: ['sale-1'],
    sales,
    queuedSaleIds: new Set(),
    enqueueSale: async () => { throw new Error('Injected queue write failure'); },
    confirmQueueEntry: async () => true,
    clearRecoveryMarkers: async () => { clearCalls += 1; return true; },
  }), /Injected queue write failure/);
  assert.equal(clearCalls, 0);
});

test('leaves marker when clearing it cannot be committed; retry remains safe', async () => {
  await assert.rejects(recoverPendingSaleQueueIds({
    pendingSaleIds: ['sale-1'],
    sales,
    queuedSaleIds: new Set(['sale-1']),
    enqueueSale: async () => assert.fail('queue job already exists'),
    confirmQueueEntry: async () => true,
    clearRecoveryMarkers: async () => false,
  }), /recovery marker could not be cleared/);
});
