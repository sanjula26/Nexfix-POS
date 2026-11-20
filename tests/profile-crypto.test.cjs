'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  createRecoveryKey,
  parseRecoveryKey,
  encryptProfilePayload,
  decryptProfilePayload,
  wrapDataKeyWithRecoveryKey,
  unwrapDataKeyWithRecoveryKey,
  wrapDataKeyWithOS,
  unwrapDataKeyWithOS,
  createProfileKeyMaterial,
} = require('../electron/profile-crypto.cjs');

const PROFILE_A = '123e4567-e89b-42d3-a456-426614174000';
const PROFILE_B = '123e4567-e89b-42d3-a456-426614174001';

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from('wrapped:' + value, 'utf8'),
    decryptString: value => Buffer.from(value).toString('utf8').replace(/^wrapped:/, ''),
  };
}

test('profile payload is encrypted with AES-256-GCM and round-trips without plaintext in the envelope', () => {
  const dataKey = crypto.randomBytes(32);
  const plaintext = Buffer.from(JSON.stringify({ sales: [{ id: 'private-sale' }], customers: [] }));
  const envelope = encryptProfilePayload(dataKey, PROFILE_A, 'pos-state', 7, plaintext);
  assert.equal(envelope.algorithm, 'AES-256-GCM');
  assert.notEqual(envelope.ciphertext, plaintext.toString('base64'));
  assert.equal(JSON.stringify(envelope).includes('private-sale'), false);
  assert.deepEqual(decryptProfilePayload(dataKey, PROFILE_A, 'pos-state', envelope), plaintext);
});

test('profile payload authentication rejects ciphertext, tag, IV and metadata tampering', () => {
  const dataKey = crypto.randomBytes(32);
  const envelope = encryptProfilePayload(dataKey, PROFILE_A, 'pos-state', 8, Buffer.from('shop data'));
  const changedCiphertext = { ...envelope, ciphertext: Buffer.from('changed data').toString('base64') };
  const changedTag = { ...envelope, tag: Buffer.alloc(16).toString('base64') };
  const changedIv = { ...envelope, iv: crypto.randomBytes(12).toString('base64') };
  for (const tampered of [changedCiphertext, changedTag, changedIv]) {
    assert.throws(() => decryptProfilePayload(dataKey, PROFILE_A, 'pos-state', tampered), /authentication failed/);
  }
  assert.throws(() => decryptProfilePayload(dataKey, PROFILE_A, 'pos-state', { ...envelope, revision: 9 }), /authentication failed/);
});

test('profile payload rejects non-canonical base64 encodings before decrypting', () => {
  const dataKey = crypto.randomBytes(32);
  const envelope = encryptProfilePayload(dataKey, PROFILE_A, 'pos-state', 1, Buffer.from('shop data'));
  assert.throws(
    () => decryptProfilePayload(dataKey, PROFILE_A, 'pos-state', { ...envelope, ciphertext: '!!!!' + envelope.ciphertext }),
    /canonical base64/,
  );
});

test('profile payload cannot be replayed across profile IDs or data purposes', () => {
  const dataKey = crypto.randomBytes(32);
  const envelope = encryptProfilePayload(dataKey, PROFILE_A, 'pos-state', 1, Buffer.from('shop data'));
  assert.throws(() => decryptProfilePayload(dataKey, PROFILE_B, 'pos-state', envelope), /different profile/);
  assert.throws(() => decryptProfilePayload(dataKey, PROFILE_A, 'sync-queue', envelope), /different profile/);
});

test('profile payload refuses invalid key sizes, revisions, purposes and oversized data', () => {
  assert.throws(() => encryptProfilePayload(Buffer.alloc(16), PROFILE_A, 'pos-state', 1, 'data'), /32 bytes/);
  assert.throws(() => encryptProfilePayload(Buffer.alloc(32), PROFILE_A, 'pos-state', -1, 'data'), /revision/);
  assert.throws(() => encryptProfilePayload(Buffer.alloc(32), PROFILE_A, '../unsafe', 1, 'data'), /purpose/);
});

test('profile encryption rejects objects that were not explicitly serialized', () => {
  assert.throws(
    () => encryptProfilePayload(crypto.randomBytes(32), PROFILE_A, 'pos-state', 1, { sales: [] }),
    /Buffer or an explicitly serialized string/,
  );
});

test('POS data recovery key is random, 256-bit and strictly validated', () => {
  const first = createRecoveryKey();
  const second = createRecoveryKey();
  assert.equal(parseRecoveryKey(first).length, 32);
  assert.notEqual(first, second);
  assert.throws(() => parseRecoveryKey('weak-password'), /invalid length or encoding/);
});

test('recovery-wrapped data key unlocks on a replacement Windows profile', () => {
  const dataKey = crypto.randomBytes(32);
  const recoveryKey = createRecoveryKey();
  const envelope = wrapDataKeyWithRecoveryKey(dataKey, recoveryKey, PROFILE_A);
  assert.deepEqual(unwrapDataKeyWithRecoveryKey(envelope, recoveryKey, PROFILE_A), dataKey);
  assert.throws(() => unwrapDataKeyWithRecoveryKey(envelope, createRecoveryKey(), PROFILE_A), /authentication failed/);
  assert.throws(() => unwrapDataKeyWithRecoveryKey(envelope, recoveryKey, PROFILE_B), /does not match/);
});

test('OS-protected key envelope round-trips and never stores the raw data key', async () => {
  const dataKey = crypto.randomBytes(32);
  const safeStorage = fakeSafeStorage();
  const envelope = await wrapDataKeyWithOS(dataKey, PROFILE_A, safeStorage);
  assert.equal(JSON.stringify(envelope).includes(dataKey.toString('base64url')), false);
  assert.deepEqual(await unwrapDataKeyWithOS(envelope, PROFILE_A, safeStorage), dataKey);
});

test('OS secure storage fails closed when unavailable or configured for plaintext fallback', async () => {
  await assert.rejects(
    () => wrapDataKeyWithOS(crypto.randomBytes(32), PROFILE_A, { isEncryptionAvailable: () => false }),
    /unavailable/,
  );
  await assert.rejects(
    () => wrapDataKeyWithOS(crypto.randomBytes(32), PROFILE_A, {
      getSelectedStorageBackend: () => 'basic_text',
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value),
    }),
    /plaintext fallback/,
  );
});

test('async Electron safeStorage API is supported and its result is checked', async () => {
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async value => Buffer.from('async:' + value),
    decryptStringAsync: async value => ({ result: Buffer.from(value).toString().replace(/^async:/, ''), shouldReEncrypt: false }),
  };
  const dataKey = crypto.randomBytes(32);
  const envelope = await wrapDataKeyWithOS(dataKey, PROFILE_A, safeStorage);
  assert.deepEqual(await unwrapDataKeyWithOS(envelope, PROFILE_A, safeStorage), dataKey);
});

test('new profile key material has independent OS and recovery wrappers', async () => {
  const material = await createProfileKeyMaterial(PROFILE_A, fakeSafeStorage());
  assert.equal(material.dataKey.length, 32);
  assert.equal(parseRecoveryKey(material.recoveryKey).length, 32);
  assert.notEqual(material.envelope.osWrappedKey.ciphertext, material.envelope.recoveryWrappedKey.ciphertext);
  assert.deepEqual(unwrapDataKeyWithRecoveryKey(material.envelope.recoveryWrappedKey, material.recoveryKey, PROFILE_A), material.dataKey);
  assert.deepEqual(await unwrapDataKeyWithOS(material.envelope.osWrappedKey, PROFILE_A, fakeSafeStorage()), material.dataKey);
});
