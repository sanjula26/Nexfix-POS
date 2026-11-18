import type { POSState } from './types';
import { idbReadState, idbSaveState } from './db';

/**
 * Persist a fully validated restore and verify the committed row before the
 * caller is allowed to clear its rollback checkpoint.
 *
 * Backup envelopes are JSON data, so JSON serialization gives us a stable
 * comparison of the complete business state without relying on object identity
 * across IndexedDB's structured-clone boundary.
 */
export async function persistAndVerifyRestoredState(nextState: POSState): Promise<void> {
  const saved = await idbSaveState(nextState);
  if (!saved) throw new Error('Could not persist restored POS state.');

  const persisted = await idbReadState();
  if (!persisted || JSON.stringify(persisted) !== JSON.stringify(nextState)) {
    throw new Error('Restored POS state could not be verified after saving. The restore must be rolled back.');
  }
}
