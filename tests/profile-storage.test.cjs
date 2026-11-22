'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createManagedProfileDirectory } = require('../electron/storage-profile.cjs');
const { EncryptedProfileStorage, PROFILE_DATA_FILES } = require('../electron/profile-storage.cjs');

const PROFILE_ID = 'd9d6f0e1-5b2d-4e21-9e72-0cce0d8c7a10';
const NOW = '2026-11-20T08:00:00.000Z';

function temporaryProfile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexfix-encrypted-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = createManagedProfileDirectory(root, 'Shop Profile', {
    profileId: PROFILE_ID, label: 'Nexfix Shop', dataSchemaVersion: 1, now: NOW,
  });
  return profile.directory;
}

test('encrypts profile stores before disk persistence and reads them back', (t) => {
  const directory = temporaryProfile(t);
  const key = crypto.randomBytes(32);
  const storage = new EncryptedProfileStorage(directory, PROFILE_ID, key);
  const payload = JSON.stringify({ customers: [{ name: 'Sensitive Customer' }], total: 2500 });
  const saved = storage.write('app_state', payload);
  assert.equal(saved.ok, true);
  assert.equal(saved.revision, 1);
  assert.equal(storage.read('app_state'), payload);

  const file = path.join(directory, PROFILE_DATA_FILES.app_state);
  const diskText = fs.readFileSync(file, 'utf8');
  assert.equal(diskText.includes('Sensitive Customer'), false);
  assert.equal(diskText.includes('"total":2500'), false);
  storage.destroy();
  assert.equal(storage.dataKey.every(byte => byte === 0), true);
});

test('increments revisions and keeps queue, metadata and restore checkpoint separate', (t) => {
  const directory = temporaryProfile(t);
  const storage = new EncryptedProfileStorage(directory, PROFILE_ID, crypto.randomBytes(32));
  assert.equal(storage.write('app_state', '{"sales":[]}').revision, 1);
  assert.equal(storage.write('app_state', '{"sales":[{"id":"s1"}]}').revision, 2);
  assert.equal(storage.write('sync_queue', '[{"id":"q1"}]').revision, 1);
  assert.equal(storage.write('meta', '{"backupCount":1}').revision, 1);
  assert.equal(storage.write('restore_checkpoint', '{"sales":[]}').revision, 1);
  assert.equal(storage.read('app_state'), '{"sales":[{"id":"s1"}]}');
  assert.equal(storage.read('sync_queue'), '[{"id":"q1"}]');
  assert.equal(storage.read('meta'), '{"backupCount":1}');
  assert.equal(storage.read('restore_checkpoint'), '{"sales":[]}');
  assert.equal(storage.write('migration_journal', '{"phase":"snapshotting"}').revision, 1);
  assert.equal(storage.read('migration_journal'), '{"phase":"snapshotting"}');
  assert.notEqual(PROFILE_DATA_FILES.app_state, PROFILE_DATA_FILES.sync_queue);
  storage.destroy();
});

test('refuses to overwrite corrupted or tampered encrypted state', (t) => {
  const directory = temporaryProfile(t);
  const storage = new EncryptedProfileStorage(directory, PROFILE_ID, crypto.randomBytes(32));
  storage.write('app_state', '{"sales":[]}');
  const file = path.join(directory, PROFILE_DATA_FILES.app_state);
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  envelope.ciphertext = Buffer.alloc(Buffer.from(envelope.ciphertext, 'base64').length, 7).toString('base64');
  fs.writeFileSync(file, JSON.stringify(envelope));
  assert.throws(() => storage.read('app_state'), /authentication failed/);
  assert.throws(() => storage.write('app_state', '{"sales":[1]}'), /authentication failed/);
  storage.destroy();
});

test('rejects unsupported purposes and a mismatched profile identity', (t) => {
  const directory = temporaryProfile(t);
  assert.throws(() => new EncryptedProfileStorage(directory, '4d6b9d1f-4f21-4a21-9b4a-3d3c7f0e1a22', crypto.randomBytes(32)), /does not match/);
  const storage = new EncryptedProfileStorage(directory, PROFILE_ID, crypto.randomBytes(32));
  assert.throws(() => storage.read('cookies'), /Unsupported/);
  assert.throws(() => storage.write('../outside', '{}'), /Unsupported/);
  storage.destroy();
});

test('rejects symlinked encrypted store files', (t) => {
  if (process.platform === 'win32') return;
  const directory = temporaryProfile(t);
  const storage = new EncryptedProfileStorage(directory, PROFILE_ID, crypto.randomBytes(32));
  const outside = path.join(directory, 'outside.nxf');
  fs.writeFileSync(outside, '{}');
  fs.symlinkSync(outside, path.join(directory, PROFILE_DATA_FILES.app_state));
  assert.throws(() => storage.read('app_state'), /symbolic link/);
  storage.destroy();
});
