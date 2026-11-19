import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceAdminPinHashIfCurrent } from '../src/lib/adminPinState.ts';
import type { POSState } from '../src/lib/types.ts';

function stateWithPin(adminPinHash: string): POSState {
  return {
    settings: { adminPinHash },
  } as POSState;
}

test('admin PIN compare-and-set accepts only the exact verified hash snapshot', () => {
  const oldLegacyHash = 'legacy-hash-that-was-verified';
  const newPinHash = 'new-pbkdf2-hash-from-concurrent-pin-change';
  const current = stateWithPin(newPinHash);

  const staleUpgrade = replaceAdminPinHashIfCurrent(current, oldLegacyHash, 'upgraded-old-pin-hash');
  assert.equal(staleUpgrade, null);
  assert.equal(current.settings.adminPinHash, newPinHash);

  const validUpgrade = replaceAdminPinHashIfCurrent(stateWithPin(oldLegacyHash), oldLegacyHash, 'upgraded-current-pin-hash');
  assert.equal(validUpgrade?.settings.adminPinHash, 'upgraded-current-pin-hash');
});

test('admin PIN compare-and-set preserves unrelated state while replacing the hash', () => {
  const current = {
    ...stateWithPin('expected'),
    products: [{ id: 'product-1' }],
  } as POSState;
  const next = replaceAdminPinHashIfCurrent(current, 'expected', 'replacement');
  assert.equal(next?.settings.adminPinHash, 'replacement');
  assert.deepEqual(next?.products, current.products);
});
