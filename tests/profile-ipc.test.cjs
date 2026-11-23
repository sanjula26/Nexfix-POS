'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { registerPOSProfileIpc } = require('../electron/profile-ipc.cjs');
const { createMigrationJournal } = require('../electron/profile-migration.cjs');

function safeStorage(prefix = 'dpapi:') {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'dpapi',
    encryptString: value => Buffer.from(prefix + value, 'utf8'),
    decryptString: value => {
      const text = Buffer.from(value).toString('utf8');
      if (!text.startsWith(prefix)) throw new Error('wrong device');
      return text.slice(prefix.length);
    },
  };
}

function setup(t, useConfiguredRoot = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexfix-profile-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) };
  const BrowserWindow = { getAllWindows: () => [] };
  let trusted = true;
  const api = registerPOSProfileIpc({
    ipcMain, dialog, BrowserWindow, safeStorage: safeStorage(),
    isTrustedRenderer: () => trusted, platform: 'linux',
    getConfiguredStorageRoot: useConfiguredRoot ? () => ({ ok: true, configured: true, available: true, folderPath: root }) : undefined,
  });
  const event = { sender: { mainFrame: {} }, senderFrame: {} };
  const call = (channel, payload) => handlers.get(channel)(event, payload);
  return { root, handlers, api, call, setTrusted: value => { trusted = value; } };
}

test('registers only scoped profile operations and rejects untrusted renderer frames', async (t) => {
  const ctx = setup(t);
  assert.ok(ctx.handlers.has('pos-profile:choose-storage-root'));
  assert.ok(ctx.handlers.has('pos-profile:read'));
  assert.ok(ctx.handlers.has('pos-profile:write'));
  ctx.setTrusted(false);
  const denied = await ctx.call('pos-profile:status');
  assert.deepEqual(denied, { ok: false, error: 'Untrusted renderer.' });
  ctx.setTrusted(true);
});

test('trusted IPC supports choose, discover, create, encrypted read/write, lock and unlock', async (t) => {
  const ctx = setup(t);
  const selected = await ctx.call('pos-profile:choose-storage-root');
  assert.equal(selected.ok, true);
  assert.equal(selected.storageRoot, ctx.root);

  const empty = await ctx.call('pos-profile:discover', { storageRoot: ctx.root });
  assert.equal(empty.ok, true);
  assert.equal(empty.available.length, 0);

  const created = await ctx.call('pos-profile:create', {
    storageRoot: ctx.root,
    directoryName: 'Main POS',
    label: 'NexFix Main Shop',
    passphrase: 'Nexfix-IPC-Lock-2026',
  });
  assert.equal(created.ok, true);
  assert.match(created.recoveryKey, /^[A-Za-z0-9_-]{40,}$/);

  const saved = await ctx.call('pos-profile:write', {
    purpose: 'app_state',
    payload: JSON.stringify({ products: [{ id: 'one' }] }),
  });
  assert.equal(saved.ok, true);
  const loaded = await ctx.call('pos-profile:read', { purpose: 'app_state' });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.found, true);
  assert.equal(loaded.payload, JSON.stringify({ products: [{ id: 'one' }] }));

  const journalPayload = JSON.stringify(createMigrationJournal(created.profile.profileId, '2026-11-22T08:00:00.000Z'));
  const journal = await ctx.call('pos-profile:write', {
    purpose: 'migration_journal',
    payload: journalPayload,
  });
  assert.equal(journal.ok, true);
  const loadedJournal = await ctx.call('pos-profile:read', { purpose: 'migration_journal' });
  assert.equal(loadedJournal.ok, true);
  assert.equal(loadedJournal.payload, journalPayload);

  await ctx.call('pos-profile:lock');
  const lockedRead = await ctx.call('pos-profile:read', { purpose: 'app_state' });
  assert.equal(lockedRead.ok, false);
  assert.match(lockedRead.error, /No POS profile is unlocked/);

  const found = await ctx.call('pos-profile:discover', { storageRoot: ctx.root });
  assert.equal(found.available.length, 1);
  const autoUnlocked = await ctx.call('pos-profile:unlock-os', { directory: created.profile.directory });
  assert.equal(autoUnlocked.ok, true);
  assert.equal((await ctx.call('pos-profile:status')).unlocked, true);
  await ctx.call('pos-profile:lock');
  const unlocked = await ctx.call('pos-profile:unlock-passphrase', {
    directory: created.profile.directory,
    secret: 'Nexfix-IPC-Lock-2026',
  });
  assert.equal(unlocked.ok, true);
  assert.equal((await ctx.call('pos-profile:status')).unlocked, true);
});

test('uses the already-selected overflow folder without opening a second folder chooser', async (t) => {
  const ctx = setup(t, true);
  const found = await ctx.call('pos-profile:discover', { storageRoot: ctx.root });
  assert.equal(found.ok, true);
  assert.equal(found.available.length, 0);
  const created = await ctx.call('pos-profile:create', {
    storageRoot: ctx.root,
    directoryName: 'Overflow Profile',
    label: 'NexFix Overflow Shop',
    passphrase: 'Nexfix-IPC-Lock-2026',
  });
  assert.equal(created.ok, true);
  assert.equal(ctx.api.session.getStatus().unlocked, true);
});

test('IPC refuses arbitrary paths and does not permit multiple active profiles', async (t) => {
  const ctx = setup(t);
  await ctx.call('pos-profile:choose-storage-root');
  const created = await ctx.call('pos-profile:create', {
    storageRoot: ctx.root,
    directoryName: 'Main POS',
    label: 'NexFix Main Shop',
    passphrase: 'Nexfix-IPC-Lock-2026',
  });
  const outside = await ctx.call('pos-profile:unlock-passphrase', {
    directory: path.dirname(ctx.root),
    secret: 'Nexfix-IPC-Lock-2026',
  });
  assert.equal(outside.ok, false);
  assert.match(outside.error, /Scan the selected/);

  const second = await ctx.call('pos-profile:create', {
    storageRoot: ctx.root,
    directoryName: 'Second POS',
    label: 'Second Shop',
    passphrase: 'Nexfix-IPC-Lock-2026',
  });
  assert.equal(second.ok, false);
  assert.match(second.error, /Lock the currently open/);
  assert.equal(created.ok, true);
});
