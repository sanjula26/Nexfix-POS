import test from 'node:test';
import assert from 'node:assert/strict';
import { getAdminCredentialFingerprint, replaceAdminPinHashIfCurrent } from '../src/lib/adminPinState.ts';
import type { POSState } from '../src/lib/types.ts';

function stateWithPin(adminPinHash: string): POSState {
  return {
    settings: { adminPinHash },
  } as unknown as POSState;
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
  } as unknown as POSState;
  const next = replaceAdminPinHashIfCurrent(current, 'expected', 'replacement');
  assert.equal(next?.settings.adminPinHash, 'replacement');
  assert.deepEqual(next?.products, current.products);
});

test('a delayed legacy PIN upgrade cannot overwrite a PIN changed while verification is pending', async () => {
  const legacyHash = 'legacy-hash-verified-before-await';
  const newPinHash = 'new-pbkdf2-hash-committed-during-await';
  let state = stateWithPin(legacyHash);
  let finishVerification!: (value: { valid: boolean; upgradedHash?: string }) => void;
  const verification = new Promise<{ valid: boolean; upgradedHash?: string }>(resolve => {
    finishVerification = resolve;
  });

  const delayedUpgrade = verification.then(result => {
    if (!result.valid || !result.upgradedHash) return false;
    const next = replaceAdminPinHashIfCurrent(state, legacyHash, result.upgradedHash);
    if (!next) return false;
    state = next;
    return true;
  });

  const changed = replaceAdminPinHashIfCurrent(state, legacyHash, newPinHash);
  assert.ok(changed);
  state = changed!;
  finishVerification({ valid: true, upgradedHash: 'stale-upgrade-derived-from-old-PIN' });

  assert.equal(await delayedUpgrade, false);
  assert.equal(state.settings.adminPinHash, newPinHash);
});

test('sensitive-admin freshness fingerprint changes when any active admin credential or shared PIN changes', () => {
  const base = {
    settings: { adminPinHash: 'pin-hash-a' },
    users: [
      { id: 'admin-b', role: 'admin', active: true, password: 'password-b' },
      { id: 'cashier-1', role: 'cashier', active: true, password: 'cashier-password' },
      { id: 'admin-a', role: 'admin', active: true, password: 'password-a' },
    ],
  } as unknown as POSState;
  const original = getAdminCredentialFingerprint(base);

  const reordered = {
    ...base,
    users: [...base.users].reverse(),
  } as POSState;
  assert.equal(getAdminCredentialFingerprint(reordered), original);

  const adminPasswordChanged = {
    ...base,
    users: base.users.map(user => user.id === 'admin-a' ? { ...user, password: 'new-admin-password' } : user),
  } as POSState;
  assert.notEqual(getAdminCredentialFingerprint(adminPasswordChanged), original);

  const pinChanged = {
    ...base,
    settings: { ...base.settings, adminPinHash: 'pin-hash-b' },
  } as POSState;
  assert.notEqual(getAdminCredentialFingerprint(pinChanged), original);

  const cashierPasswordChanged = {
    ...base,
    users: base.users.map(user => user.id === 'cashier-1' ? { ...user, password: 'new-cashier-password' } : user),
  } as POSState;
  assert.equal(getAdminCredentialFingerprint(cashierPasswordChanged), original);
});
