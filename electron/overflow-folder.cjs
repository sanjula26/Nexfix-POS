'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readProfileManifest } = require('./storage-profile.cjs');

const CONFIG_VERSION = 2;
const CONFIG_FILE = 'overflow-folder.json';

function validateFolder(folderPath, options = {}) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  if (typeof folderPath !== 'string' || !folderPath.trim()) {
    throw new Error('Choose a folder for future POS storage overflow.');
  }
  const selectedPath = folderPath.trim();
  if (/^(?:\\\\\\?\\UNC\\|\\\\[^\\]+\\[^\\]+)/i.test(selectedPath)) {
    throw new Error('Network folders are not supported for POS overflow storage. Choose an internal drive or attached external drive.');
  }
  const requested = pathApi.resolve(selectedPath);
  let stat;
  try {
    stat = fsApi.lstatSync(requested);
  } catch {
    throw new Error('The selected folder is unavailable. Connect the drive or choose another folder.');
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Choose an existing normal folder, not a file or shortcut.');
  }

  const canonical = fsApi.realpathSync(requested);
  const canonicalStat = fsApi.lstatSync(canonical);
  if (canonicalStat.isSymbolicLink() || !canonicalStat.isDirectory()) {
    throw new Error('The selected location is not a safe normal folder.');
  }
  const root = pathApi.parse(canonical).root;
  if (canonical.toLowerCase() === root.toLowerCase()) {
    throw new Error('Choose a folder inside the drive, not the drive root itself.');
  }

  const probePath = pathApi.join(canonical, '.nexfix-write-check-' + crypto.randomBytes(8).toString('hex'));
  let descriptor;
  try {
    descriptor = fsApi.openSync(probePath, 'wx', 0o600);
    fsApi.writeSync(descriptor, 'Nexfix POS storage folder check');
    fsApi.fsyncSync(descriptor);
  } catch {
    throw new Error('Nexfix cannot write to the selected folder. Check its permissions or choose another folder.');
  } finally {
    if (descriptor !== undefined) {
      try { fsApi.closeSync(descriptor); } catch {}
    }
    try { fsApi.unlinkSync(probePath); } catch {}
  }
  return canonical;
}

function createOverflowFolderManager(options = {}) {
  const app = options.app;
  const dialog = options.dialog;
  const BrowserWindow = options.BrowserWindow;
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  if (!app || typeof app.getPath !== 'function' || !dialog || !BrowserWindow) {
    throw new Error('Overflow folder manager requires Electron app, dialog and BrowserWindow.');
  }

  const configPath = pathApi.join(app.getPath('userData'), 'nexfix-storage', CONFIG_FILE);

  function readConfig() {
    if (!fsApi.existsSync(configPath)) return null;
    const saved = JSON.parse(fsApi.readFileSync(configPath, 'utf8'));
    if (!saved || typeof saved.folderPath !== 'string' || !saved.folderPath.trim() ||
        ![1, CONFIG_VERSION].includes(saved.version)) {
      throw new Error('The saved POS overflow-folder preference is invalid.');
    }
    if (saved.version === 1) {
      return {
        version: CONFIG_VERSION,
        folderPath: saved.folderPath,
        storageMode: 'indexeddb',
        profileDirectoryName: null,
        profileId: null,
      };
    }
    const storageMode = saved.storageMode;
    if (storageMode !== 'indexeddb' && storageMode !== 'folder_primary') {
      throw new Error('The saved POS storage mode is invalid; storage startup must be repaired.');
    }
    const profileDirectoryName = saved.profileDirectoryName ?? null;
    const profileId = saved.profileId ?? null;
    if (storageMode === 'folder_primary' &&
        (typeof profileDirectoryName !== 'string' || !profileDirectoryName ||
         pathApi.isAbsolute(profileDirectoryName) || profileDirectoryName === '.' ||
         profileDirectoryName === '..' || profileDirectoryName.includes(pathApi.sep) ||
         typeof profileId !== 'string' || !/^[0-9a-f-]{36}$/i.test(profileId))) {
      throw new Error('The primary POS profile pointer is invalid; storage startup must be repaired.');
    }
    return { version: CONFIG_VERSION, folderPath: saved.folderPath, storageMode, profileDirectoryName, profileId };
  }

  function saveConfig(config) {
    const directory = pathApi.dirname(configPath);
    fsApi.mkdirSync(directory, { recursive: true });
    const temporaryPath = configPath + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    try {
      fsApi.writeFileSync(temporaryPath, JSON.stringify({
        version: CONFIG_VERSION,
        folderPath: config.folderPath,
        storageMode: config.storageMode || 'indexeddb',
        profileDirectoryName: config.storageMode === 'folder_primary' ? config.profileDirectoryName : null,
        profileId: config.storageMode === 'folder_primary' ? config.profileId : null,
      }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      try { fsApi.chmodSync(temporaryPath, 0o600); } catch {}
      fsApi.renameSync(temporaryPath, configPath);
    } finally {
      try { fsApi.unlinkSync(temporaryPath); } catch {}
    }
  }

  function assertPrimaryProfileAtRoot(root, profileDirectoryName, profileId) {
    const profileDirectory = pathApi.join(root, profileDirectoryName);
    let stat;
    try { stat = fsApi.lstatSync(profileDirectory); }
    catch { throw new Error('The selected folder does not contain the configured primary POS profile.'); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('The selected folder does not contain the configured primary POS profile.');
    }
    const canonicalProfileDirectory = fsApi.realpathSync(profileDirectory);
    const relative = pathApi.relative(root, canonicalProfileDirectory);
    if (relative !== profileDirectoryName) {
      throw new Error('The primary POS profile must remain directly inside the selected storage folder.');
    }
    const manifest = readProfileManifest(canonicalProfileDirectory);
    if (manifest.profileId !== profileId) {
      throw new Error('The selected folder contains a different POS profile; the primary data folder cannot be changed.');
    }
    return canonicalProfileDirectory;
  }

  function getPreference() {
    let config;
    try {
      config = readConfig();
    } catch (error) {
      return {
        ok: false, configured: true, available: false, folderPath: null,
        storageMode: 'unknown', profileDirectoryName: null, profileId: null, profileDirectory: null,
        error: error instanceof Error ? error.message : 'The saved POS storage configuration is invalid.',
      };
    }
    if (!config) {
      return {
        ok: true, configured: false, available: false, folderPath: null,
        storageMode: 'indexeddb', profileDirectoryName: null, profileId: null, profileDirectory: null,
      };
    }
    const base = {
      ok: true,
      configured: true,
      storageMode: config.storageMode,
      profileDirectoryName: config.profileDirectoryName,
      profileId: config.profileId,
    };
    try {
      const canonical = validateFolder(config.folderPath, { fsApi, pathApi });
      const profileDirectory = config.storageMode === 'folder_primary'
        ? assertPrimaryProfileAtRoot(canonical, config.profileDirectoryName, config.profileId)
        : null;
      return { ...base, available: true, folderPath: canonical, profileDirectory };
    } catch (error) {
      return {
        ...base,
        available: false,
        folderPath: null,
        profileDirectory: config.storageMode === 'folder_primary'
          ? pathApi.join(config.folderPath, config.profileDirectoryName)
          : null,
        error: error instanceof Error ? error.message : 'The saved overflow folder is unavailable.',
      };
    }
  }

  async function chooseFolder() {
    const current = readConfig();
    const window = BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(window || undefined, {
      title: current?.storageMode === 'folder_primary'
        ? 'Reconnect the existing Nexfix POS primary storage folder'
        : 'Choose Nexfix POS overflow storage folder',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths?.[0]) {
      return { ok: true, canceled: true, ...getPreference() };
    }
    const folderPath = validateFolder(result.filePaths[0], { fsApi, pathApi });
    if (current?.storageMode === 'folder_primary') {
      assertPrimaryProfileAtRoot(folderPath, current.profileDirectoryName, current.profileId);
      saveConfig({ ...current, folderPath });
    } else {
      saveConfig({ folderPath, storageMode: 'indexeddb' });
    }
    return { ok: true, canceled: false, ...getPreference() };
  }

  function markPrimary(profileDirectory, profileId) {
    const current = readConfig();
    if (!current?.folderPath) throw new Error('Choose the POS overflow folder before marking it primary.');
    if (current.storageMode === 'folder_primary' && current.profileId !== profileId) {
      throw new Error('A different POS profile is already the primary storage.');
    }
    const root = validateFolder(current.folderPath, { fsApi, pathApi });
    const stat = fsApi.lstatSync(profileDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('The POS profile directory is not a normal folder.');
    }
    const canonicalProfileDirectory = fsApi.realpathSync(profileDirectory);
    const relative = pathApi.relative(root, canonicalProfileDirectory);
    if (!relative || relative.startsWith('..') || pathApi.isAbsolute(relative) ||
        relative.includes(pathApi.sep)) {
      throw new Error('The primary POS profile must be a direct child of the selected overflow folder.');
    }
    const manifest = readProfileManifest(canonicalProfileDirectory);
    if (manifest.profileId !== profileId) throw new Error('The POS profile identity does not match the selected profile.');
    saveConfig({
      folderPath: root,
      storageMode: 'folder_primary',
      profileDirectoryName: relative,
      profileId,
    });
    return getPreference();
  }

  function markIndexedDBPrimary(profileId) {
    const current = readConfig();
    if (!current || current.storageMode !== 'folder_primary' || current.profileId !== profileId) {
      throw new Error('The primary POS profile pointer changed; refusing an unsafe rollback.');
    }
    saveConfig({ folderPath: current.folderPath, storageMode: 'indexeddb' });
    return getPreference();
  }

  return { getPreference, chooseFolder, markPrimary, markIndexedDBPrimary, configPath };
}

function registerOverflowFolderIpc(options = {}) {
  const { ipcMain, isTrustedRenderer } = options;
  if (!ipcMain || typeof isTrustedRenderer !== 'function') {
    throw new Error('Overflow folder IPC requires IPC and trusted-renderer validation.');
  }
  const manager = createOverflowFolderManager(options);
  const register = (channel, handler) => {
    ipcMain.handle(channel, async (event) => {
      if (!isTrustedRenderer(event)) return { ok: false, error: 'Untrusted renderer.' };
      try {
        return await handler();
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Overflow folder operation failed.' };
      }
    });
  };
  register('pos-overflow-folder:get', () => manager.getPreference());
  register('pos-overflow-folder:choose', () => manager.chooseFolder());
  return manager;
}

module.exports = {
  CONFIG_VERSION,
  CONFIG_FILE,
  validateFolder,
  createOverflowFolderManager,
  registerOverflowFolderIpc,
};
