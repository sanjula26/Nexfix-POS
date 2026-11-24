const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const packageJson = require('../package.json');
const productionMain = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
const productionPreload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');

test('production Electron package keeps its identity and explicitly excludes the QA app directory', () => {
  assert.equal(packageJson.main, 'electron/main.cjs');
  assert.equal(packageJson.build.appId, 'com.nexfixsolution.pos');
  assert.ok(packageJson.build.files.includes('electron/**/*'));
  assert.ok(packageJson.build.files.includes('!electron/qa/**'));
});

test('production main and preload do not expose or activate the isolated QA shell', () => {
  assert.doesNotMatch(productionMain, /nexfixStorageQA|qa:/);
  assert.doesNotMatch(productionPreload, /nexfixStorageQA|qa:/);
});
