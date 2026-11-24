'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose one narrowly scoped QA-only folder selection operation.
// No production POS, profile, updater, cloud, or migration APIs are exposed.
contextBridge.exposeInMainWorld('nexfixStorageQA', Object.freeze({
  appName: 'Nexfix POS Storage QA',
  mode: 'offline-only-folder-safety',
  chooseFolder: () => ipcRenderer.invoke('nexfix-storage-qa:choose-folder'),
}));
