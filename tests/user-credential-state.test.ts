import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceUserPasswordIfCurrent } from '../src/lib/userCredentialState.ts';
import type { AppUser, POSState } from '../src/lib/types.ts';

const admin: AppUser = {
  id: 'admin-1', name: 'Admin', email: 'admin@example.test',
  password: 'admin-password-snapshot', role: 'admin', active: true,
  createdAt: '2026-01-01T00:00:00.000Z', mustChangePassword: false,
};
const cashier: AppUser = {
  id: 'cashier-1', name: 'Cashier', email: 'cashier@example.test',
  password: 'cashier-password-snapshot', role: 'cashier', active: true,
  createdAt: '2026-01-01T00:00:00.000Z', mustChangePassword: true,
};
function stateWithUsers(users: AppUser[]): POSState {
  return { users, settings: { adminPinHash: 'admin-pin-hash' }, audit: [] } as unknown as POSState;
}

test('a completed password hash replaces only the exact active target credential snapshot', () => {
  const initial = stateWithUsers([admin, cashier]);
  const next = replaceUserPasswordIfCurrent(initial, cashier, 'new-cashier-pbkdf2-hash', admin);
  assert.equal(next?.users.find(user => user.id === cashier.id)?.password, 'new-cashier-pbkdf2-hash');
  assert.equal(next?.users.find(user => user.id === cashier.id)?.mustChangePassword, false);
  assert.equal(next?.users.find(user => user.id === admin.id)?.password, admin.password);
  assert.equal(initial.users.find(user => user.id === cashier.id)?.password, cashier.password);
});

test('a delayed password update cannot overwrite a target password changed during PBKDF2', () => {
  const snapshot = stateWithUsers([admin, cashier]);
  const changedTarget = stateWithUsers([admin, { ...cashier, password: 'newer-target-password' }]);
  assert.equal(replaceUserPasswordIfCurrent(changedTarget, cashier, 'stale-derived-hash', admin), null);
  assert.equal(changedTarget.users.find(user => user.id === cashier.id)?.password, 'newer-target-password');
  assert.equal(snapshot.users.find(user => user.id === cashier.id)?.password, cashier.password);
});

test('an admin-managed password change is rejected after the initiating admin changes or loses access', () => {
  const changedAdmin = stateWithUsers([{ ...admin, password: 'newer-admin-password' }, cashier]);
  assert.equal(replaceUserPasswordIfCurrent(changedAdmin, cashier, 'stale-derived-hash', admin), null);

  const deactivatedAdmin = stateWithUsers([{ ...admin, active: false }, cashier]);
  assert.equal(replaceUserPasswordIfCurrent(deactivatedAdmin, cashier, 'stale-derived-hash', admin), null);

  const demotedAdmin = stateWithUsers([{ ...admin, role: 'cashier' }, cashier]);
  assert.equal(replaceUserPasswordIfCurrent(demotedAdmin, cashier, 'stale-derived-hash', admin), null);
});

test('a self-service password update rejects deactivated, demoted or changed accounts', () => {
  const changed = stateWithUsers([{ ...admin, password: 'newer-password' }, cashier]);
  const deactivated = stateWithUsers([{ ...admin, active: false }, cashier]);
  const roleChanged = stateWithUsers([{ ...admin, role: 'cashier' }, cashier]);
  assert.equal(replaceUserPasswordIfCurrent(changed, admin, 'stale-derived-hash'), null);
  assert.equal(replaceUserPasswordIfCurrent(deactivated, admin, 'stale-derived-hash'), null);
  assert.equal(replaceUserPasswordIfCurrent(roleChanged, admin, 'stale-derived-hash'), null);
});

test('a self-service password update preserves unrelated state and other accounts', () => {
  const initial = {
    ...stateWithUsers([admin, cashier]),
    products: [{ id: 'product-1' }],
  } as POSState;
  const next = replaceUserPasswordIfCurrent(initial, admin, 'new-admin-pbkdf2-hash');
  assert.equal(next?.users.find(user => user.id === admin.id)?.password, 'new-admin-pbkdf2-hash');
  assert.equal(next?.users.find(user => user.id === cashier.id)?.password, cashier.password);
  assert.deepEqual(next?.products, initial.products);
});
