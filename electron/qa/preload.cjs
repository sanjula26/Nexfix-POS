'use strict';

const { contextBridge } = require('electron');

// Identity-only bridge for the isolated shell. No filesystem, IPC, quota,
// migration, profile, updater, cloud or production POS methods are exposed.
contextBridge.exposeInMainWorld('nexfixStorageQA', Object.freeze({
  appName: 'Nexfix POS Storage QA',
  mode: 'offline-only-shell',
}));
