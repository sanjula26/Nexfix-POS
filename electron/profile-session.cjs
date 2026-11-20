'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createManagedProfileDirectory, readProfileManifest, classifyProfileCandidates } = require('./storage-profile.cjs');
const {
  createInitialProfileKeyEnvelope,
  persistNewProfileKeyEnvelope,
  readProfileKeyEnvelope,
  changeProfileLockPassphrase,
  resetProfileLockPassphraseWithRecoveryKey,
  rebindProfileDeviceKeyWithRecoveryKey,
  rebindProfileDeviceKeyWithPassphrase,
} = require('./profile-key-store.cjs');
const { unwrapDataKeyWithPassphrase, unwrapDataKeyWithRecoveryKey, validateLockPassphrase } = require('./profile-crypto.cjs');
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
    const created = createManagedProfileDirectory(storageRoot, directoryName, {
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
      this.active = {
        directory: fs.realpathSync(directory),
        profileId: manifest.profileId,
        label: manifest.label,
        storage: new EncryptedProfileStorage(directory, manifest.profileId, dataKey),
      };
      return { ok: true, profile: this.getStatus().profile };
    } catch (error) {
      dataKey.fill(0);
      throw error;
    }
  }

  lock() {
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
    return changeProfileLockPassphrase(active.directory, active.profileId, currentPassphrase, nextPassphrase);
  }

  async resetPassphrase(recoveryKey, nextPassphrase) {
    const active = this.requireActive();
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
