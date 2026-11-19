import type { POSState } from './types';

/**
 * Build a state update only while the admin PIN hash still matches the
 * credential snapshot that was verified. Async verifiers must use this
 * compare-and-set guard so a delayed legacy upgrade cannot overwrite a
 * concurrently changed PIN.
 */
export function replaceAdminPinHashIfCurrent(
  state: POSState,
  expectedHash: string,
  replacementHash: string,
): POSState | null {
  if ((state.settings.adminPinHash || '') !== expectedHash) return null;
  return {
    ...state,
    settings: { ...state.settings, adminPinHash: replacementHash },
  };
}

export type AdminCredentialSnapshot = {
  admins: Array<{ id: string; password: string }>;
  adminPinHash: string;
};

/**
 * Capture references to active administrator credentials and the shared PIN.
 * Keep credential values as separate references rather than concatenating
 * them into a fingerprint string (legacy accounts may still have plain text).
 */
export function captureAdminCredentialSnapshot(
  state: Pick<POSState, 'users' | 'settings'>,
): AdminCredentialSnapshot {
  const admins = state.users
    .filter(user => user.role === 'admin' && user.active)
    .map(user => ({ id: user.id, password: user.password }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    admins,
    adminPinHash: state.settings.adminPinHash || '',
  };
}

export function adminCredentialSnapshotMatches(
  state: Pick<POSState, 'users' | 'settings'>,
  snapshot: AdminCredentialSnapshot,
): boolean {
  const current = captureAdminCredentialSnapshot(state);
  return current.adminPinHash === snapshot.adminPinHash
    && current.admins.length === snapshot.admins.length
    && current.admins.every((admin, index) =>
      admin.id === snapshot.admins[index].id
      && admin.password === snapshot.admins[index].password
    );
}


/** Return only the active administrator who owns the current POS session. */
export function findActiveAdminById(
  state: Pick<POSState, 'users'>,
  userId: string,
): POSState['users'][number] | null {
  return state.users.find(user => user.id === userId && user.role === 'admin' && user.active) ?? null;
}
