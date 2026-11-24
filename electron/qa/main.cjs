'use strict';

const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const { prepareQaFolder } = require('./prepare-qa-folder.cjs');

const QA_APP_NAME = 'Nexfix POS Storage QA';
const QA_USER_DATA_DIRECTORY = 'Nexfix POS Storage QA';
const QA_FOLDER_CHANNEL = 'nexfix-storage-qa:choose-folder';

// Set a dedicated app name and user-data directory before Electron becomes ready.
// This prevents the QA shell from opening or modifying the production POS profile.
app.setName(QA_APP_NAME);
app.setPath('userData', path.join(app.getPath('appData'), QA_USER_DATA_DIRECTORY));

let mainWindow = null;

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

function registerQaFolderPicker() {
  ipcMain.handle(QA_FOLDER_CHANNEL, async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error('QA folder selection is available only to the isolated QA window.');
    }

    const selection = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a disposable Nexfix Storage QA parent folder',
      buttonLabel: 'Use this folder for QA',
      properties: ['openDirectory'],
    });
    if (selection.canceled || selection.filePaths.length !== 1) {
      return { cancelled: true };
    }

    const prepared = await prepareQaFolder({
      selectedPath: selection.filePaths[0],
      protectedRoots: protectedStorageRoots(),
    });
    return { cancelled: false, folderPath: prepared.folderPath };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 760,
    minHeight: 540,
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
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
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

  registerQaFolderPicker();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(() => {
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
