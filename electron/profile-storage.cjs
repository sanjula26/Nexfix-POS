'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readProfileManifest } = require('./storage-profile.cjs');
const { encryptProfilePayload, decryptProfilePayload } = require('./profile-crypto.cjs');

const PROFILE_DATA_FILES = Object.freeze({
  app_state: 'app-state.nxf',
  sync_queue: 'sync-queue.nxf',
  meta: 'profile-meta.nxf',
  restore_checkpoint: 'restore-checkpoint.nxf',
  migration_journal: 'migration-journal.nxf',
});
const MAX_ENCRYPTED_FILE_BYTES = 350 * 1024 * 1024;

function assertPurpose(purpose) {
  if (!Object.prototype.hasOwnProperty.call(PROFILE_DATA_FILES, purpose)) {
    throw new Error('Unsupported POS profile storage purpose.');
  }
}

function parseEnvelopeFile(filePath, profileId, purpose) {
  const linkStat = fs.lstatSync(filePath);
  if (linkStat.isSymbolicLink()) throw new Error('Encrypted POS profile data cannot be a symbolic link.');
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ENCRYPTED_FILE_BYTES) {
    throw new Error('Encrypted POS profile data file is invalid or exceeds the size limit.');
  }
  let envelope;
  try { envelope = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { throw new Error('Encrypted POS profile data file is unreadable or invalid JSON.'); }
  if (!envelope || envelope.profileId !== profileId ||
      envelope.purpose !== purpose || !Number.isSafeInteger(envelope.revision) ||
      envelope.revision < 1) {
    throw new Error('Encrypted POS profile data identity or revision is invalid.');
  }
  return envelope;
}

class EncryptedProfileStorage {
  constructor(profileDirectory, profileId, dataKey) {
    if (typeof profileDirectory !== 'string' || !path.isAbsolute(profileDirectory)) {
      throw new Error('An absolute POS profile directory is required.');
    }
    const rootStat = fs.lstatSync(profileDirectory);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error('The POS profile directory must be a real folder.');
    }
    const manifest = readProfileManifest(profileDirectory);
    if (manifest.profileId !== String(profileId || '').toLowerCase()) {
      throw new Error('The selected POS profile does not match the active profile identity.');
    }
    if (!Buffer.isBuffer(dataKey) || dataKey.length !== 32) {
      throw new Error('A 256-bit POS profile data key is required.');
    }
    this.profileDirectory = fs.realpathSync(profileDirectory);
    this.profileId = manifest.profileId;
    this.dataKey = Buffer.from(dataKey);
  }

  read(purpose) {
    assertPurpose(purpose);
    const filePath = path.join(this.profileDirectory, PROFILE_DATA_FILES[purpose]);
    if (!fs.existsSync(filePath)) return null;
    const envelope = parseEnvelopeFile(filePath, this.profileId, purpose);
    const plaintext = decryptProfilePayload(this.dataKey, this.profileId, purpose, envelope);
    try { return plaintext.toString('utf8'); }
    finally { plaintext.fill(0); }
  }

  write(purpose, serializedPayload) {
    assertPurpose(purpose);
    if (typeof serializedPayload !== 'string') {
      throw new Error('POS profile data must be serialized to a string before encryption.');
    }
    const plaintext = Buffer.from(serializedPayload, 'utf8');
    if (plaintext.length > 256 * 1024 * 1024) {
      throw new Error('POS profile data exceeds the supported size limit.');
    }

    const destination = path.join(this.profileDirectory, PROFILE_DATA_FILES[purpose]);
    let revision = 1;
    if (fs.existsSync(destination)) {
      const existing = parseEnvelopeFile(destination, this.profileId, purpose);
      // Authenticate the existing payload before replacing it. Never overwrite
      // a corrupt or tampered file with a newer snapshot.
      const previousPlaintext = decryptProfilePayload(this.dataKey, this.profileId, purpose, existing);
      previousPlaintext.fill(0);
      revision = existing.revision + 1;
      if (!Number.isSafeInteger(revision)) throw new Error('POS profile data revision limit reached.');
    }

    const envelope = encryptProfilePayload(this.dataKey, this.profileId, purpose, revision, plaintext);
    const temporary = path.join(this.profileDirectory, '.' + PROFILE_DATA_FILES[purpose] + '.' + crypto.randomBytes(12).toString('hex') + '.tmp');
    let descriptor = null;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(envelope), 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporary, destination);
      const persistedEnvelope = parseEnvelopeFile(destination, this.profileId, purpose);
      const readBack = decryptProfilePayload(this.dataKey, this.profileId, purpose, persistedEnvelope);
      const matches = readBack.equals(plaintext);
      readBack.fill(0);
      if (!matches) throw new Error('Encrypted POS profile data failed read-back verification.');
      if (process.platform !== 'win32') {
        let directoryDescriptor = null;
        try {
          directoryDescriptor = fs.openSync(this.profileDirectory, 'r');
          fs.fsyncSync(directoryDescriptor);
        } finally {
          if (directoryDescriptor !== null) fs.closeSync(directoryDescriptor);
        }
      }
      return { ok: true, revision, bytes: plaintext.length };
    } catch (error) {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch { /* best effort */ }
      }
      try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
      throw error;
    } finally {
      plaintext.fill(0);
    }
  }

  remove(purpose) {
    assertPurpose(purpose);
    const filePath = path.join(this.profileDirectory, PROFILE_DATA_FILES[purpose]);
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('Refusing to remove an unexpected POS profile storage entry.');
    }
    fs.rmSync(filePath);
    return true;
  }

  destroy() {
    this.dataKey.fill(0);
  }
}

module.exports = { PROFILE_DATA_FILES, EncryptedProfileStorage };
