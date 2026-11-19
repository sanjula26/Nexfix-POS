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
