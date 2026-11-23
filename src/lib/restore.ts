import type { POSState } from './types';
import { idbClearRestoreCheckpoint, idbLoadRestoreCheckpoint, idbSaveRestoreCheckpoint, idbSaveState } from './db';
import { validateBackupForRestore, type BackupEnvelope } from './backup';
import { isCloudSafeBackup } from './driveSync';
import { createDrainableWorkGate } from './drainableWorkGate';

const SESSION_KEY = 'nexfix_session_v1';

type LocalSession = { userId?: string };

function currentUserRole(state: POSState): string | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as LocalSession;
    if (!session.userId) return null;
    return state.users.find(user => user.id === session.userId && user.active)?.role || null;
  } catch {
    return null;
  }
}

function requireAdminRestoreAccess(state: POSState): void {
  if (currentUserRole(state) !== 'admin') {
    throw new Error('Only an active admin can restore POS data.');
  }
}

async function prepareRestore(current: POSState): Promise<void> {
  const saved = await idbSaveRestoreCheckpoint(current);
  if (!saved) throw new Error('Could not create restore checkpoint. Restore cancelled.');
}

async function rollbackRestore(): Promise<boolean> {
  const checkpoint = await idbLoadRestoreCheckpoint();
  if (!checkpoint) return false;
  const restored = await idbSaveState(checkpoint);
  if (!restored) return false;
  return idbClearRestoreCheckpoint();
}

export async function restoreBackup(input: unknown): Promise<BackupEnvelope> {
  return validateBackupForRestore(input);
}

function isBackupEnvelope(input: unknown): input is BackupEnvelope {
  return !!input && typeof input === 'object' && '_meta' in input && 'state' in input;
}

function asRestoreEnvelope(input: unknown): BackupEnvelope {
  if (isCloudSafeBackup(input)) {
    const cloud = input as { state?: unknown };
    return {
      _meta: {
        app: 'Nexfix POS',
        version: 2,
        exportedAt: new Date().toISOString(),
        kind: 'manual',
      },
      state: cloud.state as POSState,
    };
  }
  if (isBackupEnvelope(input)) return input;
  return {
    _meta: {
      app: 'Nexfix POS',
      version: 2,
      exportedAt: new Date().toISOString(),
      kind: 'manual',
    },
    state: input as POSState,
  };
}

function restoreLocalAuthentication(current: POSState, restored: POSState): POSState {
  return {
    ...restored,
    // User credentials are device-local authentication data, never business
    // backup data. Keep the complete current user set and the current admin PIN.
    users: current.users,
    settings: {
      ...restored.settings,
      adminPinHash: current.settings.adminPinHash,
    },
  };
}

/**
 * Validate and apply a backup as one guarded local restore flow.
 * Restore is an admin-only destructive operation. A checkpoint is created
 * before any state replacement. If the new state cannot be persisted, the
 * previous state is restored from that checkpoint.
 *
 * Google backups deliberately contain no local user records or authentication
 * secrets. A cloud restore therefore cannot create, modify, erase or replace
 * device credentials.
 */
async function applyBackupRestoreWork(current: POSState, input: unknown): Promise<POSState> {
  requireAdminRestoreAccess(current);
  const cloudSafe = isCloudSafeBackup(input);
  const backup = await restoreBackup(asRestoreEnvelope(input));
  const nextState = cloudSafe ? restoreLocalAuthentication(current, backup.state) : backup.state;
  await prepareRestore(current);
  try {
    const saved = await idbSaveState(nextState);
    if (!saved) throw new Error('Could not persist restored POS state.');
    const checkpointCleared = await idbClearRestoreCheckpoint();
    if (!checkpointCleared) throw new Error('Could not clear the restore safety checkpoint.');
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('nexfix:restore-committed', { detail: { state: nextState } }));
    }
    return nextState;
  } catch (error) {
    const rolledBack = await rollbackRestore();
    if (!rolledBack) {
      throw new Error('Restore failed and automatic rollback could not be completed.', { cause: error });
    }
    throw error;
  }
}


/**
 * A restore is one indivisible storage operation: checkpoint, replacement,
 * checkpoint cleanup, and any rollback must finish before a migration snapshot.
 */
const restoreWork = createDrainableWorkGate();

export function pauseRestoreWork(): Promise<() => void> {
  return restoreWork.pause();
}

export function applyBackupRestore(current: POSState, input: unknown): Promise<POSState> {
  return restoreWork.run(
    () => applyBackupRestoreWork(current, input),
    () => { throw new Error('POS restore is temporarily paused for safe storage maintenance.'); },
  );
}

async function completeRestoreWork(): Promise<void> {
  const cleared = await idbClearRestoreCheckpoint();
  if (!cleared) throw new Error('Could not clear the restore safety checkpoint.');
}

export function completeRestore(): Promise<void> {
  return restoreWork.run(
    completeRestoreWork,
    () => { throw new Error('POS restore checkpoint cleanup is temporarily paused for safe storage maintenance.'); },
  );
}
