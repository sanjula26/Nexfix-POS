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

/**
 * Fingerprint every active administrator credential plus the shared admin PIN.
 * A cached sensitive-action re-authentication is valid only while this exact
 * credential set and the authenticated operator remain unchanged.
 */
export function getAdminCredentialFingerprint(
  state: Pick<POSState, 'users' | 'settings'>,
): string {
  const admins = state.users
    .filter(user => user.role === 'admin' && user.active)
    .map(user => [user.id, user.password] as [string, string])
    .sort((left, right) => left[0].localeCompare(right[0]));
  return JSON.stringify({
    admins,
    adminPinHash: state.settings.adminPinHash || '',
  });
}
