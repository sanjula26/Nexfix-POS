const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexfixDesktop', {
  isDesktop: true,
  isPackaged: process.defaultApp !== true,
  isPortable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
  platform: process.platform,
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
