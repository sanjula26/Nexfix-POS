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

export async function completeRestore(): Promise<void> {
  await idbClearRestoreCheckpoint();
}
