'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync, spawn } = require('node:child_process');
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

function setup(t, useConfiguredRoot = false, configuredAvailable = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexfix-profile-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  let dialogCalls = 0;
  const dialog = { showOpenDialog: async () => {
    dialogCalls += 1;
    return { canceled: false, filePaths: [root] };
  } };
  const BrowserWindow = { getAllWindows: () => [] };
  let trusted = true;
  const api = registerPOSProfileIpc({
    ipcMain, dialog, BrowserWindow, safeStorage: safeStorage(),
    isTrustedRenderer: () => trusted, platform: 'linux',
    getConfiguredStorageRoot: useConfiguredRoot ? () => ({ ok: true, configured: true, available: configuredAvailable, folderPath: root }) : undefined,
    markOverflowFolderPrimary: (directory, profileId) => ({ ok: true, available: true, storageMode: 'folder_primary', profileId, profileDirectory: directory }),
    markOverflowFolderIndexedDBPrimary: () => ({ ok: true, storageMode: 'indexeddb' }),
  });
  const event = { sender: { mainFrame: {} }, senderFrame: {} };
  const call = (channel, payload) => handlers.get(channel)(event, payload);
  return { root, handlers, api, call, setTrusted: value => { trusted = value; }, dialogCalls: () => dialogCalls };
}

test('new POS profile is not persisted until recovery-key acknowledgement and passphrase verification', async (t) => {
  const ctx = setup(t);
  await ctx.call('pos-profile:choose-storage-root');
  const prepared = await ctx.call('pos-profile:prepare-create', {
    storageRoot: ctx.root,
    directoryName: 'Acknowledged POS',
    label: 'NexFix Acknowledged Shop',
    passphrase: 'Nexfix-IPC-Lock-2026',
  });
  assert.equal(prepared.ok, true);
  assert.match(prepared.pendingId, /^[A-Za-z0-9_-]{40,}$/);
  assert.match(prepared.recoveryKey, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(fs.existsSync(prepared.profile.directory), false);

  const discoveryBeforeAck = await ctx.call('pos-profile:discover', { storageRoot: ctx.root });
  assert.equal(discoveryBeforeAck.available.length, 0);
  const pending = await ctx.call('pos-profile:pending-create');
  assert.equal(pending.pending, true);
  assert.equal(pending.recoveryKey, prepared.recoveryKey);

  const changedFolder = await ctx.call('pos-profile:finalize-create', {
    pendingId: prepared.pendingId,
    storageRoot: path.dirname(ctx.root),
    passphrase: 'Nexfix-IPC-Lock-2026',
    acknowledged: true,
  });
  assert.equal(changedFolder.ok, false);
  assert.match(changedFolder.error, /storage folder changed/);
  assert.equal(fs.existsSync(prepared.profile.directory), false);

  const noAck = await ctx.call('pos-profile:finalize-create', {
    pendingId: prepared.pendingId,
    storageRoot: ctx.root,
    passphrase: 'Nexfix-IPC-Lock-2026',
    acknowledged: false,
  });
  assert.equal(noAck.ok, false);
  assert.match(noAck.error, /Confirm that the recovery key has been saved/);
  assert.equal(fs.existsSync(prepared.profile.directory), false);

  const wrongPassphrase = await ctx.call('pos-profile:finalize-create', {
    pendingId: prepared.pendingId,
    storageRoot: ctx.root,
    passphrase: 'Wrong-Storage-Passphrase-2026',
    acknowledged: true,
  });
  assert.equal(wrongPassphrase.ok, false);
  assert.equal(fs.existsSync(prepared.profile.directory), false);

  const finalized = await ctx.call('pos-profile:finalize-create', {
    pendingId: prepared.pendingId,
    storageRoot: ctx.root,
    passphrase: 'Nexfix-IPC-Lock-2026',
    acknowledged: true,
  });
  assert.equal(finalized.ok, true);
  assert.equal(finalized.profile.profileId, prepared.profile.profileId);
  assert.equal(fs.existsSync(path.join(prepared.profile.directory, 'nexfix-profile.json')), true);
  assert.equal(fs.existsSync(path.join(prepared.profile.directory, 'nexfix-key-envelope.json')), true);
  assert.equal((await ctx.call('pos-profile:status')).unlocked, true);
  assert.equal((await ctx.call('pos-profile:pending-create')).pending, false);
});

test('interrupted unacknowledged profile setup leaves no unusable profile on disk', async (t) => {
  const ctx = setup(t);
  await ctx.call('pos-profile:choose-storage-root');
  const prepared = await ctx.call('pos-profile:prepare-create', {
    storageRoot: ctx.root,
    directoryName: 'Interrupted Setup',
    label: 'NexFix Interrupted Setup',
    passphrase: 'Nexfix-IPC-Lock-2026',
  });
  assert.equal(prepared.ok, true);
  assert.equal(fs.existsSync(prepared.profile.directory), false);
  ctx.api.clearSelections();

  const handlers = new Map();
  registerPOSProfileIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [ctx.root] }) },
    BrowserWindow: { getAllWindows: () => [] },
    safeStorage: safeStorage(),
    isTrustedRenderer: () => true,
    platform: 'linux',
  });
  const event = { sender: { mainFrame: {} }, senderFrame: {} };
  const callAfterRestart = (channel, payload) => handlers.get(channel)(event, payload);
  await callAfterRestart('pos-profile:choose-storage-root');
  const discovered = await callAfterRestart('pos-profile:discover', { storageRoot: ctx.root });
  assert.equal(discovered.ok, true);
  assert.equal(discovered.available.length, 0);
  assert.deepEqual(fs.readdirSync(ctx.root), []);
  assert.equal((await callAfterRestart('pos-profile:pending-create')).pending, false);
});

test('a separate Node process can exit before acknowledgement without persisting profile files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexfix-pending-profile-process-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const childScript = String.raw`
    'use strict';
    const fs = require('node:fs');
    const { registerPOSProfileIpc } = require('./electron/profile-ipc.cjs');
    const root = process.argv[1];
    const handlers = new Map();
    registerPOSProfileIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) },
      BrowserWindow: { getAllWindows: () => [] },
      safeStorage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'dpapi',
        encryptString: value => Buffer.from('dpapi:' + value, 'utf8'),
        decryptString: value => {
          const text = Buffer.from(value).toString('utf8');
          if (!text.startsWith('dpapi:')) throw new Error('wrong device');
          return text.slice(6);
        },
      },
      isTrustedRenderer: () => true,
      platform: 'linux',
    });
    const event = { sender: { mainFrame: {} }, senderFrame: {} };
    const call = (channel, payload) => handlers.get(channel)(event, payload);
    (async () => {
      await call('pos-profile:choose-storage-root');
      const prepared = await call('pos-profile:prepare-create', {
        storageRoot: root,
        directoryName: 'Process Interrupted',
        label: 'NexFix Process Interrupted',
        passphrase: 'Nexfix-IPC-Lock-2026',
      });
      if (!prepared.ok) throw new Error(prepared.error);
      if (fs.existsSync(prepared.profile.directory)) throw new Error('Profile directory exists before acknowledgement.');
      process.stdout.write('PREPARED_WITHOUT_DISK_PROFILE');
    })().catch(error => {
      process.stderr.write(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    });
  `;
  const output = execFileSync(process.execPath, ['-e', childScript, root], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  assert.equal(output, 'PREPARED_WITHOUT_DISK_PROFILE');
  assert.deepEqual(fs.readdirSync(root), []);
});

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

test('migration journal IPC enforces copy, verification and cutover ordering', async (t) => {
  const ctx = setup(t);
  await ctx.call('pos-profile:choose-storage-root');
  const created = await ctx.call('pos-profile:create', {
    storageRoot: ctx.root,
    directoryName: 'Migration POS',
    label: 'NexFix Migration Shop',
    passphrase: 'Nexfix-IPC-Lock-2026',
  });
  assert.equal(created.ok, true);

  const started = await ctx.call('pos-profile:migration:begin');
  assert.equal(started.ok, true);
  assert.equal(started.journal.phase, 'snapshotting');
  const invalidCutover = await ctx.call('pos-profile:migration:transition', { nextPhase: 'folder_primary' });
  assert.equal(invalidCutover.ok, false);

  const copying = await ctx.call('pos-profile:migration:transition', { nextPhase: 'copying' });
  assert.equal(copying.journal.phase, 'copying');
  const purposes = ['app_state', 'sync_queue', 'meta', 'restore_checkpoint'];
  const details = { revision: 1, bytes: 12, sha256: 'a'.repeat(64) };
  for (const purpose of purposes) {
    const result = await ctx.call('pos-profile:migration:record-copy', { purpose, details });
    assert.equal(result.ok, true);
  }

  const verifying = await ctx.call('pos-profile:migration:transition', { nextPhase: 'verifying' });
  assert.equal(verifying.journal.phase, 'verifying');
  for (const purpose of purposes) {
    const result = await ctx.call('pos-profile:migration:record-verification', { purpose, details });
    assert.equal(result.ok, true);
  }

  const ready = await ctx.call('pos-profile:migration:transition', { nextPhase: 'ready_to_cutover' });
  assert.equal(ready.journal.phase, 'ready_to_cutover');
  const primary = await ctx.call('pos-profile:migration:transition', { nextPhase: 'folder_primary' });
  assert.equal(primary.journal.phase, 'folder_primary');
  const restarted = await ctx.call('pos-profile:migration:begin');
  assert.equal(restarted.ok, false);
  assert.match(restarted.error, /already the primary storage/);
});

test('uses the already-selected overflow folder without opening a second folder chooser', async (t) => {
  const ctx = setup(t, true);
  const chosen = await ctx.call('pos-profile:choose-storage-root');
  assert.equal(chosen.ok, true);
  assert.equal(chosen.storageRoot, ctx.root);
  assert.equal(chosen.reusedConfiguredFolder, true);
  assert.equal(ctx.dialogCalls(), 0);
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

test('does not allow a different profile folder while the configured overflow drive is unavailable', async (t) => {
  const ctx = setup(t, true, false);
  const selected = await ctx.call('pos-profile:choose-storage-root');
  assert.equal(selected.ok, false);
  assert.match(selected.error, /Reconnect the selected POS overflow folder/);
  const created = await ctx.call('pos-profile:create', {
    storageRoot: ctx.root,
    directoryName: 'Wrong Folder',
    label: 'NexFix Shop',
    passphrase: 'Nexfix-IPC-Lock-2026',
  });
  assert.equal(created.ok, false);
  assert.match(created.error, /Choose the POS storage folder/);
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


test('reopening an interrupted pre-cutover profile starts a fresh journal from the IndexedDB source', async (t) => {
  const purposes = ['app_state', 'sync_queue', 'meta', 'restore_checkpoint'];
  const details = { revision: 1, bytes: 12, sha256: 'a'.repeat(64) };

  for (const interruptedPhase of ['snapshotting', 'copying', 'verifying', 'ready_to_cutover']) {
    const ctx = setup(t);
    await ctx.call('pos-profile:choose-storage-root');
    const created = await ctx.call('pos-profile:create', {
      storageRoot: ctx.root,
      directoryName: 'Interrupted ' + interruptedPhase,
      label: 'Disposable interrupted migration',
      passphrase: 'Nexfix-IPC-Lock-2026',
    });
    assert.equal(created.ok, true, interruptedPhase);

    const started = await ctx.call('pos-profile:migration:begin');
    assert.equal(started.ok, true, interruptedPhase);
    if (interruptedPhase !== 'snapshotting') {
      await ctx.call('pos-profile:migration:transition', { nextPhase: 'copying' });
      const copyCount = interruptedPhase === 'copying' ? 1 : purposes.length;
      for (const purpose of purposes.slice(0, copyCount)) {
        const copied = await ctx.call('pos-profile:migration:record-copy', { purpose, details });
        assert.equal(copied.ok, true, interruptedPhase + ':' + purpose);
      }
    }
    if (interruptedPhase === 'verifying' || interruptedPhase === 'ready_to_cutover') {
      await ctx.call('pos-profile:migration:transition', { nextPhase: 'verifying' });
      const verificationCount = interruptedPhase === 'verifying' ? 1 : purposes.length;
      for (const purpose of purposes.slice(0, verificationCount)) {
        const verified = await ctx.call('pos-profile:migration:record-verification', { purpose, details });
        assert.equal(verified.ok, true, interruptedPhase + ':' + purpose);
      }
    }
    if (interruptedPhase === 'ready_to_cutover') {
      await ctx.call('pos-profile:migration:transition', { nextPhase: 'ready_to_cutover' });
    }

    // Simulate process shutdown: lock and clear the old IPC/session state.
    ctx.api.clearSelections();

    // Simulate a new Electron main-process registration against the same
    // disposable folder. The encrypted profile/journal files remain on disk.
    const handlers = new Map();
    const restartedApi = registerPOSProfileIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [ctx.root] }) },
      BrowserWindow: { getAllWindows: () => [] },
      safeStorage: safeStorage(),
      isTrustedRenderer: () => true,
      platform: 'linux',
      markOverflowFolderPrimary: (directory, profileId) => ({
        ok: true, available: true, storageMode: 'folder_primary', profileId, profileDirectory: directory,
      }),
      markOverflowFolderIndexedDBPrimary: () => ({ ok: true, storageMode: 'indexeddb' }),
    });
    const event = { sender: { mainFrame: {} }, senderFrame: {} };
    const callAfterRestart = (channel, payload) => handlers.get(channel)(event, payload);

    const selected = await callAfterRestart('pos-profile:choose-storage-root');
    assert.equal(selected.ok, true, interruptedPhase);
    const discovered = await callAfterRestart('pos-profile:discover', { storageRoot: ctx.root });
    assert.equal(discovered.available.length, 1, interruptedPhase);
    const unlocked = await callAfterRestart('pos-profile:unlock-passphrase', {
      directory: discovered.available[0].directory,
      secret: 'Nexfix-IPC-Lock-2026',
    });
    assert.equal(unlocked.ok, true, interruptedPhase);

    const retried = await callAfterRestart('pos-profile:migration:begin');
    assert.equal(retried.ok, true, interruptedPhase);
    assert.equal(retried.journal.phase, 'snapshotting', interruptedPhase);
    for (const purpose of purposes) {
      assert.deepEqual(retried.journal.entries[purpose], { status: 'pending' }, interruptedPhase + ':' + purpose);
    }
    restartedApi.clearSelections();
  }
});


test('persists interrupted migration journal across independent process exit and relaunch', async (t) => {
  const parentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexfix-process-restart-'));
  t.after(() => fs.rmSync(parentRoot, { recursive: true, force: true }));
  const phases = ['snapshotting', 'copying', 'verifying', 'ready_to_cutover'];
  const childScript = String.raw`
    'use strict';
    const { registerPOSProfileIpc } = require('./electron/profile-ipc.cjs');
    const [root, phase, mode] = process.argv.slice(1);
    const handlers = new Map();
    const api = registerPOSProfileIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) },
      BrowserWindow: { getAllWindows: () => [] },
      safeStorage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'dpapi',
        encryptString: value => Buffer.from('dpapi:' + value, 'utf8'),
        decryptString: value => {
          const text = Buffer.from(value).toString('utf8');
          if (!text.startsWith('dpapi:')) throw new Error('wrong device');
          return text.slice(6);
        },
      },
      isTrustedRenderer: () => true,
      platform: 'linux',
      markOverflowFolderPrimary: (directory, profileId) => ({
        ok: true, available: true, storageMode: 'folder_primary', profileId, profileDirectory: directory,
      }),
      markOverflowFolderIndexedDBPrimary: () => ({ ok: true, storageMode: 'indexeddb' }),
    });
    const event = { sender: { mainFrame: {} }, senderFrame: {} };
    const call = (channel, payload) => handlers.get(channel)(event, payload);
    const passphrase = 'Nexfix-IPC-Lock-2026';
    const purposes = ['app_state', 'sync_queue', 'meta', 'restore_checkpoint'];
    const details = { revision: 1, bytes: 12, sha256: 'a'.repeat(64) };
    async function run() {
      if (mode === 'seed') {
        await call('pos-profile:choose-storage-root');
        const created = await call('pos-profile:create', {
          storageRoot: root,
          directoryName: 'Restart ' + phase,
          label: 'Disposable process restart profile',
          passphrase,
        });
        if (!created.ok) throw new Error(created.error);
        const started = await call('pos-profile:migration:begin');
        if (!started.ok) throw new Error(started.error);
        if (phase !== 'snapshotting') {
          const copying = await call('pos-profile:migration:transition', { nextPhase: 'copying' });
          if (!copying.ok) throw new Error(copying.error);
          const copyCount = phase === 'copying' ? 1 : purposes.length;
          for (const purpose of purposes.slice(0, copyCount)) {
            const copied = await call('pos-profile:migration:record-copy', { purpose, details });
            if (!copied.ok) throw new Error(copied.error);
          }
        }
        if (phase === 'verifying' || phase === 'ready_to_cutover') {
          const verifying = await call('pos-profile:migration:transition', { nextPhase: 'verifying' });
          if (!verifying.ok) throw new Error(verifying.error);
          const verifyCount = phase === 'verifying' ? 1 : purposes.length;
          for (const purpose of purposes.slice(0, verifyCount)) {
            const verified = await call('pos-profile:migration:record-verification', { purpose, details });
            if (!verified.ok) throw new Error(verified.error);
          }
        }
        if (phase === 'ready_to_cutover') {
          const ready = await call('pos-profile:migration:transition', { nextPhase: 'ready_to_cutover' });
          if (!ready.ok) throw new Error(ready.error);
        }
        const status = await call('pos-profile:migration:status');
        if (!status.ok || status.journal.phase !== phase) throw new Error('Seed phase was not durably recorded.');
        process.stdout.write('READY:' + status.journal.phase + '\\n');
        // Keep the process alive until the parent forcibly terminates it.
        setInterval(() => {}, 1000);
        return;
      }

      await call('pos-profile:choose-storage-root');
      const discovered = await call('pos-profile:discover', { storageRoot: root });
      if (!discovered.ok || discovered.available.length !== 1) throw new Error('Persisted profile was not rediscovered.');
      const unlocked = await call('pos-profile:unlock-passphrase', {
        directory: discovered.available[0].directory,
        secret: passphrase,
      });
      if (!unlocked.ok) throw new Error(unlocked.error);
      const persisted = await call('pos-profile:migration:status');
      if (!persisted.ok || persisted.journal?.phase !== phase) {
        throw new Error('The interrupted migration phase was not persisted across process exit.');
      }
      const retried = await call('pos-profile:migration:begin');
      if (!retried.ok || retried.journal.phase !== 'snapshotting') {
        throw new Error('Interrupted migration did not restart from the IndexedDB source.');
      }
      for (const purpose of purposes) {
        if (retried.journal.entries[purpose].status !== 'pending') {
          throw new Error('Interrupted migration retained an unverified copy for ' + purpose);
        }
      }
      process.stdout.write(JSON.stringify({
        phase: retried.journal.phase,
        pendingEntries: Object.keys(retried.journal.entries).filter(key => retried.journal.entries[key].status === 'pending').length,
      }));
      api.clearSelections();
    }
    run().catch(error => {
      process.stderr.write(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    });
  `;

  for (const phase of phases) {
    const root = path.join(parentRoot, phase);
    fs.mkdirSync(root);
    const runChild = (mode) => {
      const output = execFileSync(process.execPath, ['-e', childScript, root, phase, mode], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30000,
        windowsHide: true,
      });
      return JSON.parse(output);
    };

    // Wait until the child has read back the persisted journal, then forcibly
    // terminate that independent OS process before starting recovery.
    const killAfterJournalPersisted = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', childScript, root, phase, 'seed'], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let killRequested = false;
      const timeout = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error(phase + ': timed out waiting for the migration journal to persist. ' + stderr));
      }, 30000);
      child.stdout.on('data', chunk => {
        stdout += chunk.toString('utf8');
        if (!killRequested && stdout.includes('READY:' + phase + '\\n')) {
          killRequested = true;
          child.kill('SIGKILL');
        }
      });
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
      child.once('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', () => {
        clearTimeout(timeout);
        if (!killRequested) {
          reject(new Error(phase + ': child exited before the persisted-journal kill point. ' + stderr));
          return;
        }
        resolve(stdout);
      });
    });

    const killedOutput = await killAfterJournalPersisted();
    assert.ok(killedOutput.includes('READY:' + phase), phase + ': first process persisted the interrupted phase');

    // A separate Node process now rediscovers the encrypted profile from disk
    // after forced termination and resumes migration from the IndexedDB source.
    const resumed = runChild('resume');
    assert.deepEqual(resumed, { phase: 'snapshotting', pendingEntries: 4 }, phase + ': relaunch recovery');
  }
});
