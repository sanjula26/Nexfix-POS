import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearAuthThrottle,
  getAuthThrottleWaitMs,
  recordAuthThrottleFailure,
  type AuthThrottleStorage,
} from '../src/lib/authThrottle.ts';

const createStorage = (): AuthThrottleStorage => {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  };
};

test('admin credential attempts share a persisted backoff across reload-like reads', () => {
  const storage = createStorage();
  for (let i = 0; i < 4; i++) {
    const result = recordAuthThrottleFailure('admin-shared', 1_000 + i, storage);
    assert.equal(result.lockedUntil, 0);
  }
  const fifth = recordAuthThrottleFailure('admin-shared', 2_000, storage);
  assert.equal(fifth.failures, 5);
  assert.equal(fifth.lockedUntil, 17_000);
  assert.equal(getAuthThrottleWaitMs('admin-shared', 2_001, storage), 14_999);
  assert.equal(JSON.parse(storage.getItem('nexfix_auth_throttle_v1:admin-shared') || '{}').failures, 5);
});

test('backoff grows exponentially and is capped at five minutes', () => {
  const storage = createStorage();
  let state = { failures: 0, lockedUntil: 0 };
  for (let i = 0; i < 10; i++) state = recordAuthThrottleFailure('bounded', 10_000, storage);
  assert.equal(state.lockedUntil, 310_000);
  state = recordAuthThrottleFailure('bounded', 20_000, storage);
  assert.equal(state.lockedUntil, 320_000);
});

test('successful authentication clears persisted and in-memory failures', () => {
  const storage = createStorage();
  recordAuthThrottleFailure('admin-clear', 1_000, storage);
  clearAuthThrottle('admin-clear', storage);
  assert.equal(getAuthThrottleWaitMs('admin-clear', 1_000, storage), 0);
  assert.equal(recordAuthThrottleFailure('admin-clear', 1_000, storage).failures, 1);
});

test('malformed persisted limiter data is ignored safely', () => {
  const storage = createStorage();
  storage.setItem('nexfix_auth_throttle_v1:admin-malformed', JSON.stringify({ failures: -2, lockedUntil: 'later' }));
  assert.equal(getAuthThrottleWaitMs('admin-malformed', 5_000, storage), 0);
  assert.equal(recordAuthThrottleFailure('admin-malformed', 5_000, storage).failures, 1);
});

test('storage exceptions do not disable the in-memory limiter', () => {
  const storage: AuthThrottleStorage = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  for (let i = 0; i < 5; i++) recordAuthThrottleFailure('private', 10_000, storage);
  assert.equal(getAuthThrottleWaitMs('private', 10_001, storage), 14_999);
});

test('untrusted persisted counters and timestamps cannot create an indefinite lockout', () => {
  const storage = createStorage();
  storage.setItem('nexfix_auth_throttle_v1:future', JSON.stringify({
    failures: Number.MAX_SAFE_INTEGER,
    lockedUntil: Number.MAX_SAFE_INTEGER,
  }));
  assert.equal(getAuthThrottleWaitMs('future', 1_000, storage), 300_000);
  const state = recordAuthThrottleFailure('future', 1_000, storage);
  assert.equal(state.failures, 10);
  assert.equal(state.lockedUntil, 301_000);
});

test('different credential scopes keep independent failure counters', () => {
  const storage = createStorage();
  for (let i = 0; i < 5; i++) recordAuthThrottleFailure('scope-a', 1_000, storage);
  assert.equal(getAuthThrottleWaitMs('scope-a', 1_001, storage), 14_999);
  assert.equal(getAuthThrottleWaitMs('scope-b', 1_001, storage), 0);
});

test('cashier idle-unlock failures do not consume the shared admin budget', async () => {
  const { shouldCountAdminIdleUnlockFailure } = await import('../src/lib/authThrottle.ts');
  assert.equal(shouldCountAdminIdleUnlockFailure('cashier', true), false);
  assert.equal(shouldCountAdminIdleUnlockFailure('cashier', false), false);
  assert.equal(shouldCountAdminIdleUnlockFailure('admin', true), true);
  assert.equal(shouldCountAdminIdleUnlockFailure('admin', false), false);
});
