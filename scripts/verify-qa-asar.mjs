import assert from 'node:assert/strict';
import { listPackage } from '@electron/asar';

const archivePath = process.argv[2] || 'release-qa/win-unpacked/resources/app.asar';
const entries = (await listPackage(archivePath)).map((entry) => entry
  .split(String.fromCharCode(92)).join('/')
  .replace(/^\\/+/, ''));

for (const required of ['main.cjs', 'preload.cjs', 'index.html', 'package.json']) {
  assert.ok(entries.includes(required), `QA ASAR must contain ${required}.`);
}

assert.equal(entries.some((entry) => entry.startsWith('node_modules/')), false,
  'The isolated QA shell must not package production dependencies.');
assert.equal(entries.some((entry) => entry.startsWith('dist/')), false,
  'The isolated QA shell must not package the production renderer.');
assert.equal(entries.some((entry) => /(^|\\/)electron\\/(main|preload)\\.cjs$/.test(entry)), false,
  'The isolated QA shell must not package production Electron entrypoints.');

console.log(`QA ASAR boundary verified: ${archivePath} (${entries.length} entries; isolated shell only).`);
