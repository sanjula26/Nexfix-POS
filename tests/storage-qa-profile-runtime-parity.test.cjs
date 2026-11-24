'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const mirroredModules = [
  'profile-ipc.cjs',
  'profile-session.cjs',
  'profile-migration.cjs',
  'storage-profile.cjs',
  'profile-key-store.cjs',
  'profile-crypto.cjs',
  'profile-storage.cjs',
  'profile-acl.cjs',
  'overflow-folder.cjs',
];

test('QA encrypted profile runtime is byte-for-byte identical to reviewed production modules', () => {
  for (const filename of mirroredModules) {
    const production = fs.readFileSync(path.join(root, 'electron', filename));
    const qa = fs.readFileSync(path.join(root, 'electron', 'qa', 'profile-runtime', filename));
    assert.deepEqual(qa, production, 'QA profile runtime drifted from production module: ' + filename);
  }
});
