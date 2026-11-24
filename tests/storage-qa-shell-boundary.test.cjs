'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const qaMain = fs.readFileSync(path.join(root, 'electron/qa/main.cjs'), 'utf8');
const qaPreload = fs.readFileSync(path.join(root, 'electron/qa/preload.cjs'), 'utf8');
const qaHtml = fs.readFileSync(path.join(root, 'electron/qa/index.html'), 'utf8');
const qaRenderer = fs.readFileSync(path.join(root, 'electron/qa/renderer.cjs'), 'utf8');
const qaFolder = fs.readFileSync(path.join(root, 'electron/qa/prepare-qa-folder.cjs'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/windows-storage-overflow-qa-shell.yml'), 'utf8');

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('QA main process keeps isolated identity, local-only navigation and a narrow folder-picker IPC', () => {
  assert.match(qaMain, /app\.setName\(QA_APP_NAME\)/);
  assert.match(qaMain, /app\.setPath\('userData'/);
  assert.match(qaMain, /webRequest\.onBeforeRequest/);
  assert.match(qaMain, /callback\(\{ cancel: true \}\)/);
  assert.match(qaMain, /setPermissionRequestHandler/);
  assert.match(qaMain, /contextIsolation: true/);
  assert.match(qaMain, /nodeIntegration: false/);
  assert.match(qaMain, /sandbox: true/);
  assert.match(qaMain, /webSecurity: true/);
  assert.match(qaMain, /ipcMain\.handle\(QA_FOLDER_CHANNEL/);
  assert.match(qaMain, /event\.sender !== mainWindow\.webContents/);
  assert.match(qaMain, /properties: \['openDirectory'\]/);
  assert.match(qaMain, /prepareQaFolder/);
  assert.match(qaMain, /app\.getPath\('appData'\)/);
  assert.doesNotMatch(withoutComments(qaMain), /electron-updater|supabase|fetch\s*\(/i);
});

test('QA preload exposes only app identity and the single folder-selection method', () => {
  const executable = withoutComments(qaPreload);
  assert.match(executable, /exposeInMainWorld\('nexfixStorageQA'/);
  assert.match(executable, /chooseFolder:\s*\(\)\s*=>\s*ipcRenderer\.invoke/);
  assert.doesNotMatch(executable, /send\s*\(|fetch\s*\(|supabase|updater/i);
});

test('QA folder helper canonicalizes paths, rejects links, creates a new child and writes an exclusive sentinel', () => {
  assert.match(qaFolder, /fsApi\.realpath/);
  assert.match(qaFolder, /assertNoSymlinkComponents/);
  assert.match(qaFolder, /details\.isSymbolicLink\(\)/);
  assert.match(qaFolder, /mkdtemp/);
  assert.match(qaFolder, /open\(sentinelPath, 'wx'/);
  assert.match(qaFolder, /assertOutsideProtectedPaths/);
});

test('QA renderer uses the narrow preload method and never accesses Node APIs', () => {
  assert.match(qaHtml, /script-src 'self'/);
  assert.match(qaHtml, /connect-src 'none'/);
  assert.match(qaHtml, /<script src="\.\/renderer\.cjs"><\/script>/);
  assert.match(qaRenderer, /window\.nexfixStorageQA\.chooseFolder\(\)/);
  assert.doesNotMatch(qaRenderer, /require\s*\(|process\.|ipcRenderer|fetch\s*\(/);
});

test('QA Windows workflow builds isolated package and runs the folder safety tests', () => {
  assert.match(workflow, /--projectDir "\$env:GITHUB_WORKSPACE\/electron\/qa"/);
  assert.match(workflow, /verify:qa:asar/);
  assert.doesNotMatch(workflow, /upload-artifact|VITE_SUPABASE|SUPABASE_URL|R2|wrangler/i);
});
