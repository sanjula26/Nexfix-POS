'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal production profile/storage bridge, exposed only inside the isolated QA app.
const desktopApi = Object.freeze({
  isDesktop: true,
  getPOSOverflowFolder: () => ipcRenderer.invoke('pos-overflow-folder:get'),
  discoverPOSProfiles: (storageRoot) => ipcRenderer.invoke('pos-profile:discover', { storageRoot }),
  createPOSProfile: (payload) => ipcRenderer.invoke('pos-profile:create', payload),
  unlockPOSProfileWithOS: (directory) => ipcRenderer.invoke('pos-profile:unlock-os', { directory }),
  getPOSProfileStatus: () => ipcRenderer.invoke('pos-profile:status'),
  lockPOSProfile: () => ipcRenderer.invoke('pos-profile:lock'),
  getPOSMigrationJournal: () => ipcRenderer.invoke('pos-profile:migration:status'),
  beginPOSStorageMigration: () => ipcRenderer.invoke('pos-profile:migration:begin'),
  transitionPOSStorageMigration: (nextPhase) => ipcRenderer.invoke('pos-profile:migration:transition', { nextPhase }),
  recordPOSMigrationCopy: (purpose, details) => ipcRenderer.invoke('pos-profile:migration:record-copy', { purpose, details }),
  recordPOSMigrationVerification: (purpose, details) => ipcRenderer.invoke('pos-profile:migration:record-verification', { purpose, details }),
  readPOSProfileData: (purpose) => ipcRenderer.invoke('pos-profile:read', { purpose }),
  writePOSProfileData: (purpose, payload) => ipcRenderer.invoke('pos-profile:write', { purpose, payload }),
});

contextBridge.exposeInMainWorld('nexfixDesktop', desktopApi);
contextBridge.exposeInMainWorld('nexfixStorageQA', Object.freeze({
  appName: 'Nexfix POS Storage QA',
  mode: 'offline-only-encrypted-profile-and-quota-fixture',
  chooseFolder: () => ipcRenderer.invoke('pos-overflow-folder:choose'),
}));
