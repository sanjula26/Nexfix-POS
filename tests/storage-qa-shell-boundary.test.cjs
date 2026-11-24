const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const qaPackage = require('../electron/qa/package.json');
const qaBuilder = require('../electron-builder.qa.cjs');
const qaMain = fs.readFileSync(path.join(root, 'electron/qa/main.cjs'), 'utf8');
const qaPreload = fs.readFileSync(path.join(root, 'electron/qa/preload.cjs'), 'utf8');
const qaHtml = fs.readFileSync(path.join(root, 'electron/qa/index.html'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/windows-storage-overflow-qa-shell.yml'), 'utf8');

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('QA app has a separate identity, entry point, user-data directory and minimal package', () => {
  assert.equal(qaBuilder.appId, 'com.nexfixsolution.pos.storageqa');
  assert.notEqual(qaBuilder.appId, require('../package.json').build.appId);
  assert.equal(qaBuilder.productName, 'Nexfix POS Storage QA');
  assert.equal(qaBuilder.executableName, 'Nexfix-POS-Storage-QA');
  assert.equal(qaBuilder.directories.app, 'electron/qa');
  assert.equal(qaBuilder.directories.output, 'release-qa');
  assert.equal(qaPackage.main, 'main.cjs');
  assert.deepEqual(qaPackage.dependencies || {}, {});
});

test('QA main process uses a separate userData path and blocks remote navigation and network requests', () => {
  assert.match(qaMain, /app\.setName\(QA_APP_NAME\)/);
  assert.match(qaMain, /app\.setPath\('userData',\s*path\.join\(app\.getPath\('appData'\),\s*QA_USER_DATA_DIRECTORY\)\)/);
  assert.match(qaMain, /webRequest\.onBeforeRequest/);
  assert.match(qaMain, /callback\(\{ cancel: true \}\)/);
  assert.match(qaMain, /setPermissionRequestHandler/);
  assert.match(qaMain, /contextIsolation: true/);
  assert.match(qaMain, /nodeIntegration: false/);
  assert.match(qaMain, /sandbox: true/);
  assert.match(qaMain, /webSecurity: true/);
  const executableMain = withoutComments(qaMain);
  assert.doesNotMatch(executableMain, /require\(['"]\.\.\/main\.cjs|electron-updater|supabase|fetch\s*\(/i);
});

test('QA preload exposes only an identity bridge and no IPC or production methods', () => {
  const executablePreload = withoutComments(qaPreload);
  assert.match(executablePreload, /exposeInMainWorld\('nexfixStorageQA'/);
  assert.doesNotMatch(executablePreload, /ipcRenderer|ipcMain|invoke\s*\(|send\s*\(|fetch\s*\(|supabase|updater/i);
});

test('QA renderer is a local static page with a restrictive no-network CSP', () => {
  assert.match(qaHtml, /Content-Security-Policy/);
  assert.match(qaHtml, /connect-src 'none'/);
  assert.match(qaHtml, /default-src 'none'/);
  assert.doesNotMatch(qaHtml, /<script|https?:\/\/|<iframe|<webview/i);
});

test('QA Windows workflow builds locally without cloud configuration or artifact upload', () => {
  assert.match(workflow, /electron-builder\.qa\.cjs/);
  assert.match(workflow, /verify:qa:asar/);
  assert.doesNotMatch(workflow, /upload-artifact|VITE_SUPABASE|SUPABASE_URL|R2|wrangler/i);
});
