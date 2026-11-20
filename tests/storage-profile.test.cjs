'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  PROFILE_MANIFEST_FILE,
  createProfileManifest,
  createManagedProfileDirectory,
  validateProfileManifest,
  readProfileManifest,
  classifyProfileCandidates,
  resolveExistingProfileDirectory,
  getLegacyImportAllowlist,
} = require('../electron/storage-profile.cjs');

const PROFILE_ID = 'd9d6f0e1-5b2d-4e21-9e72-0cce0d8c7a10';
const OTHER_PROFILE_ID = '4d6b9d1f-4f21-4a21-9b4a-3d3c7f0e1a22';
const NOW = '2026-11-20T08:00:00.000Z';

function makeManifest(overrides = {}) {
  return createProfileManifest({
    profileId: PROFILE_ID,
    label: 'Nexfix Shop',
    dataSchemaVersion: 1,
    now: NOW,
    ...overrides,
  });
}

function temporaryDirectory(t, prefix = 'nexfix-profile-test-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('creates and validates a versioned profile manifest', () => {
  const manifest = makeManifest();
  assert.equal(validateProfileManifest(manifest).valid, true);
  assert.equal(manifest.profileId, PROFILE_ID);
  assert.equal(manifest.label, 'Nexfix Shop');
  assert.equal(manifest.manifestVersion, 1);
});

test('rejects unsafe, incomplete and unknown manifest fields', () => {
  assert.equal(validateProfileManifest(null).valid, false);
  assert.equal(validateProfileManifest({ ...makeManifest(), profileId: '../outside' }).valid, false);
  assert.equal(validateProfileManifest({ ...makeManifest(), label: 'bad\nlabel' }).valid, false);
  assert.equal(validateProfileManifest({ ...makeManifest(), updatedAt: '2020-01-01T00:00:00.000Z' }).valid, false);
  assert.equal(validateProfileManifest({ ...makeManifest(), secretToken: 'must-not-be-here' }).valid, false);
});

test('reads a bounded manifest from a profile folder', (t) => {
  const directory = temporaryDirectory(t);
  const manifest = makeManifest();
  fs.writeFileSync(path.join(directory, PROFILE_MANIFEST_FILE), JSON.stringify(manifest));
  assert.deepEqual(readProfileManifest(directory), manifest);

  fs.writeFileSync(path.join(directory, PROFILE_MANIFEST_FILE), '{invalid');
  assert.throws(() => readProfileManifest(directory), /invalid JSON/);
  fs.writeFileSync(path.join(directory, PROFILE_MANIFEST_FILE), ' '.repeat(16 * 1024 + 1));
  assert.throws(() => readProfileManifest(directory), /size limit/);
});

test('classifies same profile IDs as duplicate copies and different IDs as separate profiles', () => {
  const first = makeManifest();
  const secondCopy = makeManifest({ label: 'Copied profile' });
  const separate = makeManifest({ profileId: OTHER_PROFILE_ID, label: 'Second shop' });
  const result = classifyProfileCandidates([
    { path: 'D:\\POS\\A', manifest: first },
    { path: 'E:\\POS\\A-copy', manifest: secondCopy },
    { path: 'D:\\POS\\B', manifest: separate },
    { path: 'D:\\POS\\broken', manifest: { format: 'other' } },
  ]);

  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].copies.length, 2);
  assert.equal(result.available.length, 1);
  assert.equal(result.available[0].manifest.profileId, OTHER_PROFILE_ID);
  assert.equal(result.invalid.length, 1);
});

test('accepts a real profile folder inside the selected root', (t) => {
  const root = temporaryDirectory(t);
  const profile = path.join(root, 'POS Data');
  fs.mkdirSync(profile);
  assert.equal(resolveExistingProfileDirectory(root, profile), fs.realpathSync(profile));
});

test('rejects traversal and folders outside the selected root', (t) => {
  const root = temporaryDirectory(t);
  const outside = temporaryDirectory(t, 'nexfix-outside-');
  assert.throws(() => resolveExistingProfileDirectory(root, outside), /outside/);
  assert.throws(() => resolveExistingProfileDirectory(root, path.join(root, '..', 'outside')), /outside|ENOENT/);
});

test('rejects a profile folder symlink', (t) => {
  if (process.platform === 'win32') return;
  const root = temporaryDirectory(t);
  const actual = path.join(root, 'actual');
  const link = path.join(root, 'linked');
  fs.mkdirSync(actual);
  fs.symlinkSync(actual, link, 'dir');
  assert.throws(() => resolveExistingProfileDirectory(root, link), /symbolic link/);
});

test('legacy import allowlist includes only IndexedDB and blob storage, never browser local storage or credentials', (t) => {
  const sessionData = temporaryDirectory(t);
  for (const name of ['IndexedDB', 'blob_storage', 'Local Storage', 'Session Storage', 'Cookies', 'Cache', 'nexfix-secure']) {
    fs.mkdirSync(path.join(sessionData, name));
  }
  const allowed = getLegacyImportAllowlist(sessionData);
  assert.deepEqual(allowed.map((entry) => entry.name), ['IndexedDB', 'blob_storage']);
  assert.equal(allowed.some((entry) => /Local Storage|Cookies|nexfix-secure/.test(entry.path)), false);
});

test('rejects a symlinked legacy IndexedDB directory', (t) => {
  if (process.platform === 'win32') return;
  const sessionData = temporaryDirectory(t);
  const outside = temporaryDirectory(t, 'nexfix-legacy-outside-');
  fs.symlinkSync(outside, path.join(sessionData, 'IndexedDB'), 'dir');
  assert.throws(() => getLegacyImportAllowlist(sessionData), /symbolic link/);
});

test('rejects a symlinked profile manifest', (t) => {
  if (process.platform === 'win32') return;
  const directory = temporaryDirectory(t);
  const outside = path.join(directory, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify(makeManifest()));
  fs.symlinkSync(outside, path.join(directory, PROFILE_MANIFEST_FILE));
  assert.throws(() => readProfileManifest(directory), /symbolic link/);
});

test('atomically creates a new managed profile and verifies its manifest', (t) => {
  const root = temporaryDirectory(t);
  const created = createManagedProfileDirectory(root, 'Shop Profile', {
    profileId: PROFILE_ID,
    label: 'Nexfix Shop',
    dataSchemaVersion: 1,
    now: NOW,
  });
  assert.equal(created.directory, path.join(fs.realpathSync(root), 'Shop Profile'));
  assert.equal(created.manifest.profileId, PROFILE_ID);
  assert.deepEqual(readProfileManifest(created.directory), created.manifest);
  assert.equal(fs.readdirSync(root).includes('Shop Profile'), true);
  assert.equal(fs.readdirSync(root).some(name => name.endsWith('.staging')), false);
});

test('refuses to overwrite an existing profile folder', (t) => {
  const root = temporaryDirectory(t);
  const existing = path.join(root, 'Shop Profile');
  fs.mkdirSync(existing);
  fs.writeFileSync(path.join(existing, 'owner-data.txt'), 'preserve');
  assert.throws(() => createManagedProfileDirectory(root, 'Shop Profile', {
    profileId: PROFILE_ID, label: 'Nexfix Shop', dataSchemaVersion: 1, now: NOW,
  }), /already exists/);
  assert.equal(fs.readFileSync(path.join(existing, 'owner-data.txt'), 'utf8'), 'preserve');
});

test('rejects unsafe folder names and symlinked storage roots', (t) => {
  const root = temporaryDirectory(t);
  assert.throws(() => createManagedProfileDirectory(root, '../outside', {
    profileId: PROFILE_ID, label: 'Nexfix Shop', dataSchemaVersion: 1, now: NOW,
  }), /unsupported characters/);
  if (process.platform !== 'win32') {
    const link = path.join(root, 'linked-root');
    fs.symlinkSync(root, link, 'dir');
    assert.throws(() => createManagedProfileDirectory(link, 'Shop Profile', {
      profileId: PROFILE_ID, label: 'Nexfix Shop', dataSchemaVersion: 1, now: NOW,
    }), /real local folder/);
  }
});
