'use strict';

const path = require('node:path');
const { POSProfileSession } = require('./profile-session.cjs');

const MAX_PROFILE_PAYLOAD_BYTES = 256 * 1024 * 1024;
const MAX_PASSPHRASE_LENGTH = 1024;
const MAX_RECOVERY_KEY_LENGTH = 256;

function safeMessage(error) {
  const message = error instanceof Error ? error.message : 'POS profile operation failed.';
  return message.slice(0, 500);
}

function registerPOSProfileIpc(options) {
  const { ipcMain, dialog, BrowserWindow, safeStorage, isTrustedRenderer } = options || {};
  if (!ipcMain || !dialog || !BrowserWindow || typeof isTrustedRenderer !== 'function') {
    throw new Error('POS profile IPC requires Electron IPC, dialog, window and trusted-renderer dependencies.');
  }

  const profileSession = new POSProfileSession({
    safeStorage,
    platform: options.platform || process.platform,
    resolveUserSid: options.resolveUserSid,
    applyAcl: options.applyAcl,
  });
  const selectedRoots = new Set();
  const discoveredProfiles = new Set();

  function getConfiguredStoragePreference() {
    if (typeof options.getConfiguredStorageRoot !== 'function') return null;
    try {
      return options.getConfiguredStorageRoot();
    } catch {
      return { ok: false, configured: true, available: false, folderPath: null };
    }
  }

  function isSelectedStorageRoot(root) {
    const preference = getConfiguredStoragePreference();
    if (preference?.configured === true) {
      if (preference.ok !== true || preference.available !== true ||
          typeof preference.folderPath !== 'string') return false;
      const configuredRoot = path.resolve(preference.folderPath);
      const platform = options.platform || process.platform;
      return platform === 'win32'
        ? configuredRoot.toLowerCase() === root.toLowerCase()
        : configuredRoot === root;
    }
    return selectedRoots.has(root);
  }

  const register = (channel, handler) => {
    ipcMain.handle(channel, async (event, payload) => {
      if (!isTrustedRenderer(event)) return { ok: false, error: 'Untrusted renderer.' };
      try {
        return await handler(payload);
      } catch (error) {
        return { ok: false, error: safeMessage(error) };
      }
    });
  };

  register('pos-profile:choose-storage-root', async () => {
    const preference = getConfiguredStoragePreference();
    if (preference?.configured === true) {
      if (preference.ok !== true || preference.available !== true || typeof preference.folderPath !== 'string') {
        throw new Error('Reconnect the selected POS overflow folder or choose a replacement in POS storage setup.');
      }
      const root = path.resolve(preference.folderPath);
      selectedRoots.add(root);
      return { ok: true, canceled: false, storageRoot: root, reusedConfiguredFolder: true };
    }
    const window = BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(window || undefined, {
      title: 'Choose Nexfix POS storage folder',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths?.[0]) return { ok: true, canceled: true };
    const root = path.resolve(result.filePaths[0]);
    selectedRoots.add(root);
    return { ok: true, canceled: false, storageRoot: root, reusedConfiguredFolder: false };
  });

  register('pos-profile:discover', (payload) => {
    const root = typeof payload?.storageRoot === 'string' ? path.resolve(payload.storageRoot) : '';
    if (!root || !isSelectedStorageRoot(root)) throw new Error('Choose the POS storage folder inside Nexfix before scanning it.');
    const result = profileSession.discover(root);
    for (const item of result.available) discoveredProfiles.add(item.directory);
    for (const group of result.duplicates) {
      for (const copy of group.copies) discoveredProfiles.add(copy.directory);
    }
    return { ok: true, ...result };
  });

  register('pos-profile:create', async (payload) => {
    const storageRoot = typeof payload?.storageRoot === 'string' ? path.resolve(payload.storageRoot) : '';
    const directoryName = typeof payload?.directoryName === 'string' ? payload.directoryName : '';
    const label = typeof payload?.label === 'string' ? payload.label : '';
    const passphrase = typeof payload?.passphrase === 'string' ? payload.passphrase : '';
    if (!isSelectedStorageRoot(storageRoot)) throw new Error('Choose the POS storage folder inside Nexfix before creating a profile.');
    if (!passphrase || passphrase.length > MAX_PASSPHRASE_LENGTH) throw new Error('A valid folder-lock passphrase is required.');
    const result = await profileSession.create({ storageRoot, directoryName, label, passphrase });
    discoveredProfiles.add(result.profile.directory);
    return result;
  });

  const unlock = (channel, method) => register(channel, async (payload) => {
    const directory = typeof payload?.directory === 'string' ? path.resolve(payload.directory) : '';
    if (!directory || !discoveredProfiles.has(directory)) {
      throw new Error('Scan the selected POS storage folder and choose a listed profile first.');
    }
    const secret = typeof payload?.secret === 'string' ? payload.secret : '';
    const limit = method === 'recovery' ? MAX_RECOVERY_KEY_LENGTH : MAX_PASSPHRASE_LENGTH;
    if (!secret || secret.length > limit) throw new Error('The folder-lock credential is missing or invalid.');
    return method === 'recovery'
      ? profileSession.unlockWithRecoveryKey(directory, secret)
      : profileSession.unlockWithPassphrase(directory, secret);
  });
  unlock('pos-profile:unlock-passphrase', 'passphrase');
  unlock('pos-profile:unlock-recovery', 'recovery');

  register('pos-profile:unlock-os', async (payload) => {
    const directory = typeof payload?.directory === 'string' ? path.resolve(payload.directory) : '';
    if (!directory || !discoveredProfiles.has(directory)) {
      throw new Error('Scan the selected POS storage folder and choose a listed profile first.');
    }
    return profileSession.unlockWithOS(directory);
  });

  register('pos-profile:status', () => ({ ok: true, ...profileSession.getStatus() }));
  register('pos-profile:lock', () => profileSession.lock());

  register('pos-profile:read', (payload) => {
    const purpose = payload?.purpose;
    const serializedPayload = profileSession.read(purpose);
    return { ok: true, found: serializedPayload !== null, payload: serializedPayload };
  });

  register('pos-profile:write', (payload) => {
    if (typeof payload?.payload !== 'string' ||
        Buffer.byteLength(payload.payload, 'utf8') > MAX_PROFILE_PAYLOAD_BYTES) {
      throw new Error('POS profile data is missing or exceeds the supported size limit.');
    }
    const result = profileSession.write(payload.purpose, payload.payload);
    return { ok: true, ...result };
  });

  register('pos-profile:change-passphrase', async (payload) => {
    const current = typeof payload?.currentPassphrase === 'string' ? payload.currentPassphrase : '';
    const next = typeof payload?.nextPassphrase === 'string' ? payload.nextPassphrase : '';
    if (!current || !next || next.length > MAX_PASSPHRASE_LENGTH) throw new Error('Enter the current and a valid new folder-lock passphrase.');
    await profileSession.changePassphrase(current, next);
    return { ok: true };
  });

  register('pos-profile:reset-passphrase', async (payload) => {
    const recoveryKey = typeof payload?.recoveryKey === 'string' ? payload.recoveryKey : '';
    const next = typeof payload?.nextPassphrase === 'string' ? payload.nextPassphrase : '';
    if (!recoveryKey || recoveryKey.length > MAX_RECOVERY_KEY_LENGTH || !next || next.length > MAX_PASSPHRASE_LENGTH) {
      throw new Error('A valid POS recovery key and new folder-lock passphrase are required.');
    }
    await profileSession.resetPassphrase(recoveryKey, next);
    return { ok: true };
  });

  return {
    session: profileSession,
    lock: () => profileSession.lock(),
    clearSelections: () => {
      selectedRoots.clear();
      discoveredProfiles.clear();
      profileSession.lock();
    },
  };
}

module.exports = { registerPOSProfileIpc, MAX_PROFILE_PAYLOAD_BYTES, MAX_PASSPHRASE_LENGTH, MAX_RECOVERY_KEY_LENGTH };
