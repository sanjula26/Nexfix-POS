import type { POSState } from './types';
import { idbClearRestoreCheckpoint, idbLoadRestoreCheckpoint, idbSaveRestoreCheckpoint, idbSaveState } from './db';
import { validateBackupForRestore, type BackupEnvelope } from './backup';

export async function prepareRestore(current: POSState): Promise<void> {
  const saved = await idbSaveRestoreCheckpoint(current);
  if (!saved) throw new Error('Could not create restore checkpoint. Restore cancelled.');
}

export async function rollbackRestore(): Promise<boolean> {
  const checkpoint = await idbLoadRestoreCheckpoint();
  if (!checkpoint) return false;
  const restored = await idbSaveState(checkpoint);
  if (restored) await idbClearRestoreCheckpoint();
  return restored;
}

export async function restoreBackup(input: unknown): Promise<BackupEnvelope> {
  return validateBackupForRestore(input);
}

/**
 * Validate and apply a backup as one guarded local restore flow.
 * A checkpoint is created before any state replacement. If the new state
 * cannot be persisted, the previous state is restored from that checkpoint.
 */
export async function applyBackupRestore(current: POSState, input: unknown): Promise<POSState> {
  const backup = await restoreBackup(input);
  await prepareRestore(current);
  try {
    const saved = await idbSaveState(backup.state);
    if (!saved) throw new Error('Could not persist restored POS state.');
    await idbClearRestoreCheckpoint();
    return backup.state;
  } catch (error) {
    const rolledBack = await rollbackRestore();
    if (!rolledBack) {
      throw new Error('Restore failed and automatic rollback could not be completed.', { cause: error });
    }
    throw error;
  }
}

export async function completeRestore(): Promise<void> {
  await idbClearRestoreCheckpoint();
}
