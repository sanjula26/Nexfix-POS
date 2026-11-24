'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The QA renderer reuses the reviewed production profile/storage bridge, but
// only inside this separate app identity, userData directory and QA package.
const desktopApi = Object.freeze({
  isDesktop: true,
  getPOSOverflowFolder: () => ipcRenderer.invoke('pos-overflow-folder:get'),
  choosePOSOverflowFolder: () => ipcRenderer.invoke('pos-overflow-folder:choose'),
  discoverPOSProfiles: (storageRoot) => ipcRenderer.invoke('pos-profile:discover', { storageRoot }),
  createPOSProfile: (payload) => ipcRenderer.invoke('pos-profile:create', payload),
  unlockPOSProfileWithPassphrase: (directory, secret) => ipcRenderer.invoke('pos-profile:unlock-passphrase', { directory, secret }),
  unlockPOSProfileWithOS: (directory) => ipcRenderer.invoke('pos-profile:unlock-os', { directory }),
  unlockPOSProfileWithRecoveryKey: (directory, secret) => ipcRenderer.invoke('pos-profile:unlock-recovery', { directory, secret }),
  getPOSProfileStatus: () => ipcRenderer.invoke('pos-profile:status'),
  lockPOSProfile: () => ipcRenderer.invoke('pos-profile:lock'),
  getPOSMigrationJournal: () => ipcRenderer.invoke('pos-profile:migration:status'),
  beginPOSStorageMigration: () => ipcRenderer.invoke('pos-profile:migration:begin'),
  transitionPOSStorageMigration: (nextPhase) => ipcRenderer.invoke('pos-profile:migration:transition', { nextPhase }),
  recordPOSMigrationCopy: (purpose, details) => ipcRenderer.invoke('pos-profile:migration:record-copy', { purpose, details }),
  recordPOSMigrationVerification: (purpose, details) => ipcRenderer.invoke('pos-profile:migration:record-verification', { purpose, details }),
  readPOSProfileData: (purpose) => ipcRenderer.invoke('pos-profile:read', { purpose }),
  writePOSProfileData: (purpose, payload) => ipcRenderer.invoke('pos-profile:write', { purpose, payload }),
  changePOSProfilePassphrase: (currentPassphrase, nextPassphrase) => ipcRenderer.invoke('pos-profile:change-passphrase', { currentPassphrase, nextPassphrase }),
  resetPOSProfilePassphrase: (recoveryKey, nextPassphrase) => ipcRenderer.invoke('pos-profile:reset-passphrase', { recoveryKey, nextPassphrase }),
});

contextBridge.exposeInMainWorld('nexfixDesktop', desktopApi);
contextBridge.exposeInMainWorld('nexfixStorageQA', Object.freeze({
  appName: 'Nexfix POS Storage QA',
  mode: 'offline-only-encrypted-profile-and-quota-fixture',
  chooseFolder: () => ipcRenderer.invoke('pos-overflow-folder:choose'),
}));
