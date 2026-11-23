import assert from 'node:assert/strict';
import test from 'node:test';
import { createDrainableWorkGate } from '../src/lib/drainableWorkGate.ts';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
test('pause closes admission immediately and waits for already-started work', async () => {
  const gate = createDrainableWorkGate();
  const started = deferred<void>(), finish = deferred<string>();
  const work = gate.run(async () => { started.resolve(); return finish.promise; }, () => 'paused');
  await started.promise;
  const pause = gate.pause();
  assert.equal(gate.isPaused(), true);
  assert.equal(await gate.run(() => 'unexpected', () => 'not-run'), 'not-run');
  let acquired = false; void pause.then(() => { acquired = true; });
  await Promise.resolve(); assert.equal(acquired, false);
  finish.resolve('done'); assert.equal(await work, 'done');
  const release = await pause; assert.equal(acquired, true); assert.equal(gate.activeCount(), 0);
  release(); assert.equal(gate.isPaused(), false);
});
test('release lease is idempotent and new work is admitted afterwards', async () => {
  const gate = createDrainableWorkGate(), release = await gate.pause();
  assert.equal(await gate.run(() => 1, () => 2), 2);
  release(); release(); assert.equal(await gate.run(() => 3, () => 4), 3);
});
test('pause waits for rejected work to settle without swallowing its caller error', async () => {
  const gate = createDrainableWorkGate();
  const started = deferred<void>(), fail = deferred<void>();
  const work = gate.run(async () => { started.resolve(); await fail.promise; throw new Error('worker failed'); }, () => undefined);
  await started.promise; const pause = gate.pause(); fail.resolve();
  await assert.rejects(work, /worker failed/);
  const release = await pause; assert.equal(gate.activeCount(), 0); release();
});
test('rejects a second pause while a pause lease is active', async () => {
  const gate = createDrainableWorkGate(), release = await gate.pause();
  await assert.rejects(gate.pause(), /already paused/); release();
});
test('work registered before pause remains visible while its promise is pending', async () => {
  const gate = createDrainableWorkGate(), finish = deferred<void>();
  const work = gate.run(() => finish.promise, () => undefined);
  await Promise.resolve(); assert.equal(gate.activeCount(), 1);
  const pause = gate.pause(); finish.resolve(); await work;
  const release = await pause; release(); assert.equal(gate.activeCount(), 0);
});
test('pause fallback can inspect durable pending work without running the worker', async () => {
  const gate = createDrainableWorkGate(), release = await gate.pause();
  let calls = 0;
  const result = await gate.run(() => 'worker', () => { calls++; return 'deferred'; });
  assert.equal(result, 'deferred'); assert.equal(calls, 1); release();
});
