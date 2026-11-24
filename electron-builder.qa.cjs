'use strict';

const path = require('node:path');
const lock = require('./package-lock.json');

// This config is invoked with --projectDir electron/qa. That makes the QA
// package.json the only app manifest considered for production dependencies.
// Electron itself is resolved from the root lockfile used by the build tools.
module.exports = {
  appId: 'com.nexfixsolution.pos.storageqa',
  productName: 'Nexfix POS Storage QA',
  executableName: 'Nexfix-POS-Storage-QA',
  electronVersion: lock.packages['node_modules/electron'].version,
  directories: {
    app: '.',
    output: path.join(__dirname, 'release-qa'),
  },
  files: ['main.cjs', 'preload.cjs', 'package.json', 'prepare-qa-folder.cjs', 'folder-guard.cjs', 'dist/**/*'],
  npmRebuild: false,
  asar: true,
};
