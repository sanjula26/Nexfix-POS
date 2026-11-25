'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createManagedProfileDirectory, createProfileManifest, readProfileManifest, classifyProfileCandidates } = require('./storage-profile.cjs');
const {
  createInitialProfileKeyEnvelope,
  persistNewProfileKeyEnvelope,
  readProfileKeyEnvelope,
  changeProfileLockPassphrase,
  resetProfileLockPassphraseWithRecoveryKey,
  rebindProfileDeviceKeyWithRecoveryKey,
  rebindProfileDeviceKeyWithPassphrase,
  prepareProfileRecoveryKeyRotation,
  finalizeProfileRecoveryKeyRotation,
} = require('./profile-key-store.cjs');
const { unwrapDataKeyWithOS, unwrapDataKeyWithPassphrase, unwrapDataKeyWithRecoveryKey, validateLockPassphrase } = require('./profile-crypto.cjs');
const { EncryptedProfileStorage } = require('./profile-storage.cjs');
const { applyWindowsProfileAcl, isValidWindowsSid } = require('./profile-acl.cjs');

const execFileAsync = promisify(execFile);
const MAX_DISCOVERY_ENTRIES = 500;

async function resolveCurrentWindowsUserSid() {
  const result = await execFileAsync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 16 * 1024,
    shell: false,
  });
  const match = String(result.stdout || '').match(/"(S-1-(?:\d+-){1,14}\d+)"/i);
  const sid = match?.[1] || '';
  if (!isValidWindowsSid(sid)) throw new Error('Could not safely identify the current Windows user SID.');
  return sid;
}

function resolveStorageRoot(rootDirectory) {
  if (typeof rootDirectory !== 'string' || !rootDirectory.trim() || !path.isAbsolute(rootDirectory)) {
    throw new Error('Select an absolute local folder for POS storage.');
  }
  if (/^(?:\\\\\\?\\UNC\\|\\\\[^\\]+\\[^\\]+)/i.test(rootDirectory)) {
    throw new Error('Network folders are not supported for POS profile storage.');
  }
  const link = fs.lstatSync(rootDirectory);
  if (link.isSymbolicLink() || !link.isDirectory()) throw new Error('The selected POS storage location must be a real folder.');
  return fs.realpathSync(rootDirectory);
}

class POSProfileSession {
  constructor(options = {}) {
    this.safeStorage = options.safeStorage;
    this.platform = options.platform || process.platform;
    this.resolveUserSid = options.resolveUserSid || resolveCurrentWindowsUserSid;
    this.applyAcl = options.applyAcl || applyWindowsProfileAcl;
    this.active = null;
    this.pendingCreation = null;
    this.pendingRecoveryKeyRotation = null;
  }

  assertSafeStorage() {
    if (!this.safeStorage || typeof this.safeStorage.isEncryptionAvailable !== 'function' ||
        !this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows secure storage is unavailable. POS profile encryption cannot be initialized.');
    }
  }

  async secureDirectory(directory) {
    if (this.platform !== 'win32') return { secured: false, reason: 'Windows NTFS ACL is not available on this platform.' };
    const sid = await this.resolveUserSid();
    if (!isValidWindowsSid(sid)) throw new Error('The current Windows user SID is invalid.');
    return this.applyAcl(directory, sid, { platform: this.platform });
  }

  discover(storageRoot) {
    const root = resolveStorageRoot(storageRoot);
    const candidates = [];
    const rootManifest = path.join(root, 'nexfix-profile.json');
    if (fs.existsSync(rootManifest)) {
      try { candidates.push({ path: root, manifest: readProfileManifest(root) }); }
      catch (error) { candidates.push({ path: root, manifest: null, reason: error.message }); }
    } else {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      if (entries.length > MAX_DISCOVERY_ENTRIES) {
        throw new Error('This storage folder contains too many entries to scan safely. Select a narrower folder.');
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const directory = path.join(root, entry.name);
        try { candidates.push({ path: fs.realpathSync(directory), manifest: readProfileManifest(directory) }); }
        catch (error) {
          if (fs.existsSync(path.join(directory, 'nexfix-profile.json'))) {
            candidates.push({ path: directory, manifest: null, reason: error.message });
          }
        }
      }
    }
    const classified = classifyProfileCandidates(candidates);
    return {
      root,
      available: classified.available.map(item => ({
        directory: item.path,
        profileId: item.manifest.profileId,
        label: item.manifest.label,
        createdAt: item.manifest.createdAt,
        updatedAt: item.manifest.updatedAt,
        status: item.status,
      })),
      duplicates: classified.duplicates.map(group => ({
        profileId: group.profileId,
        status: group.status,
        copies: group.copies.map(copy => ({ directory: copy.path, label: copy.manifest.label })),
      })),
      invalid: classified.invalid.map(item => ({ directory: item.path, status: item.status, reason: item.reason })),
    };
  }

  async create({ storageRoot, directoryName, label, passphrase }) {
    if (this.active) throw new Error('Lock the currently open POS profile before creating another profile.');
    this.assertSafeStorage();
    validateLockPassphrase(passphrase);
    const profileId = crypto.randomUUID();
    const safeStorageRoot = resolveStorageRoot(storageRoot);
    const created = createManagedProfileDirectory(safeStorageRoot, directoryName, {
      profileId,
      label,
      dataSchemaVersion: 1,
    });
    let recoveryKey = '';
    let dataKey = null;
    try {
      const keyMaterial = await createInitialProfileKeyEnvelope(profileId, this.safeStorage, passphrase);
      recoveryKey = keyMaterial.recoveryKey;
      persistNewProfileKeyEnvelope(created.directory, keyMaterial.envelope);
      const envelope = readProfileKeyEnvelope(created.directory, profileId);
      dataKey = await unwrapDataKeyWithPassphrase(envelope.passphraseWrappedKey, passphrase, profileId);
      await this.secureDirectory(created.directory);
      const storage = new EncryptedProfileStorage(created.directory, profileId, dataKey);
      dataKey.fill(0);
      dataKey = null;
      this.active = {
        directory: created.directory,
        profileId,
        label: created.manifest.label,
        storage,
      };
      return {
        ok: true,
        profile: { directory: created.directory, profileId, label: created.manifest.label },
        recoveryKey,
      };
    } catch (error) {
      if (dataKey) dataKey.fill(0);
      recoveryKey = '';
      throw error;
    }
  }

  async prepareCreate({ storageRoot, directoryName, label, passphrase }) {
    if (this.active) throw new Error('Lock the currently open POS profile before creating another profile.');
    if (this.pendingCreation) throw new Error('Finish or restart the pending POS profile recovery-key acknowledgement first.');
    this.assertSafeStorage();
    validateLockPassphrase(passphrase);
    if (typeof directoryName !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(directoryName) ||
        directoryName === '.' || directoryName === '..') {
      throw new Error('The POS profile folder name contains unsupported characters.');
    }
    const safeStorageRoot = resolveStorageRoot(storageRoot);
    const profileId = crypto.randomUUID();
    const manifest = createProfileManifest({ profileId, label, dataSchemaVersion: 1 });
    const directory = path.join(safeStorageRoot, directoryName);
    if (fs.existsSync(directory)) {
      throw new Error('A folder with this POS profile name already exists. Choose or reconnect the correct profile folder.');
    }
    const keyMaterial = await createInitialProfileKeyEnvelope(profileId, this.safeStorage, passphrase);
    const pendingId = crypto.randomBytes(32).toString('base64url');
    this.pendingCreation = {
      pendingId,
      storageRoot: safeStorageRoot,
      directoryName,
      profileId,
      manifest,
      envelope: keyMaterial.envelope,
      recoveryKey: keyMaterial.recoveryKey,
    };
    return {
      ok: true,
      pendingId,
      profile: { directory, profileId, label: manifest.label },
      recoveryKey: keyMaterial.recoveryKey,
    };
  }

  discardPendingCreation() {
    if (this.pendingCreation) this.pendingCreation.recoveryKey = '';
    this.pendingCreation = null;
    return { ok: true };
  }

  getPendingCreation() {
    const pending = this.pendingCreation;
    if (!pending) return { ok: true, pending: false };
    return {
      ok: true,
      pending: true,
      pendingId: pending.pendingId,
      profile: {
        directory: path.join(pending.storageRoot, pending.directoryName),
        profileId: pending.profileId,
        label: pending.manifest.label,
      },
      recoveryKey: pending.recoveryKey,
    };
  }

  async finalizeCreate({ pendingId, passphrase, acknowledged }) {
    const pending = this.pendingCreation;
    if (!pending || typeof pendingId !== 'string' || pendingId !== pending.pendingId) {
      throw new Error('The pending POS profile setup expired. Start profile setup again.');
    }
    if (acknowledged !== true) throw new Error('Confirm that the recovery key has been saved before finishing POS profile setup.');
    if (this.active) throw new Error('Lock the currently open POS profile before finishing profile setup.');
    if (pending.finalizing) throw new Error('POS profile setup is already being finalized.');
    this.assertSafeStorage();
    validateLockPassphrase(passphrase);
    pending.finalizing = true;
    let dataKey = null;
    let directory = path.join(pending.storageRoot, pending.directoryName);
    try {
      dataKey = await unwrapDataKeyWithPassphrase(pending.envelope.passphraseWrappedKey, passphrase, pending.profileId);
      if (fs.existsSync(directory)) {
        const directoryStat = fs.lstatSync(directory);
        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
          throw new Error('The pending POS profile folder must be a real directory, not a link.');
        }
        const existingManifest = readProfileManifest(directory);
        if (existingManifest.profileId !== pending.profileId) {
          throw new Error('The selected POS profile folder was created by another setup. No existing data was changed.');
        }
        const names = fs.readdirSync(directory).sort();
        if (names.length === 2 && names[0] === 'nexfix-key-envelope.json' && names[1] === 'nexfix-profile.json') {
          const existingEnvelope = readProfileKeyEnvelope(directory, pending.profileId);
          if (JSON.stringify(existingEnvelope) !== JSON.stringify(pending.envelope)) {
            throw new Error('The pending POS profile key does not match the folder already on disk.');
          }
        } else if (names.length === 1 && names[0] === 'nexfix-profile.json') {
          // This is only the manifest from this pending setup; no profile data
          // or key envelope exists yet, so safely retry the exclusive creation.
          fs.rmSync(directory, { recursive: false });
          directory = '';
        } else {
          throw new Error('The pending POS profile folder contains unexpected files. No existing data was changed.');
        }
      }
      if (!directory || !fs.existsSync(directory)) {
        const created = createManagedProfileDirectory(pending.storageRoot, pending.directoryName, {
          profileId: pending.profileId,
          label: pending.manifest.label,
          dataSchemaVersion: 1,
        });
        directory = created.directory;
        persistNewProfileKeyEnvelope(directory, pending.envelope);
      }
      const envelope = readProfileKeyEnvelope(directory, pending.profileId);
      const verifiedKey = await unwrapDataKeyWithPassphrase(envelope.passphraseWrappedKey, passphrase, pending.profileId);
      const sameKey = verifiedKey.equals(dataKey);
      verifiedKey.fill(0);
      if (!sameKey) throw new Error('The saved POS profile key did not match the verified passphrase.');
      await this.secureDirectory(directory);
      const storage = new EncryptedProfileStorage(directory, pending.profileId, dataKey);
      this.active = {
        directory: fs.realpathSync(directory),
        profileId: pending.profileId,
        label: pending.manifest.label,
        storage,
      };
      const profile = { directory: this.active.directory, profileId: pending.profileId, label: pending.manifest.label };
      pending.recoveryKey = '';
      this.pendingCreation = null;
      return { ok: true, profile };
    } catch (error) {
      // If finalization failed before the encrypted key envelope was saved,
      // remove only the manifest-only directory created for this pending ID.
      // A complete profile is preserved so an acknowledged key can recover it.
      try {
        if (directory && fs.existsSync(directory)) {
          const manifest = readProfileManifest(directory);
          const names = fs.readdirSync(directory);
          if (manifest.profileId === pending.profileId &&
              names.length === 1 && names[0] === 'nexfix-profile.json') {
            fs.rmdirSync(directory);
          }
        }
      } catch { /* leave uncertain filesystem state visible; never delete unknown files */ }
      throw error;
    } finally {
      if (dataKey) dataKey.fill(0);
      if (this.pendingCreation === pending) pending.finalizing = false;
    }
  }

  clearPendingRecoveryKeyRotation() {
    const pending = this.pendingRecoveryKeyRotation;
    if (pending) {
      pending.recoveryKey = '';
      if (Buffer.isBuffer(pending.dataKey)) pending.dataKey.fill(0);
    }
    this.pendingRecoveryKeyRotation = null;
    return { ok: true };
  }

  prepareRecoveryKeyRotation(currentRecoveryKey) {
    const active = this.requireActive();
    if (this.pendingRecoveryKeyRotation?.finalized === true) {
      // The completion receipt contains no raw key material and exists only
      // so a lost IPC response can be retried idempotently in this process.
      this.clearPendingRecoveryKeyRotation();
    }
    if (this.pendingRecoveryKeyRotation) {
      throw new Error('Finish or cancel the pending POS Recovery Key rotation first.');
    }
    if (typeof currentRecoveryKey !== 'string' || !currentRecoveryKey || currentRecoveryKey.length > 256) {
      throw new Error('Enter the current POS Recovery Key to continue.');
    }
    const prepared = prepareProfileRecoveryKeyRotation(
      active.directory, active.profileId, currentRecoveryKey,
    );
    const pendingId = crypto.randomBytes(32).toString('base64url');
    this.pendingRecoveryKeyRotation = {
      pendingId,
      directory: fs.realpathSync(active.directory),
      profileId: active.profileId,
      recoveryKey: prepared.recoveryKey,
      expectedEnvelopeSha256: prepared.expectedEnvelopeSha256,
      recoveryWrappedKey: prepared.recoveryWrappedKey,
      dataKey: prepared.dataKey,
    };
    return {
      ok: true,
      pending: true,
      pendingId,
      profile: { directory: active.directory, profileId: active.profileId, label: active.label },
      recoveryKey: prepared.recoveryKey,
    };
  }

  cancelRecoveryKeyRotation(pendingId) {
    const pending = this.pendingRecoveryKeyRotation;
    if (!pending) return { ok: true, canceled: false };
    if (typeof pendingId !== 'string' || pendingId !== pending.pendingId) {
      throw new Error('The pending POS Recovery Key rotation does not match this profile.');
    }
    if (pending.finalized === true) {
      throw new Error('This Recovery Key rotation has already been finalized and cannot be cancelled.');
    }
    this.clearPendingRecoveryKeyRotation();
    return { ok: true, canceled: true };
  }

  getPendingRecoveryKeyRotation() {
    const pending = this.pendingRecoveryKeyRotation;
    if (!pending) return { ok: true, pending: false };
    const active = this.requireActive();
    if (active.profileId !== pending.profileId ||
        fs.realpathSync(active.directory) !== pending.directory) {
      this.clearPendingRecoveryKeyRotation();
      return { ok: true, pending: false };
    }
    if (pending.finalized === true) {
      // The user already acknowledged and saved the key. Do not re-display it
      // after a renderer reload; retain only the non-secret retry receipt.
      return { ok: true, pending: false, finalized: true };
    }
    return {
      ok: true,
      pending: true,
      pendingId: pending.pendingId,
      profile: { directory: active.directory, profileId: active.profileId, label: active.label },
      recoveryKey: pending.recoveryKey,
    };
  }

  finalizeRecoveryKeyRotation({ pendingId, acknowledged }) {
    const pending = this.pendingRecoveryKeyRotation;
    if (!pending || typeof pendingId !== 'string' || pendingId !== pending.pendingId) {
      throw new Error('The pending POS Recovery Key rotation expired. Start rotation again.');
    }
    if (acknowledged !== true) {
      throw new Error('Confirm that the new Recovery Key has been saved before finishing rotation.');
    }
    const active = this.requireActive();
    if (active.profileId !== pending.profileId ||
        fs.realpathSync(active.directory) !== pending.directory) {
      this.clearPendingRecoveryKeyRotation();
      throw new Error('The active POS profile changed during Recovery Key rotation. Start again.');
    }
    finalizeProfileRecoveryKeyRotation(active.directory, pending);
    if (pending.finalized !== true) {
      // Keep a non-secret receipt so a renderer that missed the IPC response
      // can retry. Raw key material is cleared immediately after disk verify.
      pending.finalized = true;
      pending.recoveryKey = '';
      if (Buffer.isBuffer(pending.dataKey)) pending.dataKey.fill(0);
      pending.dataKey = null;
    }
    return { ok: true, profile: this.getStatus().profile, recoveryKeyUpdated: true };
  }

  async unlockWithOS(directory) {
    if (this.active) throw new Error('Lock the currently open POS profile before selecting another profile.');
    this.assertSafeStorage();
    const manifest = readProfileManifest(directory);
    const envelope = readProfileKeyEnvelope(directory, manifest.profileId);
    const dataKey = await unwrapDataKeyWithOS(envelope.osWrappedKey, manifest.profileId, this.safeStorage);
    try {
      await this.secureDirectory(directory);
      const storage = new EncryptedProfileStorage(directory, manifest.profileId, dataKey);
      dataKey.fill(0);
      this.active = {
        directory: fs.realpathSync(directory),
        profileId: manifest.profileId,
        label: manifest.label,
        storage,
      };
      return { ok: true, profile: this.getStatus().profile };
    } catch (error) {
      dataKey.fill(0);
      throw error;
    }
  }

  async unlockWithPassphrase(directory, passphrase) {
    if (this.active) throw new Error('Lock the currently open POS profile before selecting another profile.');
    this.assertSafeStorage();
    const manifest = readProfileManifest(directory);
    const envelope = readProfileKeyEnvelope(directory, manifest.profileId);
    if (!envelope.passphraseWrappedKey) throw new Error('This POS profile requires its portable recovery key to set a new folder-lock password.');
    const dataKey = await unwrapDataKeyWithPassphrase(envelope.passphraseWrappedKey, passphrase, manifest.profileId);
    try {
      await rebindProfileDeviceKeyWithPassphrase(directory, manifest.profileId, passphrase, this.safeStorage);
      await this.secureDirectory(directory);
      const storage = new EncryptedProfileStorage(directory, manifest.profileId, dataKey);
      dataKey.fill(0);
      this.active = {
        directory: fs.realpathSync(directory),
        profileId: manifest.profileId,
        label: manifest.label,
        storage,
      };
      return { ok: true, profile: this.getStatus().profile };
    } catch (error) {
      dataKey.fill(0);
      throw error;
    }
  }

  async unlockWithRecoveryKey(directory, recoveryKey) {
    if (this.active) throw new Error('Lock the currently open POS profile before selecting another profile.');
    this.assertSafeStorage();
    const manifest = readProfileManifest(directory);
    const envelope = readProfileKeyEnvelope(directory, manifest.profileId);
    const dataKey = unwrapDataKeyWithRecoveryKey(envelope.recoveryWrappedKey, recoveryKey, manifest.profileId);
    try {
      await rebindProfileDeviceKeyWithRecoveryKey(directory, manifest.profileId, recoveryKey, this.safeStorage);
      await this.secureDirectory(directory);
      const storage = new EncryptedProfileStorage(directory, manifest.profileId, dataKey);
      dataKey.fill(0);
      this.active = {
        directory: fs.realpathSync(directory),
        profileId: manifest.profileId,
        label: manifest.label,
        storage,
      };
      return { ok: true, profile: this.getStatus().profile };
    } catch (error) {
      dataKey.fill(0);
      throw error;
    }
  }

  lock() {
    this.clearPendingRecoveryKeyRotation();
    if (!this.active) return { ok: true, locked: true };
    this.active.storage.destroy();
    this.active = null;
    return { ok: true, locked: true };
  }

  requireActive() {
    if (!this.active) throw new Error('No POS profile is unlocked.');
    return this.active;
  }

  read(purpose) {
    return this.requireActive().storage.read(purpose);
  }

  write(purpose, serializedPayload) {
    return this.requireActive().storage.write(purpose, serializedPayload);
  }

  async changePassphrase(currentPassphrase, nextPassphrase) {
    const active = this.requireActive();
    this.clearPendingRecoveryKeyRotation();
    return changeProfileLockPassphrase(active.directory, active.profileId, currentPassphrase, nextPassphrase);
  }

  async resetPassphrase(recoveryKey, nextPassphrase) {
    const active = this.requireActive();
    this.clearPendingRecoveryKeyRotation();
    return resetProfileLockPassphraseWithRecoveryKey(active.directory, active.profileId, recoveryKey, nextPassphrase);
  }

  getStatus() {
    if (!this.active) return { unlocked: false };
    return {
      unlocked: true,
      profile: {
        directory: this.active.directory,
        profileId: this.active.profileId,
        label: this.active.label,
      },
    };
  }
}

module.exports = { POSProfileSession, resolveCurrentWindowsUserSid, resolveStorageRoot, MAX_DISCOVERY_ENTRIES };
