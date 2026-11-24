'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, safeStorage, session } = require('electron');
const { prepareQaFolder } = require('./prepare-qa-folder.cjs');
const { createOverflowFolderManager } = require('./profile-runtime/overflow-folder.cjs');
const { registerPOSProfileIpc } = require('./profile-runtime/profile-ipc.cjs');

const QA_APP_NAME = 'Nexfix POS Storage QA';
const QA_USER_DATA_DIRECTORY = 'Nexfix POS Storage QA';

// Set a dedicated app name and user-data directory before Electron becomes ready.
// This prevents the QA shell from opening or modifying the production POS profile.
app.setName(QA_APP_NAME);
app.setPath('userData', path.join(app.getPath('appData'), QA_USER_DATA_DIRECTORY));

let mainWindow = null;
let overflowFolderManager = null;
let profileIpc = null;

function protectedStorageRoots() {
  // Production POS userData is under appData; protecting appData protects it
  // even when the production profile directory has not been created yet.
  const roots = [
    app.getPath('appData'),
    path.dirname(app.getPath('exe')),
    process.env.SystemRoot || process.env.WINDIR,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
  ];
  return [...new Set(roots.filter((entry) => typeof entry === 'string' && entry.trim()))];
}

function verifyQaFolderSentinel(folderPath) {
  const absolute = path.resolve(folderPath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const details = fs.lstatSync(current);
    if (details.isSymbolicLink()) {
      throw new Error('The saved QA folder contains a symbolic link or reparse point.');
    }
  }
  const canonical = fs.realpathSync(absolute);
  const samePath = process.platform === 'win32'
    ? canonical.toLowerCase() === absolute.toLowerCase()
    : canonical === absolute;
  if (!samePath) throw new Error('The saved QA folder is no longer canonical.');

  const sentinelPath = path.join(canonical, '.nexfix-storage-qa-sentinel');
  const sentinelStat = fs.lstatSync(sentinelPath);
  if (sentinelStat.isSymbolicLink() || !sentinelStat.isFile() || sentinelStat.size > 1024) {
    throw new Error('The disposable QA folder sentinel is missing or unsafe.');
  }
  const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
  if (!sentinel || sentinel.application !== QA_APP_NAME ||
      sentinel.format !== 1 || sentinel.purpose !== 'disposable-offline-test-data') {
    throw new Error('The selected folder does not contain the expected disposable QA sentinel.');
  }
  return canonical;
}

function getFolderPreference() {
  if (!overflowFolderManager) {
    return { ok: false, configured: false, available: false, folderPath: null, storageMode: 'unknown' };
  }
  const preference = overflowFolderManager.getPreference();
  if (preference.ok === true && preference.available === true && preference.folderPath) {
    try {
      verifyQaFolderSentinel(preference.folderPath);
    } catch (error) {
      return {
        ...preference,
        ok: false,
        available: false,
        folderPath: null,
        error: error instanceof Error ? error.message : 'The disposable QA folder failed sentinel validation.',
      };
    }
  }
  return preference;
}

function isTrustedQaRenderer(event) {
  const frame = event?.senderFrame;
  return Boolean(
    mainWindow &&
    !mainWindow.isDestroyed() &&
    event?.sender === mainWindow.webContents &&
    frame &&
    frame === event.sender.mainFrame &&
    typeof frame.url === 'string' &&
    frame.url.startsWith('file://') &&
    frame.url === mainWindow.webContents.getURL(),
  );
}

function createQaDialogAdapter() {
  return {
    showOpenDialog: async (parent, options = {}) => {
      const selection = await dialog.showOpenDialog(parent || undefined, {
        ...options,
        title: 'Choose a parent folder for disposable Nexfix Storage QA data',
        buttonLabel: 'Create disposable QA folder',
        properties: ['openDirectory'],
      });
      if (selection.canceled || selection.filePaths?.length !== 1) {
        return { canceled: true, filePaths: [] };
      }

      const prepared = await prepareQaFolder({
        selectedPath: selection.filePaths[0],
        protectedRoots: protectedStorageRoots(),
      });
      return { canceled: false, filePaths: [prepared.folderPath] };
    },
  };
}

function registerQaStorageIpc() {
  const qaDialog = createQaDialogAdapter();
  overflowFolderManager = createOverflowFolderManager({ app, dialog: qaDialog, BrowserWindow });

  const chooseFolder = async (event) => {
    if (!isTrustedQaRenderer(event)) return { ok: false, error: 'Untrusted QA renderer.' };
    const current = getFolderPreference();
    if (current.configured && current.available) return { ...current, canceled: false };
    if (current.storageMode === 'folder_primary') {
      return { ...current, ok: false, error: current.error || 'Reconnect the existing QA primary folder; do not replace it.' };
    }
    const selected = await overflowFolderManager.chooseFolder();
    if (selected.ok && selected.available && selected.folderPath) {
      verifyQaFolderSentinel(selected.folderPath);
    }
    return selected;
  };

  ipcMain.handle('pos-overflow-folder:get', async (event) => {
    if (!isTrustedQaRenderer(event)) return { ok: false, error: 'Untrusted QA renderer.' };
    return getFolderPreference();
  });
  ipcMain.handle('pos-overflow-folder:choose', chooseFolder);

  profileIpc = registerPOSProfileIpc({
    ipcMain,
    dialog: qaDialog,
    BrowserWindow,
    safeStorage,
    isTrustedRenderer: isTrustedQaRenderer,
    getConfiguredStorageRoot: getFolderPreference,
    markOverflowFolderPrimary: (directory, profileId) => overflowFolderManager.markPrimary(directory, profileId),
    markOverflowFolderIndexedDBPrimary: (profileId) => overflowFolderManager.markIndexedDBPrimary(profileId),
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 760,
    minHeight: 580,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f7fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // Load only the local QA shell. No production renderer or remote URL is used.
  mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
}

app.whenReady().then(() => {
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true }),
  );

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  registerQaStorageIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(() => {
  app.exit(1);
});

app.on('before-quit', () => {
  try { profileIpc?.lock(); } catch { /* QA shutdown remains fail-closed. */ }
});
app.on('window-all-closed', () => app.quit());
