'use strict';

// Build from the isolated QA app directory, not the production package root.
// The QA app directory has its own minimal package.json and no dependencies.
module.exports = {
  appId: 'com.nexfixsolution.pos.storageqa',
  productName: 'Nexfix POS Storage QA',
  executableName: 'Nexfix-POS-Storage-QA',
  directories: {
    app: 'electron/qa',
    output: 'release-qa',
  },
  asar: true,
};
