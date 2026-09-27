const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexfixDesktop', {
  isDesktop: true,
  isPackaged: process.defaultApp !== true,
  isPortable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke('app:version'),
  copyText: (text) => ipcRenderer.invoke('app:copy-text', text),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  setUpdateCredentials: (payload) => ipcRenderer.invoke('update:set-credentials', payload),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadAndInstallUpdate: () => ipcRenderer.invoke('update:downloadAndInstall'),
  downloadAuthorizedInstaller: () => ipcRenderer.invoke('update:downloadAuthorizedInstaller'),
  onUpdateEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('update:event', handler);
    return () => ipcRenderer.removeListener('update:event', handler);
  },
});
