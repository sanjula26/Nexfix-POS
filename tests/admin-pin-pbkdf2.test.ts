import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPin, isLegacyPasswordHash, isPasswordHash } from '../src/lib/utils.ts';
import { hashPasswordAsync, verifyPasswordAsync, verifyPasswordAsyncWithFallback, verifyPasswordWithLegacyUpgrade } from '../src/lib/passwordAsync.ts';

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

test('legacy PIN upgrades only after a successful verification', async () => {
  const legacyHash = hashPin('1357');
  const failed = await verifyPasswordWithLegacyUpgrade('0000', legacyHash);
  assert.equal(failed.valid, false);
  assert.equal(failed.upgradedHash, undefined);

  const passed = await verifyPasswordWithLegacyUpgrade('1357', legacyHash);
  assert.equal(passed.valid, true);
  assert.ok(passed.upgradedHash);
  assert.equal(isPasswordHash(passed.upgradedHash!), true);
  assert.equal(await verifyPasswordAsync('1357', passed.upgradedHash!), true);
  assert.notEqual(passed.upgradedHash, legacyHash);
});

test('current PBKDF2 PIN verification does not need a replacement hash', async () => {
  const currentHash = await hashPasswordAsync('8642');
  const result = await verifyPasswordWithLegacyUpgrade('8642', currentHash);
  assert.equal(result.valid, true);
  assert.equal(result.upgradedHash, undefined);
});


test('PBKDF2 creation and verification remain secure when WebCrypto subtle is unavailable', async () => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const nativeCrypto = globalThis.crypto;
  assert.ok(cryptoDescriptor?.configurable, 'test runtime must allow isolated WebCrypto fallback simulation');

  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto),
      subtle: undefined,
    },
  });

  try {
    const fallbackHash = await hashPasswordAsync('fallback-pin');
    const secondFallbackHash = await hashPasswordAsync('fallback-pin');
    assert.notEqual(secondFallbackHash, fallbackHash, 'fallback must generate a fresh random salt');
    assert.equal(isPasswordHash(fallbackHash), true);
    assert.equal(isLegacyPasswordHash(fallbackHash), false);
    const [saltText, derivedText] = fallbackHash.split(':');
    assert.equal(atob(saltText).length, 16);
    assert.equal(atob(derivedText).length, 32);
    assert.equal(await verifyPasswordAsync('fallback-pin', fallbackHash), true);
    assert.equal(await verifyPasswordAsync('wrong-pin', fallbackHash), false);
  } finally {
    if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
  }
});


test('a completed WebCrypto mismatch rejects without running the synchronous PBKDF2 fallback', async () => {
  const storedHash = await hashPasswordAsync('correct-pin');
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const nativeCrypto = globalThis.crypto;
  assert.ok(cryptoDescriptor?.configurable, 'test runtime must allow isolated WebCrypto simulation');

  let fallbackCalls = 0;
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto),
      subtle: {
        importKey: async () => ({}),
        deriveBits: async () => new ArrayBuffer(32),
      },
    },
  });

  try {
    const valid = await verifyPasswordAsyncWithFallback('wrong-pin', storedHash, () => {
      fallbackCalls += 1;
      return false;
    });
    assert.equal(valid, false);
    assert.equal(fallbackCalls, 0, 'a completed but mismatching WebCrypto derivation must not repeat PBKDF2 synchronously');
  } finally {
    if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
  }
});


test('WebCrypto errors use the deterministic fallback verifier', async () => {
  const storedHash = await hashPasswordAsync('correct-pin');
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const nativeCrypto = globalThis.crypto;
  assert.ok(cryptoDescriptor?.configurable, 'test runtime must allow isolated WebCrypto failure simulation');

  let fallbackCalls = 0;
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto),
      subtle: {
        importKey: async () => ({}),
        deriveBits: async () => { throw new Error('simulated WebCrypto failure'); },
      },
    },
  });

  try {
    const valid = await verifyPasswordAsyncWithFallback('correct-pin', storedHash, () => {
      fallbackCalls += 1;
      return true;
    });
    assert.equal(valid, true);
    assert.equal(fallbackCalls, 1, 'fallback should run exactly once after a WebCrypto exception');
  } finally {
    if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
  }
});
