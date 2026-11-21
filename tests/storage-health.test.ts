import assert from 'node:assert/strict';
import test from 'node:test';
import { canMutatePOSState, type POSStorageStatus } from '../src/lib/storageHealth.ts';

test('POS mutations are enabled only after IndexedDB storage is verified healthy', () => {
  const cases: Array<[POSStorageStatus, boolean]> = [
    ['checking', false],
    ['healthy', true],
    ['degraded', false],
    ['unavailable', false],
  ];
  for (const [status, expected] of cases) {
    assert.equal(canMutatePOSState(status), expected, `storage status ${status}`);
  }
});
