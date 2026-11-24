'use strict';

const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');

const QA_APP_NAME = 'Nexfix POS Storage QA';
const QA_USER_DATA_DIRECTORY = 'Nexfix POS Storage QA';

// Set a dedicated app name and user-data directory before Electron becomes ready.
// This prevents the QA shell from opening or modifying the production POS profile.
app.setName(QA_APP_NAME);
app.setPath('userData', path.join(app.getPath('appData'), QA_USER_DATA_DIRECTORY));

let mainWindow = null;

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

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(() => {
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
