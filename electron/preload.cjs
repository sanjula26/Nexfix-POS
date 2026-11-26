const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexfixDesktop', {
  isDesktop: true,
  isPackaged: process.defaultApp !== true,
  isPortable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
  platform: process.platform,
  // Main-process-owned preference for the future IndexedDB quota overflow destination.
  getPOSOverflowFolder: () => ipcRenderer.invoke('pos-overflow-folder:get'),
  choosePOSOverflowFolder: () => ipcRenderer.invoke('pos-overflow-folder:choose'),
  // Encrypted POS profile operations. Main-process IPC validates every caller.
  choosePOSStorageRoot: () => ipcRenderer.invoke('pos-profile:choose-storage-root'),
  discoverPOSProfiles: (storageRoot) => ipcRenderer.invoke('pos-profile:discover', { storageRoot }),
  createPOSProfile: (payload) => ipcRenderer.invoke('pos-profile:prepare-create', payload),
  getPendingPOSProfileCreation: () => ipcRenderer.invoke('pos-profile:pending-create'),
  finalizePOSProfileCreation: (payload) => ipcRenderer.invoke('pos-profile:finalize-create', payload),
  preparePOSRecoveryKeyRotation: (currentRecoveryKey) => ipcRenderer.invoke('pos-profile:prepare-recovery-rotation', { currentRecoveryKey }),
  getPendingPOSRecoveryKeyRotation: (currentRecoveryKey) => ipcRenderer.invoke('pos-profile:pending-recovery-rotation', { currentRecoveryKey }),
  finalizePOSRecoveryKeyRotation: (payload) => ipcRenderer.invoke('pos-profile:finalize-recovery-rotation', payload),
  cancelPOSRecoveryKeyRotation: (pendingId) => ipcRenderer.invoke('pos-profile:cancel-recovery-rotation', { pendingId }),
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
  getVersion: () => ipcRenderer.invoke('app:version'),
  copyText: (text) => ipcRenderer.invoke('app:copy-text', text),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  exitApp: () => ipcRenderer.invoke('app:exit'),
  exitBackupReady: () => ipcRenderer.invoke('app:exit-ready'),
  onExitRequest: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('app:exit-request', handler);
    return () => ipcRenderer.removeListener('app:exit-request', handler);
  },
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  setUpdateCredentials: (payload) => ipcRenderer.invoke('update:set-credentials', payload),
  clearUpdateCredentials: () => ipcRenderer.invoke('update:clear-credentials'),
  saveCloudUpdaterRecovery: (payload) => ipcRenderer.invoke('cloud-recovery:save', payload),
  loadCloudUpdaterRecovery: (email) => ipcRenderer.invoke('cloud-recovery:load', email),
  clearCloudUpdaterRecovery: () => ipcRenderer.invoke('cloud-recovery:clear'),
  getCloudAuthStorageItem: (key) => ipcRenderer.invoke('cloud-auth-storage:get', key),
  setCloudAuthStorageItem: (payload) => ipcRenderer.invoke('cloud-auth-storage:set', payload),
  removeCloudAuthStorageItem: (key) => ipcRenderer.invoke('cloud-auth-storage:remove', key),
  getCloudAuthSignedOut: () => ipcRenderer.invoke('cloud-auth-signout:get'),
  setCloudAuthSignedOut: (signedOut) => ipcRenderer.invoke('cloud-auth-signout:set', signedOut),
  saveCloudUpdaterDeviceToken: (payload) => ipcRenderer.invoke('cloud-updater-token:save', payload),
  loadCloudUpdaterDeviceToken: () => ipcRenderer.invoke('cloud-updater-token:load'),
  clearCloudUpdaterDeviceToken: () => ipcRenderer.invoke('cloud-updater-token:clear'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadAndInstallUpdate: () => ipcRenderer.invoke('update:downloadAndInstall'),
  onAuthCallback: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('auth:callback', handler);
    return () => ipcRenderer.removeListener('auth:callback', handler);
  },
  onUpdateEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('update:event', handler);
    return () => ipcRenderer.removeListener('update:event', handler);
  },
});
