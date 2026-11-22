'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_VERSION = 1;
const CONFIG_FILE = 'overflow-folder.json';

function validateFolder(folderPath, options = {}) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  if (typeof folderPath !== 'string' || !folderPath.trim()) {
    throw new Error('Choose a folder for future POS storage overflow.');
  }
  const requested = pathApi.resolve(folderPath.trim());
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

  function readPreference() {
    try {
      const parsed = JSON.parse(fsApi.readFileSync(configPath, 'utf8'));
      if (!parsed || parsed.version !== CONFIG_VERSION ||
          typeof parsed.folderPath !== 'string' || !parsed.folderPath.trim()) return null;
      return parsed.folderPath;
    } catch {
      return null;
    }
  }

  function savePreference(folderPath) {
    const directory = pathApi.dirname(configPath);
    fsApi.mkdirSync(directory, { recursive: true });
    const temporaryPath = configPath + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    try {
      fsApi.writeFileSync(temporaryPath, JSON.stringify({
        version: CONFIG_VERSION,
        folderPath,
      }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      try { fsApi.chmodSync(temporaryPath, 0o600); } catch {}
      fsApi.renameSync(temporaryPath, configPath);
    } finally {
      try { fsApi.unlinkSync(temporaryPath); } catch {}
    }
  }

  function getPreference() {
    const folderPath = readPreference();
    if (!folderPath) return { ok: true, configured: false, available: false, folderPath: null };
    try {
      const validated = validateFolder(folderPath, { fsApi, pathApi });
      return { ok: true, configured: true, available: true, folderPath: validated };
    } catch (error) {
      return {
        ok: true,
        configured: true,
        available: false,
        folderPath: null,
        error: error instanceof Error ? error.message : 'The saved overflow folder is unavailable.',
      };
    }
  }

  async function chooseFolder() {
    const window = BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(window || undefined, {
      title: 'Choose Nexfix POS overflow storage folder',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths?.[0]) {
      return { ok: true, canceled: true, ...getPreference() };
    }
    const folderPath = validateFolder(result.filePaths[0], { fsApi, pathApi });
    savePreference(folderPath);
    return { ok: true, canceled: false, configured: true, available: true, folderPath };
  }

  return { getPreference, chooseFolder, configPath };
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
