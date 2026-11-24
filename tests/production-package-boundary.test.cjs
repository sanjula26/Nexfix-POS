'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const productionMain = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
const productionPreload = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');

test('production Electron packaging explicitly excludes the isolated QA directory', () => {
  const files = packageJson.build?.files;
  assert.ok(Array.isArray(files), 'electron-builder production files list must be explicit');
  const includeIndex = files.indexOf('electron/**/*');
  const excludeIndex = files.indexOf('!electron/qa/**');

  assert.notEqual(includeIndex, -1, 'production package must include its Electron runtime');
  assert.notEqual(excludeIndex, -1, 'production package must explicitly exclude electron/qa/**');
  assert.ok(excludeIndex > includeIndex, 'QA exclusion must follow the broad Electron include');
  assert.equal(packageJson.main, 'electron/main.cjs', 'production entry point must remain unchanged');
  assert.equal(packageJson.build.appId, 'com.nexfixsolution.pos', 'production app ID must remain unchanged');
});

test('production Electron main and preload contain no QA-only IPC channels or bridge methods', () => {
  for (const [label, source] of [
    ['electron/main.cjs', productionMain],
    ['electron/preload.cjs', productionPreload],
  ]) {
    assert.doesNotMatch(source, /(?:ipcMain\.handle|ipcRenderer\.invoke)\s*\(\s*['"]qa:/i,
      label + ' must not register or expose QA IPC channels');
    assert.doesNotMatch(source, /\bqa[A-Z][A-Za-z0-9_]*\s*:/,
      label + ' must not expose QA bridge methods');
  }
});
