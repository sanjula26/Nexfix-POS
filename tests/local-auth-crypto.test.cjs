'use strict';

const assert = require('node:assert/strict');
const { pbkdf2Sync } = require('node:crypto');
const test = require('node:test');
const { verifyLocalPasswordHash } = require('../electron/local-auth-crypto.cjs');

const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

function currentFormatHash(password, salt = Buffer.alloc(SALT_BYTES, 0x5a)) {
  const digest = pbkdf2Sync(password, salt, ITERATIONS, KEY_BYTES, 'sha256');
  return `${salt.toString('base64')}:${digest.toString('base64')}`;
}

test('verifies the current local POS PBKDF2-HMAC-SHA256 password format', async () => {
  const password = 'Nexfix-test-password-2026';
  const storedHash = currentFormatHash(password);

  assert.equal(await verifyLocalPasswordHash(password, storedHash), true);
  assert.equal(await verifyLocalPasswordHash('incorrect-password', storedHash), false);
});

test('rejects legacy hashes and malformed verifier encodings', async () => {
  const validSalt = Buffer.alloc(SALT_BYTES, 0x5a).toString('base64');
  const validDigest = Buffer.alloc(KEY_BYTES, 0xa5).toString('base64');
  const invalidHashes = [
    '',
    'not-a-verifier',
    'a'.repeat(64),
    `${validSalt}:${validDigest}:extra`,
    `${Buffer.alloc(SALT_BYTES - 1).toString('base64')}:${validDigest}`,
    `${validSalt}:${Buffer.alloc(KEY_BYTES - 1).toString('base64')}`,
    `${validSalt.replace(/==$/, '=')}:${validDigest}`,
    `${validSalt}:${validDigest.slice(0, -1)}!`,
  ];

  for (const storedHash of invalidHashes) {
    assert.equal(await verifyLocalPasswordHash('Nexfix-test-password-2026', storedHash), false);
  }
});

test('rejects empty or non-string password inputs', async () => {
  const storedHash = currentFormatHash('Nexfix-test-password-2026');

  assert.equal(await verifyLocalPasswordHash('', storedHash), false);
  assert.equal(await verifyLocalPasswordHash(null, storedHash), false);
  assert.equal(await verifyLocalPasswordHash('Nexfix-test-password-2026', null), false);
});
