'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  PROFILE_CRYPTO_FORMAT,
  PROFILE_CRYPTO_VERSION,
  createProfileKeyMaterial,
  wrapDataKeyWithPassphrase,
  unwrapDataKeyWithPassphrase,
  unwrapDataKeyWithRecoveryKey,
} = require('./profile-crypto.cjs');

const KEY_ENVELOPE_FILE = 'nexfix-key-envelope.json';
const KEY_ENVELOPE_FORMAT = 'nexfix-pos-key-envelope';
const KEY_ENVELOPE_VERSION = 1;
const MAX_KEY_ENVELOPE_BYTES = 64 * 1024;
const PROFILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isCanonicalBase64(value, minBytes = 1) {
  if (typeof value !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length >= minBytes && decoded.toString('base64') === value;
}

function validateWrappedKey(value, expectedProvider, profileId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.format !== PROFILE_CRYPTO_FORMAT ||
      value.version !== PROFILE_CRYPTO_VERSION ||
      value.profileId !== profileId ||
      value.provider !== expectedProvider) return false;
  if (expectedProvider === 'electron-safeStorage') {
    const keys = Object.keys(value);
    return keys.every(key => ['format', 'version', 'provider', 'profileId', 'ciphertext'].includes(key)) &&
      isCanonicalBase64(value.ciphertext, 16);
  }
  if (expectedProvider === 'scrypt-passphrase') {
    const keys = Object.keys(value);
    return keys.every(key => ['format', 'version', 'provider', 'profileId', 'kdf', 'salt', 'iv', 'ciphertext', 'tag'].includes(key)) &&
      value.kdf?.name === 'scrypt' && value.kdf.N === 32768 && value.kdf.r === 8 && value.kdf.p === 3 &&
      isCanonicalBase64(value.salt, 16) && Buffer.from(value.salt, 'base64').length === 16 &&
      isCanonicalBase64(value.iv, 12) && Buffer.from(value.iv, 'base64').length === 12 &&
      isCanonicalBase64(value.ciphertext, 32) && Buffer.from(value.ciphertext, 'base64').length === 32 &&
      isCanonicalBase64(value.tag, 16) && Buffer.from(value.tag, 'base64').length === 16;
  }
  return false;
}

function validateProfileKeyEnvelope(value, expectedProfileId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.format !== KEY_ENVELOPE_FORMAT ||
      value.version !== KEY_ENVELOPE_VERSION ||
      typeof value.profileId !== 'string' ||
      !PROFILE_ID_PATTERN.test(value.profileId) ||
      value.profileId !== value.profileId.toLowerCase() ||
      (expectedProfileId && value.profileId !== expectedProfileId.toLowerCase())) {
    return { valid: false, reason: 'POS profile key envelope identity or version is invalid.' };
  }
  const allowed = new Set(['format', 'version', 'profileId', 'osWrappedKey', 'recoveryWrappedKey', 'passphraseWrappedKey', 'updatedAt']);
  if (Object.keys(value).some(key => !allowed.has(key))) {
    return { valid: false, reason: 'POS profile key envelope contains unsupported fields.' };
  }
  if (!validateWrappedKey(value.osWrappedKey, 'electron-safeStorage', value.profileId)) {
    return { valid: false, reason: 'OS-protected profile key wrapper is invalid.' };
  }
  const recovery = value.recoveryWrappedKey;
  const recoveryKeys = new Set(['format', 'version', 'algorithm', 'profileId', 'iv', 'ciphertext', 'tag']);
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery) ||
      Object.keys(recovery).some(key => !recoveryKeys.has(key)) ||
      recovery.format !== PROFILE_CRYPTO_FORMAT ||
      recovery.version !== PROFILE_CRYPTO_VERSION || recovery.algorithm !== 'AES-256-GCM' ||
      recovery.profileId !== value.profileId ||
      !isCanonicalBase64(recovery.iv, 12) || Buffer.from(recovery.iv, 'base64').length !== 12 ||
      !isCanonicalBase64(recovery.ciphertext, 32) || Buffer.from(recovery.ciphertext, 'base64').length !== 32 ||
      !isCanonicalBase64(recovery.tag, 16) || Buffer.from(recovery.tag, 'base64').length !== 16) {
    return { valid: false, reason: 'Portable recovery-key wrapper is invalid.' };
  }
  if (value.passphraseWrappedKey !== undefined &&
      !validateWrappedKey(value.passphraseWrappedKey, 'scrypt-passphrase', value.profileId)) {
    return { valid: false, reason: 'Folder-lock passphrase wrapper is invalid.' };
  }
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) ||
      new Date(value.updatedAt).toISOString() !== value.updatedAt) {
    return { valid: false, reason: 'POS profile key envelope timestamp is invalid.' };
  }
  return { valid: true, envelope: value };
}

async function createInitialProfileKeyEnvelope(profileId, safeStorage, passphrase) {
  const material = await createProfileKeyMaterial(profileId, safeStorage);
  try {
    const passphraseWrappedKey = await wrapDataKeyWithPassphrase(material.dataKey, passphrase, profileId);
    const envelope = {
      format: KEY_ENVELOPE_FORMAT,
      version: KEY_ENVELOPE_VERSION,
      profileId: profileId.toLowerCase(),
      osWrappedKey: material.envelope.osWrappedKey,
      recoveryWrappedKey: material.envelope.recoveryWrappedKey,
      passphraseWrappedKey,
      updatedAt: new Date().toISOString(),
    };
    const checked = validateProfileKeyEnvelope(envelope, profileId);
    if (!checked.valid) throw new Error(checked.reason);
    return { envelope, recoveryKey: material.recoveryKey };
  } finally {
    material.dataKey.fill(0);
  }
}

function persistNewProfileKeyEnvelope(profileDirectory, envelope) {
  if (typeof profileDirectory !== 'string' || !path.isAbsolute(profileDirectory)) {
    throw new Error('An absolute POS profile directory is required.');
  }
  const directoryStat = fs.lstatSync(profileDirectory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error('The POS profile directory must be a real folder.');
  }
  const checked = validateProfileKeyEnvelope(envelope);
  if (!checked.valid) throw new Error(checked.reason);

  const destination = path.join(profileDirectory, KEY_ENVELOPE_FILE);
  let descriptor = null;
  let created = false;
  try {
    // Exclusive creation works on NTFS and removable local filesystems that
    // do not support hard links. It never overwrites an existing key envelope.
    descriptor = fs.openSync(destination, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, JSON.stringify(checked.envelope, null, 2) + '\n', 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    return readProfileKeyEnvelope(profileDirectory, envelope.profileId);
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* best effort */ }
    }
    // Remove only the incomplete file created by this invocation. If the
    // process crashes, a partial envelope is rejected at next startup.
    if (created) {
      try { fs.rmSync(destination, { force: true }); } catch { /* fail closed */ }
    }
    throw error;
  }
}

function readProfileKeyEnvelope(profileDirectory, expectedProfileId) {
  const file = path.join(profileDirectory, KEY_ENVELOPE_FILE);
  const linkStat = fs.lstatSync(file);
  if (linkStat.isSymbolicLink()) throw new Error('POS profile key envelope cannot be a symbolic link.');
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_KEY_ENVELOPE_BYTES) {
    throw new Error('POS profile key envelope is not a valid bounded file.');
  }
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('POS profile key envelope is unreadable or invalid JSON.'); }
  const checked = validateProfileKeyEnvelope(parsed, expectedProfileId);
  if (!checked.valid) throw new Error(checked.reason);
  return checked.envelope;
}


function replaceProfileKeyEnvelope(profileDirectory, currentEnvelope, nextEnvelope) {
  const destination = path.join(profileDirectory, KEY_ENVELOPE_FILE);
  const stat = fs.lstatSync(destination);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('POS profile key envelope must be a regular file.');
  }
  const currentRaw = fs.readFileSync(destination);
  const currentHash = crypto.createHash('sha256').update(currentRaw).digest('hex');
  const currentCheck = validateProfileKeyEnvelope(JSON.parse(currentRaw.toString('utf8')), currentEnvelope.profileId);
  if (!currentCheck.valid ||
      JSON.stringify(currentCheck.envelope) !== JSON.stringify(currentEnvelope)) {
    throw new Error('POS profile key envelope changed before the lock update. Reload it and try again.');
  }

  const checked = validateProfileKeyEnvelope(nextEnvelope, currentEnvelope.profileId);
  if (!checked.valid) throw new Error(checked.reason);
  const temporary = path.join(profileDirectory, '.' + KEY_ENVELOPE_FILE + '.' + crypto.randomBytes(12).toString('hex') + '.tmp');
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(checked.envelope, null, 2) + '\\n', 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;

    const currentAgain = fs.readFileSync(destination);
    const currentAgainHash = crypto.createHash('sha256').update(currentAgain).digest('hex');
    if (currentAgainHash !== currentHash) {
      throw new Error('POS profile key envelope changed during the lock update. No update was applied.');
    }
    fs.renameSync(temporary, destination);
    return readProfileKeyEnvelope(profileDirectory, currentEnvelope.profileId);
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* best effort */ }
    }
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

async function changeProfileLockPassphrase(profileDirectory, profileId, currentPassphrase, nextPassphrase) {
  const current = readProfileKeyEnvelope(profileDirectory, profileId);
  if (!current.passphraseWrappedKey) throw new Error('This POS profile does not have a folder-lock passphrase.');
  const dataKey = await unwrapDataKeyWithPassphrase(current.passphraseWrappedKey, currentPassphrase, profileId);
  try {
    const nextEnvelope = {
      ...current,
      passphraseWrappedKey: await wrapDataKeyWithPassphrase(dataKey, nextPassphrase, profileId),
      updatedAt: new Date().toISOString(),
    };
    const saved = replaceProfileKeyEnvelope(profileDirectory, current, nextEnvelope);
    const verificationKey = await unwrapDataKeyWithPassphrase(saved.passphraseWrappedKey, nextPassphrase, profileId);
    const valid = verificationKey.equals(dataKey);
    verificationKey.fill(0);
    if (!valid) throw new Error('Changed POS folder-lock passphrase failed verification.');
    return saved;
  } finally {
    dataKey.fill(0);
  }
}

async function resetProfileLockPassphraseWithRecoveryKey(profileDirectory, profileId, recoveryKey, nextPassphrase) {
  const current = readProfileKeyEnvelope(profileDirectory, profileId);
  const dataKey = unwrapDataKeyWithRecoveryKey(current.recoveryWrappedKey, recoveryKey, profileId);
  try {
    const nextEnvelope = {
      ...current,
      passphraseWrappedKey: await wrapDataKeyWithPassphrase(dataKey, nextPassphrase, profileId),
      updatedAt: new Date().toISOString(),
    };
    const saved = replaceProfileKeyEnvelope(profileDirectory, current, nextEnvelope);
    const verificationKey = await unwrapDataKeyWithPassphrase(saved.passphraseWrappedKey, nextPassphrase, profileId);
    const valid = verificationKey.equals(dataKey);
    verificationKey.fill(0);
    if (!valid) throw new Error('Recovered POS folder-lock passphrase failed verification.');
    return saved;
  } finally {
    dataKey.fill(0);
  }
}

module.exports = {
  KEY_ENVELOPE_FILE,
  KEY_ENVELOPE_FORMAT,
  KEY_ENVELOPE_VERSION,
  validateProfileKeyEnvelope,
  createInitialProfileKeyEnvelope,
  persistNewProfileKeyEnvelope,
  readProfileKeyEnvelope,
  changeProfileLockPassphrase,
  resetProfileLockPassphraseWithRecoveryKey,
};
