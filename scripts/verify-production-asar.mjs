import assert from 'node:assert/strict';
import { listPackage } from '@electron/asar';

const archivePath = process.argv[2] || 'release/win-unpacked/resources/app.asar';
const entries = await listPackage(archivePath);
// @electron/asar returns archive paths with a leading slash. Normalize both
// that prefix and Windows separators before applying package-boundary checks.
const normalized = entries.map((entry) => entry
  .split(String.fromCharCode(92)).join('/')
  .replace(/^\/+/, ''));

assert.ok(normalized.includes('electron/main.cjs'), 'Production ASAR must contain the production Electron main entry.');
assert.ok(normalized.includes('electron/preload.cjs'), 'Production ASAR must contain the production preload.');
const qaEntries = normalized.filter((entry) => entry.startsWith('electron/qa/'));
assert.deepEqual(qaEntries, [], 'Production ASAR must not contain any electron/qa files.');

console.log(`Production ASAR boundary verified: ${archivePath} (${normalized.length} entries; no electron/qa files).`);
