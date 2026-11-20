'use strict';

const crypto = require('node:crypto');

const PROFILE_CRYPTO_FORMAT = 'nexfix-pos-profile-crypto';
const PROFILE_CRYPTO_VERSION = 1;
const DATA_KEY_BYTES = 32;
const RECOVERY_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
const PURPOSE_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

function assertProfileId(profileId) {
  if (typeof profileId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profileId)) {
    throw new Error('A valid Nexfix profile ID is required.');
  }
}

function assertKey(key, label = 'Data encryption key') {
  if (!Buffer.isBuffer(key) || key.length !== DATA_KEY_BYTES) {
    throw new Error(label + ' must be exactly 32 bytes.');
  }
}

function assertRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('Profile data revision must be a non-negative safe integer.');
  }
}

function encodeBase64Url(buffer) {
  return buffer.toString('base64url');
}

function decodeBase64(value, label) {
  if (typeof value !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(label + ' is not valid canonical base64 data.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error(label + ' is not valid canonical base64 data.');
  }
  return decoded;
}

function decodeBase64Url(value, expectedBytes, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(label + ' is not valid base64url data.');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== expectedBytes || encodeBase64Url(decoded) !== value) {
    throw new Error(label + ' has an invalid length or encoding.');
  }
  return decoded;
}

function createRecoveryKey() {
  return encodeBase64Url(crypto.randomBytes(RECOVERY_KEY_BYTES));
}

function parseRecoveryKey(value) {
  return decodeBase64Url(value, RECOVERY_KEY_BYTES, 'POS data recovery key');
}

function buildAad(profileId, purpose, revision) {
  assertProfileId(profileId);
  if (typeof purpose !== 'string' || !PURPOSE_PATTERN.test(purpose)) {
    throw new Error('Profile data purpose is invalid.');
  }
  assertRevision(revision);
  return Buffer.from(
    PROFILE_CRYPTO_FORMAT + ':' + PROFILE_CRYPTO_VERSION + ':' +
    profileId.toLowerCase() + ':' + purpose + ':' + revision,
    'utf8',
  );
}

function encryptWithKey(key, plaintext, aad) {
  assertKey(key);
  if (!Buffer.isBuffer(plaintext) && typeof plaintext !== 'string') {
    throw new Error('Profile data payload must be a Buffer or an explicitly serialized string.');
  }
  const input = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  if (input.length > MAX_PAYLOAD_BYTES) throw new Error('Profile data payload exceeds the supported size limit.');
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: tag.toString('base64'),
  };
}

function decryptWithKey(key, envelope, aad) {
  assertKey(key);
  if (!envelope || typeof envelope !== 'object') throw new Error('Encrypted profile data is missing.');
  const iv = decodeBase64(envelope.iv, 'Profile data nonce');
  const ciphertext = decodeBase64(envelope.ciphertext, 'Profile ciphertext');
  const tag = decodeBase64(envelope.tag, 'Profile authentication tag');
  if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES ||
      ciphertext.length > MAX_PAYLOAD_BYTES) {
    throw new Error('Encrypted profile data has an invalid size or format.');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('Profile data authentication failed. The key is wrong or the data was changed.');
  }
}

function encryptProfilePayload(dataKey, profileId, purpose, revision, plaintext) {
  const aad = buildAad(profileId, purpose, revision);
  return {
    format: PROFILE_CRYPTO_FORMAT,
    version: PROFILE_CRYPTO_VERSION,
    algorithm: 'AES-256-GCM',
    profileId: profileId.toLowerCase(),
    purpose,
    revision,
    ...encryptWithKey(dataKey, plaintext, aad),
  };
}

function decryptProfilePayload(dataKey, expectedProfileId, expectedPurpose, envelope) {
  if (!envelope || envelope.format !== PROFILE_CRYPTO_FORMAT ||
      envelope.version !== PROFILE_CRYPTO_VERSION || envelope.algorithm !== 'AES-256-GCM') {
    throw new Error('Encrypted profile data version or algorithm is not supported.');
  }
  assertProfileId(expectedProfileId);
  if (envelope.profileId !== expectedProfileId.toLowerCase() ||
      envelope.purpose !== expectedPurpose) {
    throw new Error('Encrypted profile data belongs to a different profile or data purpose.');
  }
  const aad = buildAad(envelope.profileId, envelope.purpose, envelope.revision);
  return decryptWithKey(dataKey, envelope, aad);
}

function wrapDataKeyWithRecoveryKey(dataKey, recoveryKey, profileId) {
  assertKey(dataKey);
  assertProfileId(profileId);
  const key = Buffer.isBuffer(recoveryKey) ? recoveryKey : parseRecoveryKey(recoveryKey);
  if (key.length !== RECOVERY_KEY_BYTES) throw new Error('POS data recovery key must be exactly 32 bytes.');
  const aad = Buffer.from(PROFILE_CRYPTO_FORMAT + ':recovery-wrap:' + profileId.toLowerCase(), 'utf8');
  return {
    format: PROFILE_CRYPTO_FORMAT,
    version: PROFILE_CRYPTO_VERSION,
    algorithm: 'AES-256-GCM',
    profileId: profileId.toLowerCase(),
    ...encryptWithKey(key, dataKey, aad),
  };
}

function unwrapDataKeyWithRecoveryKey(envelope, recoveryKey, expectedProfileId) {
  assertProfileId(expectedProfileId);
  if (!envelope || envelope.format !== PROFILE_CRYPTO_FORMAT ||
      envelope.version !== PROFILE_CRYPTO_VERSION || envelope.algorithm !== 'AES-256-GCM' ||
      envelope.profileId !== expectedProfileId.toLowerCase()) {
    throw new Error('POS data recovery envelope does not match this profile or is unsupported.');
  }
  const key = Buffer.isBuffer(recoveryKey) ? recoveryKey : parseRecoveryKey(recoveryKey);
  if (key.length !== RECOVERY_KEY_BYTES) throw new Error('POS data recovery key must be exactly 32 bytes.');
  const aad = Buffer.from(PROFILE_CRYPTO_FORMAT + ':recovery-wrap:' + expectedProfileId.toLowerCase(), 'utf8');
  const dataKey = decryptWithKey(key, envelope, aad);
  assertKey(dataKey);
  return dataKey;
}

function getSafeStorageBackend(safeStorage) {
  try {
    return typeof safeStorage?.getSelectedStorageBackend === 'function'
      ? safeStorage.getSelectedStorageBackend()
      : '';
  } catch {
    return '';
  }
}

async function safeStorageEncrypt(safeStorage, plaintext) {
  if (!safeStorage) throw new Error('Windows secure storage is unavailable.');
  const backend = getSafeStorageBackend(safeStorage);
  if (backend === 'basic_text') throw new Error('OS secure storage is using an unsafe plaintext fallback.');
  if (typeof safeStorage.isAsyncEncryptionAvailable === 'function' &&
      typeof safeStorage.encryptStringAsync === 'function') {
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('OS secure storage is not ready.');
    return safeStorage.encryptStringAsync(plaintext);
  }
  if (typeof safeStorage.isEncryptionAvailable === 'function' &&
      typeof safeStorage.encryptString === 'function' && safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plaintext);
  }
  throw new Error('OS secure storage is unavailable; profile encryption was stopped.');
}

async function safeStorageDecrypt(safeStorage, ciphertext) {
  if (!safeStorage) throw new Error('Windows secure storage is unavailable.');
  const backend = getSafeStorageBackend(safeStorage);
  if (backend === 'basic_text') throw new Error('OS secure storage is using an unsafe plaintext fallback.');
  if (typeof safeStorage.isAsyncEncryptionAvailable === 'function' &&
      typeof safeStorage.decryptStringAsync === 'function') {
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('OS secure storage is not ready.');
    const result = await safeStorage.decryptStringAsync(ciphertext);
    if (!result || typeof result.result !== 'string') throw new Error('OS secure storage returned invalid key data.');
    return result.result;
  }
  if (typeof safeStorage.isEncryptionAvailable === 'function' &&
      typeof safeStorage.decryptString === 'function' && safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(ciphertext);
  }
  throw new Error('OS secure storage is unavailable; profile decryption was stopped.');
}

async function wrapDataKeyWithOS(dataKey, profileId, safeStorage) {
  assertKey(dataKey);
  assertProfileId(profileId);
  const payload = JSON.stringify({
    format: PROFILE_CRYPTO_FORMAT,
    version: PROFILE_CRYPTO_VERSION,
    profileId: profileId.toLowerCase(),
    dataKey: encodeBase64Url(dataKey),
  });
  const encrypted = await safeStorageEncrypt(safeStorage, payload);
  if (!Buffer.isBuffer(encrypted) || encrypted.length < 16) {
    throw new Error('OS secure storage returned an invalid encrypted key.');
  }
  return {
    format: PROFILE_CRYPTO_FORMAT,
    version: PROFILE_CRYPTO_VERSION,
    provider: 'electron-safeStorage',
    profileId: profileId.toLowerCase(),
    ciphertext: encrypted.toString('base64'),
  };
}

async function unwrapDataKeyWithOS(envelope, expectedProfileId, safeStorage) {
  assertProfileId(expectedProfileId);
  if (!envelope || envelope.format !== PROFILE_CRYPTO_FORMAT ||
      envelope.version !== PROFILE_CRYPTO_VERSION ||
      envelope.provider !== 'electron-safeStorage' ||
      envelope.profileId !== expectedProfileId.toLowerCase() ||
      typeof envelope.ciphertext !== 'string') {
    throw new Error('OS-protected profile key envelope is invalid or belongs to another profile.');
  }
  const encrypted = decodeBase64(envelope.ciphertext, 'OS-protected profile key');
  if (encrypted.length < 16) throw new Error('OS-protected profile key is truncated.');
  let payload;
  try {
    payload = JSON.parse(await safeStorageDecrypt(safeStorage, encrypted));
  } catch {
    throw new Error('This Windows account cannot unlock the profile key. Use the POS data recovery key.');
  }
  if (!payload || payload.format !== PROFILE_CRYPTO_FORMAT ||
      payload.version !== PROFILE_CRYPTO_VERSION ||
      payload.profileId !== expectedProfileId.toLowerCase()) {
    throw new Error('OS-protected profile key payload does not match this profile.');
  }
  return decodeBase64Url(payload.dataKey, DATA_KEY_BYTES, 'OS-protected profile data key');
}

async function createProfileKeyMaterial(profileId, safeStorage) {
  assertProfileId(profileId);
  const dataKey = crypto.randomBytes(DATA_KEY_BYTES);
  const recoveryKey = createRecoveryKey();
  try {
    const [osWrappedKey, recoveryWrappedKey] = await Promise.all([
      wrapDataKeyWithOS(dataKey, profileId, safeStorage),
      Promise.resolve(wrapDataKeyWithRecoveryKey(dataKey, recoveryKey, profileId)),
    ]);
    return {
      dataKey,
      recoveryKey,
      envelope: {
        format: PROFILE_CRYPTO_FORMAT,
        version: PROFILE_CRYPTO_VERSION,
        profileId: profileId.toLowerCase(),
        osWrappedKey,
        recoveryWrappedKey,
      },
    };
  } catch (error) {
    dataKey.fill(0);
    throw error;
  }
}

module.exports = {
  PROFILE_CRYPTO_FORMAT,
  PROFILE_CRYPTO_VERSION,
  DATA_KEY_BYTES,
  RECOVERY_KEY_BYTES,
  createRecoveryKey,
  parseRecoveryKey,
  encryptProfilePayload,
  decryptProfilePayload,
  wrapDataKeyWithRecoveryKey,
  unwrapDataKeyWithRecoveryKey,
  wrapDataKeyWithOS,
  unwrapDataKeyWithOS,
  createProfileKeyMaterial,
};
