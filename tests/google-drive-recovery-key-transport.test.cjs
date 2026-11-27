'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const driveSync = fs.readFileSync(path.join(process.cwd(), 'src/lib/driveSync.ts'), 'utf8');
const appsScript = fs.readFileSync(path.join(process.cwd(), 'google-apps-script/Code.gs'), 'utf8');

test('Google Drive metadata GET never transports the raw Recovery Key', () => {
  assert.equal(driveSync.includes("url.searchParams.set('recoveryKey', recoveryKey)"), false);
  const start = appsScript.indexOf("if (p.action === 'updateShopMetadata') {");
  const end = appsScript.indexOf("if (p.action === 'backupStatus') {", start);
  assert.ok(start >= 0 && end > start, 'metadata GET handler must exist');
  const handler = appsScript.slice(start, end);
  assert.equal(handler.includes('p.recoveryKey'), false);
  assert.equal(handler.includes('metadataRecoveryKey'), false);
  assert.match(handler, /authorizeShopAccess\(metadataShopId, metadataProof, true\)/);
});

test('Google Drive encrypted backup retains the existing POST recovery-key contract for legacy recovery', () => {
  const start = driveSync.indexOf('export async function backupStateToGoogle');
  const end = driveSync.indexOf('export async function syncShopMetadataToGoogleDrive', start);
  assert.ok(start >= 0 && end > start, 'backup upload function must exist');
  const handler = driveSync.slice(start, end);
  assert.match(handler, /recoveryKey,/);
  assert.match(handler, /postGoogleBackup\(/);
});
