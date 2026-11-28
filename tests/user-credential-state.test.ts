import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceUserPasswordIfCurrent, saveManagedUserIfCurrent } from '../src/lib/userCredentialState.ts';
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


test('managed user creation and profile updates require the same active Admin and target snapshots', () => {
  const initial = stateWithUsers([admin, cashier]);
  const changedAdmin = stateWithUsers([{ ...admin, password: 'changed-admin-password' }, cashier]);
  const disabledAdmin = stateWithUsers([{ ...admin, active: false }, cashier]);
  const changedTarget = stateWithUsers([admin, { ...cashier, password: 'changed-target-password' }]);

  assert.equal(saveManagedUserIfCurrent(changedAdmin, admin, cashier, { ...cashier, name: 'Updated' }), null);
  assert.equal(saveManagedUserIfCurrent(disabledAdmin, admin, cashier, { ...cashier, name: 'Updated' }), null);
  assert.equal(saveManagedUserIfCurrent(changedTarget, admin, cashier, { ...cashier, name: 'Updated' }), null);

  const created: AppUser = {
    id: 'cashier-2', name: 'New cashier', email: 'new@example.test',
    password: 'new-cashier-pbkdf2-hash', role: 'cashier', active: true,
    createdAt: '2026-01-02T00:00:00.000Z', mustChangePassword: false,
  };
  const withNew = saveManagedUserIfCurrent(initial, admin, null, created);
  assert.equal(withNew?.users.some(user => user.id === created.id), true);
  assert.equal(initial.users.some(user => user.id === created.id), false);
});

test('managed user save rejects a profile changed while the password hash was being derived', () => {
  const initial = stateWithUsers([admin, cashier]);
  const latestProfile = stateWithUsers([
    admin,
    { ...cashier, name: 'Newer display name', email: 'newer@example.test', commissionPct: 4.5 },
  ]);

  assert.equal(
    saveManagedUserIfCurrent(latestProfile, admin, cashier, {
      ...cashier,
      password: 'derived-new-password-hash',
      name: 'Stale display name',
      email: 'stale@example.test',
    }),
    null,
  );
  assert.equal(latestProfile.users.find(user => user.id === cashier.id)?.email, 'newer@example.test');
  assert.equal(initial.users.find(user => user.id === cashier.id)?.email, cashier.email);
});

test('a deactivated staff profile can be edited without silently reactivating the account', () => {
  const inactiveCashier = { ...cashier, active: false };
  const initial = stateWithUsers([admin, inactiveCashier]);
  const next = saveManagedUserIfCurrent(initial, admin, inactiveCashier, {
    ...inactiveCashier,
    name: 'Archived cashier updated',
  });

  assert.equal(next?.users.find(user => user.id === cashier.id)?.name, 'Archived cashier updated');
  assert.equal(next?.users.find(user => user.id === cashier.id)?.active, false);
});

test('managed user save rejects duplicate email and duplicate new account IDs', () => {
  const initial = stateWithUsers([admin, cashier]);
  const duplicateEmail: AppUser = {
    id: 'cashier-2', name: 'Another cashier', email: ' CASHIER@example.test ',
    password: 'new-password-hash', role: 'cashier', active: true,
    createdAt: '2026-01-02T00:00:00.000Z',
  };
  const duplicateId: AppUser = { ...cashier, name: 'Duplicate ID', email: 'other@example.test' };
  assert.equal(saveManagedUserIfCurrent(initial, admin, null, duplicateEmail), null);
  assert.equal(saveManagedUserIfCurrent(initial, admin, null, duplicateId), null);
});


test('managed user save cannot demote or deactivate the final active Admin', () => {
  const initial = stateWithUsers([admin, cashier]);

  assert.equal(
    saveManagedUserIfCurrent(initial, admin, admin, { ...admin, role: 'cashier' }),
    null,
  );
  assert.equal(
    saveManagedUserIfCurrent(initial, admin, admin, { ...admin, active: false }),
    null,
  );

  const secondAdmin: AppUser = {
    ...admin,
    id: 'admin-2',
    email: 'admin2@example.test',
    password: 'second-admin-password',
  };
  const twoAdmins = stateWithUsers([admin, secondAdmin, cashier]);
  const demoted = saveManagedUserIfCurrent(twoAdmins, admin, secondAdmin, {
    ...secondAdmin,
    role: 'cashier',
  });
  assert.equal(demoted?.users.some(user => user.role === 'admin' && user.active), true);
  assert.equal(demoted?.users.find(user => user.id === secondAdmin.id)?.role, 'cashier');
});

test('managed user profile update preserves latest unrelated POS state', () => {
  const initial = {
    ...stateWithUsers([admin, cashier]),
    products: [{ id: 'product-1' }],
  } as POSState;
  const next = saveManagedUserIfCurrent(initial, admin, cashier, {
    ...cashier, name: 'Cashier Updated', email: 'cashier-new@example.test', password: cashier.password,
  });
  assert.equal(next?.users.find(user => user.id === cashier.id)?.name, 'Cashier Updated');
  assert.deepEqual(next?.products, initial.products);
});
