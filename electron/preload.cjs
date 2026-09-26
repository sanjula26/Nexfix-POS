const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexfixDesktop', {
  isDesktop: true,
  isPackaged: process.defaultApp !== true,
  isPortable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadAndInstallUpdate: () => ipcRenderer.invoke('update:downloadAndInstall'),
  onUpdateEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('update:event', handler);
    return () => ipcRenderer.removeListener('update:event', handler);
  },
});
