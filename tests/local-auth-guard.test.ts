import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalAuthGuard } from '../src/lib/localAuthGuard.ts';
import { hashPin, hashPassword, verifyPassword, isLegacyPasswordHash, isPasswordHash } from '../src/lib/utils.ts';

function createHarness() {
  let raw: string | null = null;
  let time = 1_000;
  let id = 0;
  const storage = {
    getItem: (key: string) => key === 'nexfix_local_auth_guard_v1' ? raw : null,
    setItem: (key: string, value: string) => { if (key === 'nexfix_local_auth_guard_v1') raw = value; },
  };
  return {
    guard: createLocalAuthGuard(storage, () => time, () => 'attempt-' + (++id)),
    setTime: (next: number) => { time = next; },
    getRaw: () => raw,
    setRaw: (next: string | null) => { raw = next; },
  };
}

test('local auth guard applies exponential lockout after five failed attempts', () => {
  const h = createHarness();
  for (let i = 0; i < 5; i++) {
    const attempt = h.guard.begin();
    assert.equal(attempt.ok, true);
    if (attempt.ok) assert.equal(h.guard.complete(attempt.attemptId, false), true);
  }
  const blocked = h.guard.begin();
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.retryAfterMs, 15_000);
});

test('successful verification resets the persisted failure counter', () => {
  const h = createHarness();
  for (let i = 0; i < 5; i++) {
    const attempt = h.guard.begin();
    if (attempt.ok) h.guard.complete(attempt.attemptId, false);
  }
  h.setTime(16_000);
  const valid = h.guard.begin();
  assert.equal(valid.ok, true);
  if (valid.ok) h.guard.complete(valid.attemptId, true);
  const next = h.guard.begin();
  assert.equal(next.ok, true);
  assert.match(h.getRaw() || '', /"failures":0/);
});

test('a second concurrent prompt cannot start while a verification is pending', () => {
  const h = createHarness();
  const first = h.guard.begin();
  const second = h.guard.begin();
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.retryAfterMs, 30_000);
});

test('a pending verification from before reload is counted after its lease expires', () => {
  const h = createHarness();
  const first = h.guard.begin();
  assert.equal(first.ok, true);
  h.setTime(31_001);
  const second = h.guard.begin();
  assert.equal(second.ok, true);
  assert.match(h.getRaw() || '', /"failures":1/);
});

test('corrupt browser guard state fails closed instead of resetting attempts', () => {
  const h = createHarness();
  h.setRaw('{broken');
  const blocked = h.guard.begin();
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.retryAfterMs, 300_000);
});


test('legacy admin PIN hashes verify for migration and new PIN hashes use salted PBKDF2', async () => {
  const legacy = hashPin('old-admin-pin-123');
  assert.equal(isLegacyPasswordHash(legacy), true);
  assert.equal(verifyPassword('old-admin-pin-123', legacy), true);
  const migrated = hashPassword('new-admin-pin-123');
  assert.equal(isPasswordHash(migrated), true);
  assert.equal(isLegacyPasswordHash(migrated), false);
  assert.equal(verifyPassword('new-admin-pin-123', migrated), true);
  assert.equal(verifyPassword('wrong-admin-pin', migrated), false);
});
