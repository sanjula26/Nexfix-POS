import assert from 'node:assert/strict';
import { listPackage } from '@electron/asar';

const archivePath = process.argv[2] || 'release-qa/win-unpacked/resources/app.asar';
const entries = (await listPackage(archivePath)).map((entry) => entry
  .split(String.fromCharCode(92)).join('/')
  .replace(/^\/+/, ''));
const profileRuntimeFiles = [
  'profile-runtime/profile-ipc.cjs',
  'profile-runtime/profile-session.cjs',
  'profile-runtime/profile-migration.cjs',
  'profile-runtime/storage-profile.cjs',
  'profile-runtime/profile-key-store.cjs',
  'profile-runtime/profile-crypto.cjs',
  'profile-runtime/profile-storage.cjs',
  'profile-runtime/profile-acl.cjs',
  'profile-runtime/overflow-folder.cjs',
];
const allowedEntries = [
  'dist',
  'dist/assets',
  'profile-runtime',
  'main.cjs',
  'preload.cjs',
  'package.json',
  'prepare-qa-folder.cjs',
  'folder-guard.cjs',
  'interruption-control.cjs',
  'dist/index.html',
  'dist/assets/qa-renderer.js',
  ...profileRuntimeFiles,
];

for (const required of allowedEntries) {
  assert.ok(entries.includes(required), 'QA ASAR must contain ' + required + '.');
}
assert.deepEqual([...entries].sort(), [...allowedEntries].sort(),
  'QA ASAR must contain only the reviewed isolated QA harness and mirrored profile-runtime files.');
assert.equal(entries.some((entry) => entry.startsWith('node_modules/')), false,
  'The isolated QA shell must not package production dependencies.');
assert.equal(entries.some((entry) => entry.startsWith('dist/../') || entry.startsWith('profile-runtime/../')), false,
  'QA ASAR must not contain paths escaping the isolated QA app.');
assert.equal(entries.some((entry) => entry === 'electron/main.cjs' ||
  entry === 'electron/preload.cjs' ||
  entry.endsWith('/electron/main.cjs') ||
  entry.endsWith('/electron/preload.cjs')), false,
  'The isolated QA shell must not package production Electron entrypoints.');

console.log('QA ASAR boundary verified: ' + archivePath + ' (' + entries.length + ' entries; exact isolated QA allowlist).');
