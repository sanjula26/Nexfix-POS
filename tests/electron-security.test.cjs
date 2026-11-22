const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { createNavigationGuard } = require('../electron/navigation-security.cjs');
const { writeBufferFully } = require('../electron/write-buffer.cjs');
const {
  normalizeUpdaterDeviceCredential,
  parseStoredUpdaterDeviceCredential,
  buildUpdaterRequestHeaders,
  saveEncryptedUpdaterCredential,
  loadEncryptedUpdaterCredential,
  clearEncryptedUpdaterCredential,
} = require('../electron/updater-credentials.cjs');

const mainSource = fs.readFileSync(
  path.join(__dirname, '..', 'electron', 'main.cjs'),
  'utf8',
);

test('packaged navigation trusts only the exact renderer entrypoint', () => {
  const rendererPath = path.resolve('/nexfix-test/app/dist/index.html');
  const isAllowedNavigation = createNavigationGuard({
    isDev: false,
    devUrl: 'http://localhost:5173/',
    rendererPath,
  });

  assert.equal(isAllowedNavigation(pathToFileURL(rendererPath).href), true);
  assert.equal(
    isAllowedNavigation(pathToFileURL(path.resolve('/nexfix-test/app/other.html')).href),
    false,
  );
  assert.equal(isAllowedNavigation('file:///etc/passwd'), false);
  assert.equal(isAllowedNavigation('https://example.com/'), false);
});

test('development navigation is limited to the configured origin', () => {
  const isAllowedNavigation = createNavigationGuard({
    isDev: true,
    devUrl: 'http://localhost:5173/',
    rendererPath: '/unused-in-development/index.html',
  });

  assert.equal(isAllowedNavigation('http://localhost:5173/settings'), true);
  assert.equal(isAllowedNavigation('http://localhost:5174/'), false);
  assert.equal(isAllowedNavigation('https://localhost:5173/'), false);
  assert.equal(isAllowedNavigation('http://user@localhost:5173/'), false);
});

test('encrypted POS profile IPC is registered before renderer startup and locked on quit', () => {
  assert.match(mainSource, /require\('\.\/profile-ipc\.cjs'\)/);
  const ready = mainSource.indexOf("app.whenReady().then(()=>");
  const register = mainSource.indexOf("registerPOSProfileIpc({ ipcMain, dialog, BrowserWindow, safeStorage, isTrustedRenderer })");
  const create = mainSource.indexOf("setupAutoUpdater(); createWindow();", ready);
  assert.ok(ready >= 0 && register > ready && create > register,
    'profile IPC must be registered before the renderer window is created');
  assert.match(mainSource, /app\.on\('will-quit',\s*\(\)\s*=>\s*\{\s*try\s*\{\s*posProfileIpc\?\.lock\(\)/);
});

test('preload exposes only narrow POS profile IPC methods', () => {
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');
  for (const method of [
    'choosePOSStorageRoot', 'discoverPOSProfiles', 'createPOSProfile',
    'unlockPOSProfileWithPassphrase', 'unlockPOSProfileWithRecoveryKey',
    'getPOSProfileStatus', 'lockPOSProfile', 'readPOSProfileData',
    'writePOSProfileData', 'changePOSProfilePassphrase', 'resetPOSProfilePassphrase',
  ]) {
    assert.match(preloadSource, new RegExp('\\b' + method + ':'));
  }
  assert.doesNotMatch(preloadSource, /ipcRenderer\.send\s*\(/,
    'preload must use request/response IPC rather than exposing raw event sending');
});

test('Electron keeps the renderer sandboxed and isolated', () => {
  assert.match(
    mainSource,
    /webPreferences:\{[^}]*contextIsolation:true[^}]*nodeIntegration:false[^}]*sandbox:true[^}]*webSecurity:true\}/,
  );
});

test('privileged clipboard, external-open and exit IPC handlers reject untrusted frames', () => {
  for (const channel of ['app:copy-text', 'app:open-external', 'app:exit', 'app:exit-ready']) {
    const marker = `ipcMain.handle('${channel}'`;
    const start = mainSource.indexOf(marker);
    assert.notEqual(start, -1, `Missing IPC handler: ${channel}`);
    assert.match(
      mainSource.slice(start, start + 500),
      /isTrustedRenderer\(event\)/,
      `${channel} must verify the trusted main-frame URL`,
    );
  }
});


test('private updater writes every streamed installer byte despite partial file writes', async () => {
  const source = Buffer.from('nexfix-installer-bytes');
  const output = Buffer.alloc(source.length);
  let calls = 0;
  const handle = {
    async write(buffer, offset, length, position) {
      const bytesWritten = Math.min(3, length);
      buffer.copy(output, position, offset, offset + bytesWritten);
      calls += 1;
      return { bytesWritten };
    },
  };

  assert.equal(await writeBufferFully(handle, source, 0), source.length);
  assert.equal(output.toString(), source.toString());
  assert.ok(calls > 1, 'test handle should simulate partial writes');
  assert.match(mainSource, /writeBufferFully\(handle, buffer, total\)/);
});

test('private updater aborts when the installer file handle makes no write progress', async () => {
  const handle = { async write() { return { bytesWritten: 0 }; } };
  await assert.rejects(
    writeBufferFully(handle, Buffer.from('installer'), 0),
    /did not make forward progress/,
  );
});

test('updater device credential validation trims values and rejects missing, short or oversized credentials', () => {
  const token = 'a'.repeat(64);
  assert.deepEqual(normalizeUpdaterDeviceCredential({ token: ` ${token} `, deviceId: ' device-1 ' }), {
    token,
    deviceId: 'device-1',
  });
  assert.equal(normalizeUpdaterDeviceCredential({ token: 'short', deviceId: 'device-1' }), null);
  assert.equal(normalizeUpdaterDeviceCredential({ token: 'a'.repeat(513), deviceId: 'device-1' }), null);
  assert.equal(normalizeUpdaterDeviceCredential({ token, deviceId: '' }), null);
  assert.equal(normalizeUpdaterDeviceCredential({ token, deviceId: 'd'.repeat(201) }), null);
});

test('encrypted updater credential survives save/load and preserves unrelated secure recovery fields', () => {
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`encrypted:${value}`),
    decryptString: value => Buffer.from(value).toString().replace(/^encrypted:/, ''),
  };
  const token = 'b'.repeat(64);
  const saved = saveEncryptedUpdaterCredential(
    { token, deviceId: 'device-2' },
    safeStorage,
    { version: 1, cloudUpdaterRecovery: 'keep-this-encrypted-value' },
  );
  assert.equal(saved.ok, true);
  assert.equal(saved.record.cloudUpdaterRecovery, 'keep-this-encrypted-value');
  assert.equal(saved.record.version, 2);
  const loaded = loadEncryptedUpdaterCredential(saved.record, safeStorage);
  assert.deepEqual(loaded, { ok: true, found: true, token, deviceId: 'device-2' });
  assert.equal(JSON.stringify(saved.record).includes(token), false, 'plaintext token must not be persisted');
});

test('updater credential load fails closed for unavailable secure storage and corrupt ciphertext', () => {
  assert.deepEqual(loadEncryptedUpdaterCredential({}, { isEncryptionAvailable: () => false }), {
    ok: false,
    error: 'OS secure storage is unavailable',
  });
  const safeStorage = {
    isEncryptionAvailable: () => true,
    decryptString: () => { throw new Error('bad ciphertext'); },
  };
  assert.deepEqual(loadEncryptedUpdaterCredential({ cloudUpdaterDeviceToken: 'corrupt' }, safeStorage), {
    ok: false,
    error: 'Stored Windows updater authorization could not be opened',
  });
});

test('legacy token-only updater records load for renderer migration but cannot restore without a device id', () => {
  const token = 'c'.repeat(64);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    decryptString: () => token,
  };
  assert.deepEqual(loadEncryptedUpdaterCredential({ cloudUpdaterDeviceToken: 'legacy' }, safeStorage), {
    ok: true,
    found: true,
    token,
    deviceId: '',
  });
  assert.equal(parseStoredUpdaterDeviceCredential('short'), null);
});

test('updater request headers bind the token to the device and never fall back to public URLs', () => {
  const token = 'd'.repeat(64);
  assert.deepEqual(buildUpdaterRequestHeaders(token, 'device-3', 'device'), {
    'X-Nexfix-Update-Token': token,
    'X-Nexfix-Device': 'device-3',
    'Cache-Control': 'no-cache',
  });
  assert.deepEqual(buildUpdaterRequestHeaders('opaque-bearer', 'device-3', 'bearer'), {
    Authorization: 'Bearer opaque-bearer',
    'X-Nexfix-Device': 'device-3',
    'Cache-Control': 'no-cache',
  });
  assert.equal(buildUpdaterRequestHeaders('', 'device-3', 'device'), null);
  assert.match(mainSource, /UPDATE_FEED_URL = 'https:\/\/ocmzgamnehwbkuwkjdrr\.supabase\.co\/functions\/v1\/desktop-updates'/);
});

test('clearing updater credentials preserves the separate cloud recovery credential', () => {
  const cleared = clearEncryptedUpdaterCredential({
    version: 2,
    cloudUpdaterDeviceToken: 'encrypted-device-token',
    cloudUpdaterDeviceTokenVersion: 1,
    cloudUpdaterRecovery: 'encrypted-cloud-recovery',
  });
  assert.deepEqual(cleared, {
    version: 2,
    cloudUpdaterRecovery: 'encrypted-cloud-recovery',
  });
});

test('POS overflow folder IPC is registered before the renderer window is created', () => {
  assert.match(mainSource, /require\('\.\/overflow-folder\.cjs'\)/);
  const ready = mainSource.indexOf("app.whenReady().then(()=>");
  const register = mainSource.indexOf("registerOverflowFolderIpc({ app, ipcMain, dialog, BrowserWindow, isTrustedRenderer })");
  const create = mainSource.indexOf("setupAutoUpdater(); createWindow();", ready);
  assert.ok(ready >= 0 && register > ready && create > register,
    'overflow folder preference IPC must be registered before renderer startup');
});

test('preload exposes only scoped POS overflow-folder preference operations', () => {
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8');
  assert.match(preloadSource, /getPOSOverflowFolder:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('pos-overflow-folder:get'\)/);
  assert.match(preloadSource, /choosePOSOverflowFolder:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('pos-overflow-folder:choose'\)/);
  assert.doesNotMatch(preloadSource, /pos-overflow-folder:.*(?:write|delete|clear)/);
});

test('desktop startup gate is outside POSProvider and leaves browser development unaffected', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
  assert.match(appSource, /function POSApplication\(\)[\s\S]*?<POSProvider>/);
  const appRoot = appSource.slice(appSource.indexOf('export default function App()'));
  assert.match(appRoot, /<DesktopOverflowFolderSetup>[\s\S]*?<POSApplication\s*\/>/,
    'folder selection must wrap the POS application before POSProvider mounts');
  assert.match(appSource, /if\s*\(!desktopApi\?\.isDesktop\)\s*return\s*<>\{children\}<\/>/);
  assert.match(appSource, /IndexedDB will continue to store your normal POS data first/);
});

test('disconnected overflow folder does not block POS while IndexedDB remains the active store', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
  assert.match(appSource, /if \(folderStatus\?\.ok && folderStatus\.configured && !folderStatus\.available\)[\s\S]{0,1600}POS is continuing with IndexedDB/);
  assert.match(appSource, /POS is continuing with IndexedDB[\s\S]{0,1000}\{children\}/);
  assert.match(appSource, /POS is continuing with IndexedDB[\s\S]{0,1000}chooseFolder\(\)/);
  assert.match(appSource, /role="alert"[\s\S]{0,1000}POS is continuing with IndexedDB/);
});
