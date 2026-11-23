import assert from 'node:assert/strict';
import test from 'node:test';
import { createStatePersistenceGate } from '../src/lib/statePersistenceGate.ts';

test('drains normal writes and flushes the latest snapshot before releasing a lease', async () => {
  const saved: number[] = [];
  const gate = createStatePersistenceGate<number>(async state => {
    saved.push(state);
    return { stateSaved: true, queueSaved: true };
  });
  await gate.persist(1);
  const lease = await gate.pauseAndFlush(() => 2);
  assert.deepEqual(saved, [1, 2]);
  assert.equal(lease.latestState, 2);
  assert.equal(lease.stateSaved, true);
  await assert.rejects(gate.persist(3), /temporarily paused/);
  lease.release();
  await gate.persist(3);
  assert.deepEqual(saved, [1, 2, 3]);
});

test('quota exhaustion preserves the latest in-memory snapshot for folder migration', async () => {
  const gate = createStatePersistenceGate<{ revision: number }>(async () => ({
    stateSaved: false,
    queueSaved: false,
    failureKind: 'quota_exceeded',
  }));
  const lease = await gate.pauseAndFlush(() => ({ revision: 42 }));
  assert.deepEqual(lease.latestState, { revision: 42 });
  assert.equal(lease.stateSaved, false);
  assert.equal(lease.failureKind, 'quota_exceeded');
  lease.release();
});

test('non-quota storage failures abort maintenance and reopen the gate', async () => {
  const gate = createStatePersistenceGate<number>(async () => ({
    stateSaved: false,
    queueSaved: false,
    failureKind: 'write_failed',
  }));
  await assert.rejects(gate.pauseAndFlush(() => 7), /Could not safely read or flush/);
  assert.equal((await gate.persist(8)).failureKind, 'write_failed');
});

test('unavailable IndexedDB aborts maintenance rather than copying an incomplete snapshot', async () => {
  const gate = createStatePersistenceGate<number>(async () => ({
    stateSaved: false,
    queueSaved: false,
    failureKind: 'unavailable',
  }));
  await assert.rejects(gate.pauseAndFlush(() => 9), /Could not safely read or flush/);
});
