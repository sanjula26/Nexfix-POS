import assert from 'node:assert/strict';
import { listPackage } from '@electron/asar';

const archivePath = process.argv[2] || 'release-qa/win-unpacked/resources/app.asar';
const entries = (await listPackage(archivePath)).map((entry) => entry
  .split(String.fromCharCode(92)).join('/')
  .replace(/^\/+/, ''));
const packagedFiles = entries.filter((entry) => !entry.endsWith('/'));
const allowedFiles = [
  'main.cjs',
  'preload.cjs',
  'index.html',
  'package.json',
  'renderer.cjs',
  'prepare-qa-folder.cjs',
  'folder-guard.cjs',
];

for (const required of allowedFiles) {
  assert.ok(packagedFiles.includes(required), 'QA ASAR must contain ' + required + '.');
}
assert.deepEqual([...packagedFiles].sort(), [...allowedFiles].sort(),
  'QA ASAR must contain only the reviewed isolated QA shell files.');

assert.equal(entries.some((entry) => entry.startsWith('node_modules/')), false,
  'The isolated QA shell must not package production dependencies.');
assert.equal(entries.some((entry) => entry.startsWith('dist/')), false,
  'The isolated QA shell must not package the production renderer.');
assert.equal(entries.some((entry) => entry === 'electron/main.cjs' ||
  entry === 'electron/preload.cjs' ||
  entry.endsWith('/electron/main.cjs') ||
  entry.endsWith('/electron/preload.cjs')), false,
  'The isolated QA shell must not package production Electron entrypoints.');

console.log('QA ASAR boundary verified: ' + archivePath + ' (' + entries.length + ' entries; exact isolated file set).');
