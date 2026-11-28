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
