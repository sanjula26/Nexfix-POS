import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPin, isLegacyPasswordHash, isPasswordHash } from '../src/lib/utils.ts';
import { hashPasswordAsync, verifyPasswordAsync } from '../src/lib/passwordAsync.ts';

test('legacy admin PIN hashes remain readable during migration', async () => {
  const legacyHash = hashPin('2468');
  assert.equal(isLegacyPasswordHash(legacyHash), true);
  assert.equal(isPasswordHash(legacyHash), false);
  assert.equal(await verifyPasswordAsync('2468', legacyHash), true);
  assert.equal(await verifyPasswordAsync('0000', legacyHash), false);
});

test('new admin PIN hashes use salted PBKDF2 and verify asynchronously', async () => {
  const hash = await hashPasswordAsync('2468');
  assert.equal(isPasswordHash(hash), true);
  assert.equal(isLegacyPasswordHash(hash), false);
  const [saltText, derivedText] = hash.split(':');
  assert.equal(atob(saltText).length, 16);
  assert.equal(atob(derivedText).length, 32);
  assert.equal(await verifyPasswordAsync('2468', hash), true);
  assert.equal(await verifyPasswordAsync('0000', hash), false);
});

test('PBKDF2 PIN hashes use a fresh salt for each write', async () => {
  const first = await hashPasswordAsync('same-pin');
  const second = await hashPasswordAsync('same-pin');
  assert.notEqual(first, second);
  assert.equal(await verifyPasswordAsync('same-pin', first), true);
  assert.equal(await verifyPasswordAsync('same-pin', second), true);
});
