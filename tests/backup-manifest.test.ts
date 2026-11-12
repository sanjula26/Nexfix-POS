import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isValidGoogleBackupManifest,
  MAX_GOOGLE_BACKUP_BYTES,
  MAX_GOOGLE_BACKUP_PARTS,
} from '../src/lib/backupManifest.ts';

function validManifest() {
  return {
    backupId: 'backup_20261112_123456',
    totalBytes: 12,
    totalParts: 2,
    partNames: [
      'NEXFIX_0123456789abcdef01234567_20261112.part001',
      'NEXFIX_0123456789abcdef01234567_20261112.part002',
    ],
    sha256: 'a'.repeat(64),
    exportedAt: '2026-11-12T10:00:00.000Z',
  };
}

test('accepts a correctly shaped sequential multipart manifest', () => {
  assert.equal(isValidGoogleBackupManifest(validManifest()), true);
});

test('rejects missing or malformed part-name arrays before downloads', () => {
  const missing = validManifest();
  delete missing.partNames;
  assert.equal(isValidGoogleBackupManifest(missing), false);
  assert.equal(isValidGoogleBackupManifest({ ...validManifest(), partNames: 'not-an-array' }), false);
});

test('rejects duplicate, reordered, mixed-prefix and path-like part names', () => {
  const duplicate = validManifest();
  duplicate.partNames[1] = duplicate.partNames[0];
  assert.equal(isValidGoogleBackupManifest(duplicate), false);

  const reordered = validManifest();
  reordered.partNames.reverse();
  assert.equal(isValidGoogleBackupManifest(reordered), false);

  const mixedPrefix = validManifest();
  mixedPrefix.partNames[1] = 'NEXFIX_aaaaaaaaaaaaaaaaaaaaaaaa_20261112.part002';
  assert.equal(isValidGoogleBackupManifest(mixedPrefix), false);

  const pathLike = validManifest();
  pathLike.partNames[0] = '../private/file.part001';
  assert.equal(isValidGoogleBackupManifest(pathLike), false);
});

test('rejects unsafe byte counts and excessive part counts', () => {
  assert.equal(isValidGoogleBackupManifest({ ...validManifest(), totalBytes: 0 }), false);
  assert.equal(isValidGoogleBackupManifest({ ...validManifest(), totalBytes: Number.MAX_SAFE_INTEGER + 1 }), false);
  assert.equal(isValidGoogleBackupManifest({ ...validManifest(), totalBytes: MAX_GOOGLE_BACKUP_BYTES + 1 }), false);
  assert.equal(isValidGoogleBackupManifest({ ...validManifest(), totalParts: MAX_GOOGLE_BACKUP_PARTS + 1 }), false);
  assert.equal(isValidGoogleBackupManifest({ ...validManifest(), totalParts: 13 }), false);
});

test('rejects invalid backup id, digest and export timestamp', () => {
  assert.equal(isValidGoogleBackupManifest({ ...validManifest(), backupId: '../bad' }), false);
  assert.equal(isValidGoogleBackupManifest({ ...validManifest(), sha256: 'not-a-hash' }), false);
  assert.equal(isValidGoogleBackupManifest({ ...validManifest(), exportedAt: 'not-a-date' }), false);
});

test('rejects null, arrays and non-object manifests', () => {
  assert.equal(isValidGoogleBackupManifest(null), false);
  assert.equal(isValidGoogleBackupManifest([]), false);
  assert.equal(isValidGoogleBackupManifest('manifest'), false);
});
