import type { AppUser, POSState } from './types';

export type UserCredentialSnapshot = Pick<AppUser, 'id' | 'role' | 'password' | 'active'>;

/**
 * Replace a local login password only when the target account still has
 * exactly the credential snapshot that was present before PBKDF2 completed.
 * For admin-managed changes, also require the initiating administrator to
 * remain active with the same credential.
 */
export function replaceUserPasswordIfCurrent(
  state: POSState,
  targetSnapshot: UserCredentialSnapshot,
  replacementHash: string,
  adminSnapshot?: UserCredentialSnapshot,
): POSState | null {
  const currentTarget = state.users.find(user => user.id === targetSnapshot.id);
  if (!currentTarget || !currentTarget.active || !targetSnapshot.active
    || currentTarget.role !== targetSnapshot.role
    || currentTarget.password !== targetSnapshot.password) {
    return null;
  }

  if (adminSnapshot) {
    const currentAdmin = state.users.find(user => user.id === adminSnapshot.id);
    if (!currentAdmin || !currentAdmin.active || currentAdmin.role !== 'admin'
      || adminSnapshot.role !== 'admin'
      || currentAdmin.password !== adminSnapshot.password) {
      return null;
    }
  }

  return {
    ...state,
    users: state.users.map(user => user.id === targetSnapshot.id
      ? { ...user, password: replacementHash, mustChangePassword: false }
      : user),
  };
}


function isSameAppUserSnapshot(current: AppUser, snapshot: AppUser): boolean {
  const currentKeys = Object.keys(current).sort();
  const snapshotKeys = Object.keys(snapshot).sort();
  return currentKeys.length === snapshotKeys.length
    && currentKeys.every((key, index) => key === snapshotKeys[index]
      && Object.is(
        current[key as keyof AppUser],
        snapshot[key as keyof AppUser],
      ));
}

function hasCurrentAdmin(state: POSState, adminSnapshot: UserCredentialSnapshot): boolean {
  const currentAdmin = state.users.find(user => user.id === adminSnapshot.id);
  return !!currentAdmin && currentAdmin.active && currentAdmin.role === 'admin'
    && adminSnapshot.active && adminSnapshot.role === 'admin'
    && currentAdmin.password === adminSnapshot.password;
}

/** Change another staff account's active status only while both accounts remain unchanged. */
export function setManagedUserActiveIfCurrent(
  state: POSState,
  adminSnapshot: UserCredentialSnapshot,
  targetSnapshot: AppUser,
  nextActive: boolean,
): POSState | null {
  if (!hasCurrentAdmin(state, adminSnapshot) || targetSnapshot.id === adminSnapshot.id) return null;
  const currentTarget = state.users.find(user => user.id === targetSnapshot.id);
  if (!currentTarget || !isSameAppUserSnapshot(currentTarget, targetSnapshot)) return null;

  const nextUsers = state.users.map(user => user.id === targetSnapshot.id
    ? { ...user, active: nextActive }
    : user);
  if (!nextUsers.some(user => user.role === 'admin' && user.active)) return null;
  return { ...state, users: nextUsers };
}

/** Delete another staff account only while both the Admin and target snapshots remain current. */
export function deleteManagedUserIfCurrent(
  state: POSState,
  adminSnapshot: UserCredentialSnapshot,
  targetSnapshot: AppUser,
): POSState | null {
  if (!hasCurrentAdmin(state, adminSnapshot) || targetSnapshot.id === adminSnapshot.id) return null;
  const currentTarget = state.users.find(user => user.id === targetSnapshot.id);
  if (!currentTarget || !isSameAppUserSnapshot(currentTarget, targetSnapshot)) return null;

  const nextUsers = state.users.filter(user => user.id !== targetSnapshot.id);
  if (!nextUsers.some(user => user.role === 'admin' && user.active)) return null;
  return { ...state, users: nextUsers };
}


/**
 * Save a managed local user only while the initiating Admin and any existing
 * target account still match the credential snapshots captured before awaits.
 * This also re-checks email uniqueness against the latest state.
 */
export function saveManagedUserIfCurrent(
  state: POSState,
  adminSnapshot: UserCredentialSnapshot,
  targetSnapshot: AppUser | null,
  nextUser: AppUser,
): POSState | null {
  const currentAdmin = state.users.find(user => user.id === adminSnapshot.id);
  if (!currentAdmin || !currentAdmin.active || currentAdmin.role !== 'admin'
    || adminSnapshot.role !== 'admin'
    || currentAdmin.password !== adminSnapshot.password) {
    return null;
  }

  if (targetSnapshot) {
    const currentTarget = state.users.find(user => user.id === targetSnapshot.id);
    if (nextUser.id !== targetSnapshot.id || !currentTarget) return null;
    const currentKeys = Object.keys(currentTarget).sort();
    const snapshotKeys = Object.keys(targetSnapshot).sort();
    if (currentKeys.length !== snapshotKeys.length
      || currentKeys.some((key, index) => key !== snapshotKeys[index]
        || !Object.is(
          currentTarget[key as keyof AppUser],
          targetSnapshot[key as keyof AppUser],
        ))) {
      return null;
    }
  } else if (state.users.some(user => user.id === nextUser.id)) {
    return null;
  }

  const email = nextUser.email.trim().toLowerCase();
  if (!email || state.users.some(user => user.id !== nextUser.id && user.email.trim().toLowerCase() === email)) {
    return null;
  }

  const nextUsers = targetSnapshot
    ? state.users.map(user => user.id === targetSnapshot.id ? nextUser : user)
    : [...state.users, nextUser];
  // Never allow a staff edit to remove the final active Admin account.
  if (!nextUsers.some(user => user.role === 'admin' && user.active)) return null;

  return {
    ...state,
    users: nextUsers,
  };
}
