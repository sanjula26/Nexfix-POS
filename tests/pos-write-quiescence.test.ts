import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPOSWriteQuiescenceCoordinator,
  POSWriteQuiescenceError,
} from '../src/lib/posWriteQuiescence.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('pause closes the gate, drains active writes, then flushes the latest state', async () => {
  const coordinator = createPOSWriteQuiescenceCoordinator();
  const write = deferred<void>();
  const events: string[] = [];

  const activeWrite = coordinator.runWrite('sale', async () => {
    events.push('write-start');
    await write.promise;
    events.push('write-finish');
  });

  const pause = coordinator.pause({
    flushPendingState: async () => { events.push('flush-latest-state'); },
  });
  assert.equal(coordinator.isPaused, true);
  assert.equal(coordinator.activeWrites, 1);
  await assert.rejects(
    coordinator.runWrite('stock-edit', () => events.push('unexpected-write')),
    (error: unknown) => error instanceof POSWriteQuiescenceError && error.code === 'paused',
  );
  assert.deepEqual(events, ['write-start']);

  write.resolve();
  await activeWrite;
  const lease = await pause;
  assert.deepEqual(events, ['write-start', 'write-finish', 'flush-latest-state']);
  assert.equal(coordinator.activeWrites, 0);
  assert.equal(coordinator.isPaused, true);

  lease.release();
  lease.release();
  assert.equal(coordinator.isPaused, false);
  assert.equal(await coordinator.runWrite('after-resume', () => 'ok'), 'ok');
});

test('flush failure aborts the barrier and re-opens the write gate', async () => {
  const coordinator = createPOSWriteQuiescenceCoordinator();
  await assert.rejects(
    coordinator.pause({ flushPendingState: () => { throw new Error('flush failed'); } }),
    /flush failed/,
  );
  assert.equal(coordinator.isPaused, false);
  assert.equal(await coordinator.runWrite('retry', () => 7), 7);
});

test('timeout aborts migration authorization and re-opens the write gate', async () => {
  const coordinator = createPOSWriteQuiescenceCoordinator();
  const write = deferred<void>();
  const activeWrite = coordinator.runWrite('long-operation', () => write.promise);

  await assert.rejects(
    coordinator.pause({ timeoutMs: 10 }),
    (error: unknown) => error instanceof POSWriteQuiescenceError && error.code === 'timeout',
  );
  assert.equal(coordinator.isPaused, false);
  assert.equal(coordinator.activeWrites, 1);
  assert.equal(await coordinator.runWrite('after-abort', () => 'indexeddb-still-primary'), 'indexeddb-still-primary');

  write.resolve();
  await activeWrite;
  assert.equal(coordinator.activeWrites, 0);
});

test('rejects overlapping pause requests without releasing the first lease', async () => {
  const coordinator = createPOSWriteQuiescenceCoordinator();
  const lease = await coordinator.pause();
  await assert.rejects(
    coordinator.pause(),
    (error: unknown) => error instanceof POSWriteQuiescenceError && error.code === 'already_paused',
  );
  assert.equal(coordinator.isPaused, true);
  lease.release();
  assert.equal(coordinator.isPaused, false);
});

test('invalid pause timeout is rejected before the gate is closed', async () => {
  const coordinator = createPOSWriteQuiescenceCoordinator();
  await assert.rejects(coordinator.pause({ timeoutMs: 0 }), /positive finite number/);
  assert.equal(coordinator.isPaused, false);
});
