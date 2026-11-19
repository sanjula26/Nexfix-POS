import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithAsyncLock } from '../src/lib/authConcurrency.ts';

test('async lock rejects overlapping operations and releases after completion', async () => {
  const lock = { current: false };
  let finishFirst!: (value: string) => void;
  let secondOperationRan = false;

  const first = runWithAsyncLock(lock, () => 'busy', () => new Promise<string>(resolve => {
    finishFirst = resolve;
  }));

  assert.equal(lock.current, true);
  const second = await runWithAsyncLock(
    lock,
    () => 'busy',
    async () => {
      secondOperationRan = true;
      return 'second';
    },
  );

  assert.equal(second, 'busy');
  assert.equal(secondOperationRan, false);
  finishFirst('first');
  assert.equal(await first, 'first');
  assert.equal(lock.current, false);
});

test('async lock releases after a rejected operation', async () => {
  const lock = { current: false };

  await assert.rejects(
    runWithAsyncLock(lock, () => 'busy', async () => {
      throw new Error('verification failed');
    }),
    /verification failed/,
  );

  assert.equal(lock.current, false);
  const retry = await runWithAsyncLock(lock, () => 'busy', async () => 'retry');
  assert.equal(retry, 'retry');
});
