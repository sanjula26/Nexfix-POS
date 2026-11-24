'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const qaMain = fs.readFileSync(path.join(root, 'electron/qa/main.cjs'), 'utf8');
const qaPreload = fs.readFileSync(path.join(root, 'electron/qa/preload.cjs'), 'utf8');
const qaHtml = fs.readFileSync(path.join(root, 'electron/qa/index.html'), 'utf8');
const qaRenderer = fs.readFileSync(path.join(root, 'electron/qa/renderer.ts'), 'utf8');
const qaFolder = fs.readFileSync(path.join(root, 'electron/qa/prepare-qa-folder.cjs'), 'utf8');
const qaBuilder = fs.readFileSync(path.join(root, 'electron-builder.qa.cjs'), 'utf8');
const qaVite = fs.readFileSync(path.join(root, 'vite.config.qa.ts'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/windows-storage-overflow-qa-shell.yml'), 'utf8');

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('QA main process keeps isolated identity, local-only navigation and loads only its bundled renderer', () => {
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
  assert.match(qaMain, /prepareQaFolder/);
  assert.match(qaMain, /dist', 'index\.html/);
  assert.doesNotMatch(withoutComments(qaMain), /electron-updater|supabase|fetch\s*\(/i);
});

test('QA preload exposes only identity and disposable-folder selection', () => {
  const executable = withoutComments(qaPreload);
  assert.match(executable, /exposeInMainWorld\('nexfixStorageQA'/);
  assert.match(executable, /chooseFolder:\s*\(\)\s*=>\s*ipcRenderer\.invoke/);
  assert.doesNotMatch(executable, /send\s*\(|fetch\s*\(|supabase|updater/i);
});

test('QA folder helper canonicalizes paths, rejects links, creates a new child and exclusive sentinel', () => {
  assert.match(qaFolder, /fsApi\.realpath/);
  assert.match(qaFolder, /assertNoSymlinkComponents/);
  assert.match(qaFolder, /details\.isSymbolicLink\(\)/);
  assert.match(qaFolder, /mkdtemp/);
  assert.match(qaFolder, /open\(sentinelPath, 'wx'/);
  assert.match(qaFolder, /assertOutsideProtectedPaths/);
});

test('QA renderer injects once into its isolated IndexedDB and uses the shared production event contract', () => {
  assert.match(qaHtml, /default-src 'none'/);
  assert.match(qaHtml, /script-src 'self'/);
  assert.match(qaHtml, /connect-src 'none'/);
  assert.match(qaHtml, /type="module" src="\.\/renderer\.ts"/);
  assert.match(qaRenderer, /from '\.\.\/\.\.\/src\/lib\/storageOverflowEvents\.ts'/);
  assert.match(qaRenderer, /nexfix_storage_qa_fixture_v1/);
  assert.match(qaRenderer, /new DOMException\([^\n]*QuotaExceededError/);
  assert.match(qaRenderer, /transaction\.abort\(\)/);
  assert.match(qaRenderer, /dispatchStorageQuotaWarning\(window/);
  assert.match(qaRenderer, /subscribeToStorageQuotaWarnings\(window/);
  assert.match(qaRenderer, /injectionUsed/);
  assert.doesNotMatch(qaRenderer, /require\s*\(|process\.|ipcRenderer|fetch\s*\(|nexfixDesktop|supabase|electron-updater/i);
});

test('QA builder and Vite config package only the isolated compiled renderer', () => {
  assert.match(qaBuilder, /'dist\/\*\*\/\*'/);
  assert.match(qaBuilder, /'main\.cjs'/);
  assert.match(qaVite, /outDir: path\.join\(root, 'electron\/qa\/dist'\)/);
  assert.match(qaVite, /entryFileNames: 'assets\/qa-renderer\.js'/);
});

test('QA Windows workflow builds renderer and isolated package without cloud config or publishing', () => {
  assert.match(workflow, /npm run build:qa:renderer/);
  assert.match(workflow, /--projectDir "\$env:GITHUB_WORKSPACE\/electron\/qa"/);
  assert.match(workflow, /verify:qa:asar/);
  assert.doesNotMatch(workflow, /upload-artifact|VITE_SUPABASE|SUPABASE_URL|R2|wrangler/i);
});
