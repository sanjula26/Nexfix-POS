const { contextBridge } = require('electron');

// Keep the renderer isolated from Node/Electron APIs. Add narrowly-scoped
// capabilities here only when the POS actually needs native functionality.
contextBridge.exposeInMainWorld('nexfixDesktop', {
  isDesktop: true,
  platform: process.platform,
});
