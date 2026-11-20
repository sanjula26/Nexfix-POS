const assert = require('node:assert/strict');
const test = require('node:test');
const { beginLocalAuthAttempt, completeLocalAuthAttempt } = require('../electron/local-auth-guard.cjs');

function failAttempt(state, now, id) {
  const begun = beginLocalAuthAttempt(state, now, id);
  assert.equal(begun.result.ok, true);
  return completeLocalAuthAttempt(begun.state, id, false, now).state;
}

test('shared local-auth guard permits attempts then applies exponential backoff', () => {
  let state = {};
  for (let i = 1; i <= 4; i++) state = failAttempt(state, 1000 + i, 'attempt-' + i);
  assert.equal(state.failures, 4);
  const fifth = beginLocalAuthAttempt(state, 2000, 'attempt-5');
  assert.equal(fifth.result.ok, true);
  state = completeLocalAuthAttempt(fifth.state, 'attempt-5', false, 2000).state;
  assert.equal(state.lockedUntil, 17_000);
  const blocked = beginLocalAuthAttempt(state, 3000, 'attempt-6');
  assert.equal(blocked.result.ok, false);
  assert.equal(blocked.result.retryAfterMs, 14_000);
});

test('successful verification resets failures and lockout history', () => {
  let state = {};
  for (let i = 1; i <= 5; i++) state = failAttempt(state, i, 'attempt-' + i);
  const afterLock = beginLocalAuthAttempt(state, state.lockedUntil, 'valid-attempt');
  assert.equal(afterLock.result.ok, true);
  const completed = completeLocalAuthAttempt(afterLock.state, 'valid-attempt', true, state.lockedUntil);
  assert.deepEqual(completed.state, { version: 1, failures: 0, lockedUntil: 0, pending: null });
});

test('concurrent attempts are blocked while one verification is pending', () => {
  const first = beginLocalAuthAttempt({}, 5000, 'first');
  const second = beginLocalAuthAttempt(first.state, 5001, 'second');
  assert.equal(first.result.ok, true);
  assert.equal(second.result.ok, false);
  assert.equal(second.result.retryAfterMs, 29_999);
});

test('an interrupted verification is counted as a failure after the pending lease expires', () => {
  const first = beginLocalAuthAttempt({}, 10_000, 'interrupted');
  const next = beginLocalAuthAttempt(first.state, 40_001, 'retry');
  assert.equal(next.result.ok, true);
  assert.equal(next.state.failures, 1);
  assert.equal(next.state.pending.id, 'retry');
});

test('completion requires the active attempt id and a boolean result', () => {
  const first = beginLocalAuthAttempt({}, 100, 'active');
  assert.deepEqual(completeLocalAuthAttempt(first.state, 'other', true, 101).result, { ok: false });
  assert.deepEqual(completeLocalAuthAttempt(first.state, 'active', 'true', 101).result, { ok: false });
});
