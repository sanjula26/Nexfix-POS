'use strict';

const { pbkdf2, timingSafeEqual } = require('node:crypto');

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_KEY_BYTES = 32;

function decodeCanonicalBase64(value, expectedBytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }

  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== expectedBytes || decoded.toString('base64') !== value) {
    decoded.fill(0);
    return null;
  }

  return decoded;
}

function derivePasswordKey(password, salt) {
  return new Promise((resolve, reject) => {
    pbkdf2(
      password,
      salt,
      PBKDF2_ITERATIONS,
      PBKDF2_KEY_BYTES,
      'sha256',
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

/**
 * Verifies the current local POS password verifier format:
 * base64(16-byte random salt):base64(PBKDF2-HMAC-SHA256 32-byte digest).
 *
 * This primitive intentionally does not accept legacy SHA-256 verifiers.
 * It is not wired to login or IPC until the local-auth authority migration
 * and its legacy-account policy are separately reviewed.
 */
async function verifyLocalPasswordHash(password, storedHash) {
  if (typeof password !== 'string' || password.length === 0 || typeof storedHash !== 'string') {
    return false;
  }

  const separator = storedHash.indexOf(':');
  if (separator < 0 || storedHash.indexOf(':', separator + 1) !== -1) {
    return false;
  }

  const salt = decodeCanonicalBase64(storedHash.slice(0, separator), PBKDF2_SALT_BYTES);
  const expected = decodeCanonicalBase64(storedHash.slice(separator + 1), PBKDF2_KEY_BYTES);

  if (!salt || !expected) {
    salt?.fill(0);
    expected?.fill(0);
    return false;
  }

  let actual;
  try {
    actual = await derivePasswordKey(password, salt);
    return timingSafeEqual(expected, actual);
  } finally {
    salt.fill(0);
    expected.fill(0);
    actual?.fill(0);
  }
}

module.exports = {
  verifyLocalPasswordHash,
};
