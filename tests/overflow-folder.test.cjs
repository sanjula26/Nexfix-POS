'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  validateFolder,
  createOverflowFolderManager,
  registerOverflowFolderIpc,
} = require('../electron/overflow-folder.cjs');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nexfix-overflow-test-'));
}

test('overflow folder validation accepts a writable existing directory and removes its probe', () => {
  const root = temporaryDirectory();
  const selected = path.join(root, 'selected');
  fs.mkdirSync(selected);
  try {
    assert.equal(validateFolder(selected), fs.realpathSync(selected));
    assert.deepEqual(fs.readdirSync(selected), [], 'temporary write-check file must be removed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('overflow folder validation rejects UNC network locations before filesystem access', () => {
  assert.throws(
    () => validateFolder('\\\\server\\share\\nexfix-pos'),
    /Network folders are not supported/,
  );
});

test('overflow folder validation rejects missing paths, files, drive roots and symbolic links', (t) => {
  const root = temporaryDirectory();
  const file = path.join(root, 'file.txt');
  const link = path.join(root, 'link');
  fs.writeFileSync(file, 'not a folder');
  try {
    assert.throws(() => validateFolder(path.join(root, 'missing')), /unavailable/);
    assert.throws(() => validateFolder(file), /normal folder/);
    assert.throws(() => validateFolder(path.parse(root).root), /drive root/);
    try {
      fs.symlinkSync(root, link, 'dir');
      assert.throws(() => validateFolder(link), /normal folder/);
    } catch (error) {
      if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.diagnostic('Symbolic link creation is not permitted in this test environment.');
      } else {
        throw error;
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('selected overflow folder preference persists across manager instances', async () => {
  const root = temporaryDirectory();
  const userData = path.join(root, 'user-data');
  const selected = path.join(root, 'shop-data');
  fs.mkdirSync(selected);
  const app = { getPath: () => userData };
  const BrowserWindow = { getAllWindows: () => [] };
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) };
  try {
    const first = createOverflowFolderManager({ app, dialog, BrowserWindow });
    const chosen = await first.chooseFolder();
    assert.equal(chosen.ok, true);
    assert.equal(chosen.canceled, false);
    assert.equal(chosen.folderPath, fs.realpathSync(selected));
    const afterRestart = createOverflowFolderManager({ app, dialog, BrowserWindow });
    assert.deepEqual(afterRestart.getPreference(), {
      ok: true,
      configured: true,
      available: true,
      folderPath: fs.realpathSync(selected),
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cancelled folder selection preserves the previously saved destination', async () => {
  const root = temporaryDirectory();
  const userData = path.join(root, 'user-data');
  const selected = path.join(root, 'shop-data');
  fs.mkdirSync(selected);
  const app = { getPath: () => userData };
  const BrowserWindow = { getAllWindows: () => [] };
  let canceled = false;
  const dialog = { showOpenDialog: async () => canceled
    ? ({ canceled: true, filePaths: [] })
    : ({ canceled: false, filePaths: [selected] }) };
  try {
    const manager = createOverflowFolderManager({ app, dialog, BrowserWindow });
    await manager.chooseFolder();
    canceled = true;
    const result = await manager.chooseFolder();
    assert.equal(result.canceled, true);
    assert.equal(result.folderPath, fs.realpathSync(selected));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('saved destination reports unavailable when its drive or folder disappears', async () => {
  const root = temporaryDirectory();
  const userData = path.join(root, 'user-data');
  const selected = path.join(root, 'shop-data');
  fs.mkdirSync(selected);
  const app = { getPath: () => userData };
  const BrowserWindow = { getAllWindows: () => [] };
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) };
  try {
    const manager = createOverflowFolderManager({ app, dialog, BrowserWindow });
    await manager.chooseFolder();
    fs.rmSync(selected, { recursive: true, force: true });
    const status = manager.getPreference();
    assert.equal(status.configured, true);
    assert.equal(status.available, false);
    assert.match(status.error, /unavailable/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('overflow folder IPC rejects untrusted renderer calls and only registers scoped methods', async () => {
  const root = temporaryDirectory();
  const selected = path.join(root, 'selected');
  fs.mkdirSync(selected);
  const handlers = new Map();
  const manager = registerOverflowFolderIpc({
    app: { getPath: () => path.join(root, 'user-data') },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) },
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    isTrustedRenderer: event => event?.trusted === true,
  });
  try {
    assert.deepEqual([...handlers.keys()].sort(), [
      'pos-overflow-folder:choose',
      'pos-overflow-folder:get',
    ]);
    const get = handlers.get('pos-overflow-folder:get');
    assert.deepEqual(await get({ trusted: false }), { ok: false, error: 'Untrusted renderer.' });
    const chosen = await handlers.get('pos-overflow-folder:choose')({ trusted: true });
    assert.equal(chosen.ok, true);
    assert.equal(manager.getPreference().available, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
