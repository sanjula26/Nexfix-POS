'use strict';

const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const test = require('node:test');
const { verifyLocalPasswordHash } = require('../electron/local-auth-crypto.cjs');

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

test('verifies password hashes produced by the existing renderer hashPassword helper', async () => {
  const { hashPassword } = await import('../src/lib/utils.ts');
  const password = 'Nexfix-local-password-සිංහල-2026';
  const storedHash = hashPassword(password);

  assert.equal(await verifyLocalPasswordHash(password, storedHash), true);
  assert.equal(await verifyLocalPasswordHash('incorrect-password', storedHash), false);
});

test('rejects legacy hashes and malformed verifier encodings', async () => {
  const validSalt = Buffer.alloc(16, 0x5a).toString('base64');
  const validDigest = Buffer.alloc(32, 0xa5).toString('base64');
  const invalidHashes = [
    '',
    'not-a-verifier',
    'a'.repeat(64),
    `${validSalt}:${validDigest}:extra`,
    `${Buffer.alloc(15).toString('base64')}:${validDigest}`,
    `${validSalt}:${Buffer.alloc(31).toString('base64')}`,
    `${validSalt.replace(/==$/, '=')}:${validDigest}`,
    `${validSalt}:${validDigest.slice(0, -1)}!`,
    'A'.repeat(100_000),
  ];

  for (const storedHash of invalidHashes) {
    assert.equal(await verifyLocalPasswordHash('Nexfix-test-password-2026', storedHash), false);
  }
});

test('rejects empty or non-string password inputs', async () => {
  assert.equal(await verifyLocalPasswordHash('', 'not-a-verifier'), false);
  assert.equal(await verifyLocalPasswordHash(null, 'not-a-verifier'), false);
  assert.equal(await verifyLocalPasswordHash('Nexfix-test-password-2026', null), false);
});
