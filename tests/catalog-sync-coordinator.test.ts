import assert from 'node:assert/strict';
import test from 'node:test';
import { createFingerprintSyncCoordinator } from '../src/lib/catalogSyncCoordinator.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('shares one in-flight catalog sync for the same identity and fingerprint', async () => {
  const coordinator = createFingerprintSyncCoordinator<{ ok: boolean; customerIdMap?: Record<string, string> }>();
  const gate = deferred<{ ok: boolean; customerIdMap?: Record<string, string> }>();
  let calls = 0;
  const sync = () => {
    calls += 1;
    return gate.promise;
  };

  const first = coordinator.run('shop-a:user-a', 'catalog-v1', sync);
  const second = coordinator.run('shop-a:user-a', 'catalog-v1', sync);
  await Promise.resolve();
  assert.equal(calls, 1);

  const result = { ok: true, customerIdMap: { 'local-customer': 'cloud-customer' } };
  gate.resolve(result);
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.strictEqual(firstResult, result);
  assert.strictEqual(secondResult, result);
});

test('reuses only a successful result for an unchanged catalog fingerprint', async () => {
  const coordinator = createFingerprintSyncCoordinator<{ ok: boolean; version: string }>();
  let calls = 0;
  const sync = async (version: string) => {
    calls += 1;
    return { ok: true, version };
  };

  const first = await coordinator.run('shop-a:user-a', 'catalog-v1', () => sync('v1'));
  const cached = await coordinator.run('shop-a:user-a', 'catalog-v1', () => sync('unexpected'));
  const changed = await coordinator.run('shop-a:user-a', 'catalog-v2', () => sync('v2'));

  assert.deepEqual(first, { ok: true, version: 'v1' });
  assert.strictEqual(cached, first);
  assert.deepEqual(changed, { ok: true, version: 'v2' });
  assert.equal(calls, 2);
});

test('serializes different fingerprints so newer catalog state runs after older state', async () => {
  const coordinator = createFingerprintSyncCoordinator<{ ok: boolean; version: string }>();
  const firstGate = deferred<{ ok: boolean; version: string }>();
  const started: string[] = [];

  const first = coordinator.run('shop-a:user-a', 'catalog-v1', () => {
    started.push('v1');
    return firstGate.promise;
  });
  await Promise.resolve();

  const second = coordinator.run('shop-a:user-a', 'catalog-v2', async () => {
    started.push('v2');
    return { ok: true, version: 'v2' };
  });
  await Promise.resolve();
  assert.deepEqual(started, ['v1']);

  firstGate.resolve({ ok: true, version: 'v1' });
  await first;
  assert.deepEqual(await second, { ok: true, version: 'v2' });
  assert.deepEqual(started, ['v1', 'v2']);
});

test('does not cache failed results and lets another identity sync independently', async () => {
  const coordinator = createFingerprintSyncCoordinator<{ ok: boolean; error?: string }>();
  let calls = 0;
  const failed = await coordinator.run('shop-a:user-a', 'catalog-v1', async () => {
    calls += 1;
    return { ok: false, error: 'temporary network failure' };
  });
  const retried = await coordinator.run('shop-a:user-a', 'catalog-v1', async () => {
    calls += 1;
    return { ok: true };
  });
  const otherUser = await coordinator.run('shop-a:user-b', 'catalog-v1', async () => {
    calls += 1;
    return { ok: true };
  });

  assert.equal(failed.ok, false);
  assert.equal(retried.ok, true);
  assert.equal(otherUser.ok, true);
  assert.equal(calls, 3);
});

test('serializes multiple queued catalog fingerprints in invocation order', async () => {
  const coordinator = createFingerprintSyncCoordinator<{ ok: boolean; version: string }>();
  const firstGate = deferred<{ ok: boolean; version: string }>();
  const started: string[] = [];

  const first = coordinator.run('shop-a:user-a', 'catalog-v1', () => {
    started.push('v1');
    return firstGate.promise;
  });
  await Promise.resolve();

  const second = coordinator.run('shop-a:user-a', 'catalog-v2', async () => {
    started.push('v2');
    return { ok: true, version: 'v2' };
  });
  const third = coordinator.run('shop-a:user-a', 'catalog-v3', async () => {
    started.push('v3');
    return { ok: true, version: 'v3' };
  });
  const secondDuplicate = coordinator.run('shop-a:user-a', 'catalog-v2', async () => {
    started.push('duplicate-v2');
    return { ok: true, version: 'unexpected' };
  });

  await Promise.resolve();
  assert.deepEqual(started, ['v1']);

  firstGate.resolve({ ok: true, version: 'v1' });
  assert.deepEqual(await first, { ok: true, version: 'v1' });
  assert.deepEqual(await Promise.all([second, third, secondDuplicate]), [
    { ok: true, version: 'v2' },
    { ok: true, version: 'v3' },
    { ok: true, version: 'v2' },
  ]);
  assert.deepEqual(started, ['v1', 'v2', 'v3']);
});

