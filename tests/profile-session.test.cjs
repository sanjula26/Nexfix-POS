'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { POSProfileSession } = require('../electron/profile-session.cjs');

function safeStorage(prefix) {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'dpapi',
    encryptString: value => Buffer.from(prefix + value, 'utf8'),
    decryptString: value => {
      const text = Buffer.from(value).toString('utf8');
      if (!text.startsWith(prefix)) throw new Error('DPAPI wrapper belongs to another Windows installation.');
      return text.slice(prefix.length);
    },
  };
}

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexfix-profile-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const PASSWORD = 'Nexfix-Session-Lock-2026';

test('creates a locked profile, writes encrypted business data and only reveals recovery key at creation', async (t) => {
  const root = temporaryRoot(t);
  const session = new POSProfileSession({ safeStorage: safeStorage('windows-a:'), platform: 'linux' });
  const created = await session.create({
    storageRoot: root,
    directoryName: 'Shop Data',
    label: 'NexFix Main Shop',
    passphrase: PASSWORD,
  });

  assert.equal(created.ok, true);
  assert.match(created.recoveryKey, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(session.getStatus().unlocked, true);
  const saved = session.write('app_state', JSON.stringify({ products: [{ id: 'p1' }], sales: [] }));
  assert.equal(saved.ok, true);
  assert.equal(session.read('app_state'), JSON.stringify({ products: [{ id: 'p1' }], sales: [] }));

  const encryptedFile = fs.readFileSync(path.join(created.profile.directory, 'app-state.nxf'), 'utf8');
  assert.equal(encryptedFile.includes('"products"'), false);
  assert.equal(encryptedFile.includes('"sales"'), false);
  assert.equal(fs.existsSync(path.join(created.profile.directory, 'nexfix-key-envelope.json')), true);
  assert.equal(session.getStatus().profile.profileId, created.profile.profileId);

  session.lock();
  assert.equal(session.getStatus().unlocked, false);
  assert.throws(() => session.read('app_state'), /No POS profile is unlocked/);
  assert.equal(session.discover(root).available.length, 1);
  assert.equal(session.discover(root).available[0].profileId, created.profile.profileId);
});

test('rejects a wrong passphrase and allows a profile to be moved to a new Windows installation', async (t) => {
  const root = temporaryRoot(t);
  const first = new POSProfileSession({ safeStorage: safeStorage('windows-old:'), platform: 'linux' });
  const created = await first.create({
    storageRoot: root,
    directoryName: 'NexFix',
    label: 'NexFix Shop',
    passphrase: PASSWORD,
  });
  first.write('app_state', JSON.stringify({ sales: [{ id: 'sale-1' }] }));
  first.lock();

  const second = new POSProfileSession({ safeStorage: safeStorage('windows-new:'), platform: 'linux' });
  await assert.rejects(second.unlockWithPassphrase(created.profile.directory, 'Wrong-Password-2026'), /authentication failed/);
  assert.equal(second.getStatus().unlocked, false);

  const opened = await second.unlockWithPassphrase(created.profile.directory, PASSWORD);
  assert.equal(opened.ok, true);
  assert.equal(second.read('app_state'), JSON.stringify({ sales: [{ id: 'sale-1' }] }));
  second.lock();

  const third = new POSProfileSession({ safeStorage: safeStorage('windows-reinstalled:'), platform: 'linux' });
  const recovered = await third.unlockWithRecoveryKey(created.profile.directory, created.recoveryKey);
  assert.equal(recovered.ok, true);
  assert.equal(third.read('app_state'), JSON.stringify({ sales: [{ id: 'sale-1' }] }));
  third.lock();
});

test('changes and resets the owner password while preserving encrypted profile data', async (t) => {
  const root = temporaryRoot(t);
  const session = new POSProfileSession({ safeStorage: safeStorage('windows:'), platform: 'linux' });
  const created = await session.create({
    storageRoot: root,
    directoryName: 'POS',
    label: 'POS Shop',
    passphrase: PASSWORD,
  });
  session.write('app_state', JSON.stringify({ stock: 42 }));

  await assert.rejects(session.changePassphrase('Wrong-Password-2026', 'Nexfix-New-Lock-2026'), /authentication failed/);
  await session.changePassphrase(PASSWORD, 'Nexfix-New-Lock-2026');
  session.lock();
  await assert.rejects(session.unlockWithPassphrase(created.profile.directory, PASSWORD), /authentication failed/);
  await session.unlockWithPassphrase(created.profile.directory, 'Nexfix-New-Lock-2026');
  assert.equal(session.read('app_state'), JSON.stringify({ stock: 42 }));

  await session.resetPassphrase(created.recoveryKey, 'Nexfix-Recovered-Lock-2026');
  session.lock();
  await assert.rejects(session.unlockWithPassphrase(created.profile.directory, 'Nexfix-New-Lock-2026'), /authentication failed/);
  await session.unlockWithPassphrase(created.profile.directory, 'Nexfix-Recovered-Lock-2026');
  assert.equal(session.read('app_state'), JSON.stringify({ stock: 42 }));
});

test('does not allow two writable profiles in one process and does not overwrite an existing folder', async (t) => {
  const root = temporaryRoot(t);
  const session = new POSProfileSession({ safeStorage: safeStorage('windows:'), platform: 'linux' });
  const created = await session.create({
    storageRoot: root,
    directoryName: 'POS',
    label: 'POS Shop',
    passphrase: PASSWORD,
  });
  await assert.rejects(session.create({
    storageRoot: root,
    directoryName: 'Other',
    label: 'Other Shop',
    passphrase: PASSWORD,
  }), /Lock the currently open/);
  session.lock();

  await assert.rejects(session.create({
    storageRoot: root,
    directoryName: 'POS',
    label: 'Replacement Shop',
    passphrase: PASSWORD,
  }));
  assert.equal(session.discover(root).available[0].profileId, created.profile.profileId);
});

test('refuses an invalid storage root and requires a profile unlock for every data operation', async (t) => {
  const root = temporaryRoot(t);
  const session = new POSProfileSession({ safeStorage: safeStorage('windows:'), platform: 'linux' });
  assert.throws(() => session.discover(path.join(root, 'missing')), /ENOENT/);
  assert.throws(() => session.read('sync_queue'), /No POS profile is unlocked/);
  assert.throws(() => session.write('cookies', '{}'), /No POS profile is unlocked/);
});
