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
  PRIMARY_MARKER_FILE,
} = require('../electron/overflow-folder.cjs');
const { createManagedProfileDirectory } = require('../electron/storage-profile.cjs');

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
      storageMode: 'indexeddb',
      profileDirectoryName: null,
      profileId: null,
      available: true,
      folderPath: fs.realpathSync(selected),
      profileDirectory: null,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verified profile cutover persists folder-primary mode and can safely roll back before release', async () => {
  const root = temporaryDirectory();
  const userData = path.join(root, 'user-data');
  const selected = path.join(root, 'shop-data');
  fs.mkdirSync(selected);
  const manager = createOverflowFolderManager({
    app: { getPath: () => userData },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) },
    BrowserWindow: { getAllWindows: () => [] },
  });
  try {
    await manager.chooseFolder();
    const profile = createManagedProfileDirectory(selected, 'Nexfix POS Data', {
      profileId: require('node:crypto').randomUUID(),
      label: 'NexFix POS Storage',
    });
    const primary = manager.markPrimary(profile.directory, profile.manifest.profileId);
    assert.equal(primary.storageMode, 'folder_primary');
    assert.equal(primary.profileId, profile.manifest.profileId);
    assert.equal(primary.profileDirectoryName, 'Nexfix POS Data');
    assert.equal(primary.profileDirectory, profile.directory);

    const restarted = createOverflowFolderManager({
      app: { getPath: () => userData },
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) },
      BrowserWindow: { getAllWindows: () => [] },
    });
    assert.equal(restarted.getPreference().storageMode, 'folder_primary');
    assert.equal(restarted.getPreference().profileId, profile.manifest.profileId);

    const rolledBack = restarted.markIndexedDBPrimary(profile.manifest.profileId);
    assert.equal(rolledBack.storageMode, 'indexeddb');
    assert.equal(rolledBack.profileId, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('primary folder can only be rebound to a folder containing the same verified profile', async () => {
  const root = temporaryDirectory();
  const userData = path.join(root, 'user-data');
  const selected = path.join(root, 'shop-data');
  const replacement = path.join(root, 'replacement-drive');
  const wrong = path.join(root, 'wrong-drive');
  fs.mkdirSync(selected);
  fs.mkdirSync(replacement);
  fs.mkdirSync(wrong);
  const profile = createManagedProfileDirectory(selected, 'Nexfix POS Data', {
    profileId: require('node:crypto').randomUUID(),
    label: 'NexFix POS Storage',
  });
  fs.cpSync(profile.directory, path.join(replacement, 'Nexfix POS Data'), { recursive: true });
  // The primary marker lives at the storage-folder root and must travel with the profile.
  let nextSelection = wrong;
  const manager = createOverflowFolderManager({
    app: { getPath: () => userData },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [nextSelection] }) },
    BrowserWindow: { getAllWindows: () => [] },
  });
  try {
    await manager.chooseFolder();
    manager.markPrimary(profile.directory, profile.manifest.profileId);
    fs.copyFileSync(path.join(selected, PRIMARY_MARKER_FILE), path.join(replacement, PRIMARY_MARKER_FILE));
    await assert.rejects(manager.chooseFolder(), /does not contain the configured primary POS profile/);
    assert.equal(manager.getPreference().storageMode, 'folder_primary');
    nextSelection = replacement;
    const reconnected = await manager.chooseFolder();
    assert.equal(reconnected.storageMode, 'folder_primary');
    assert.equal(reconnected.profileId, profile.manifest.profileId);
    assert.equal(reconnected.folderPath, fs.realpathSync(replacement));
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

test('primary marker recovers folder-primary mode when the local config file is lost', async () => {
  const root = temporaryDirectory();
  const userData = path.join(root, 'user-data');
  const selected = path.join(root, 'shop-data');
  fs.mkdirSync(selected);
  const app = { getPath: () => userData };
  const BrowserWindow = { getAllWindows: () => [] };
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) };
  const manager = createOverflowFolderManager({ app, dialog, BrowserWindow });
  try {
    await manager.chooseFolder();
    const profile = createManagedProfileDirectory(selected, 'Nexfix POS Data', {
      profileId: require('node:crypto').randomUUID(),
      label: 'NexFix POS Storage',
    });
    manager.markPrimary(profile.directory, profile.manifest.profileId);
    assert.equal(fs.existsSync(path.join(selected, PRIMARY_MARKER_FILE)), true);

    fs.unlinkSync(manager.configPath);
    const afterConfigLoss = createOverflowFolderManager({ app, dialog, BrowserWindow });
    assert.equal(afterConfigLoss.getPreference().configured, false);
    const recovered = await afterConfigLoss.chooseFolder();
    assert.equal(recovered.storageMode, 'folder_primary');
    assert.equal(recovered.profileId, profile.manifest.profileId);
    assert.equal(recovered.available, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('primary mode fails closed if its durable folder marker disappears', async () => {
  const root = temporaryDirectory();
  const userData = path.join(root, 'user-data');
  const selected = path.join(root, 'shop-data');
  fs.mkdirSync(selected);
  const manager = createOverflowFolderManager({
    app: { getPath: () => userData },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) },
    BrowserWindow: { getAllWindows: () => [] },
  });
  try {
    await manager.chooseFolder();
    const profile = createManagedProfileDirectory(selected, 'Nexfix POS Data', {
      profileId: require('node:crypto').randomUUID(),
      label: 'NexFix POS Storage',
    });
    manager.markPrimary(profile.directory, profile.manifest.profileId);
    fs.unlinkSync(path.join(selected, PRIMARY_MARKER_FILE));
    fs.rmSync(profile.directory, { recursive: true, force: true });
    const status = manager.getPreference();
    assert.equal(status.storageMode, 'folder_primary');
    assert.equal(status.available, false);
    assert.match(status.error, /does not contain the configured primary POS profile/);
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
