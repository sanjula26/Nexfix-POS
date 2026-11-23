import {
  idbReadLegacyProfileSnapshot,
  type LegacyPOSProfileSnapshot,
} from './db';
import { ensureOfflineStateWriteMarker } from './storageOverflowQueue.ts';
import {
  beginDesktopPOSStorageMigration,
  getDesktopPOSProfileStatus,
  getDesktopPOSMigrationJournal,
  recordDesktopPOSMigrationCopy,
  recordDesktopPOSMigrationVerification,
  transitionDesktopPOSStorageMigration,
  writeDesktopProfilePayload,
  readDesktopProfilePayload,
  type DesktopPOSMigrationPurpose,
} from './desktopProfileStorage';
import { setDesktopProfilePrimary } from './db';
import type { POSStorageMaintenanceLease } from './store';
import { runEncryptedPOSFolderMigration } from './storageOverflowMigrationCore.ts';

export type StorageOverflowMigrationResult = {
  profileId: string;
  journal: Awaited<ReturnType<typeof beginDesktopPOSStorageMigration>>;
  stateSavedToIndexedDB: boolean;
  queueMarkerSavedToIndexedDB: boolean;
};

type MigrationPayloads = Record<DesktopPOSMigrationPurpose, unknown>;

function buildPayloads(
  snapshot: LegacyPOSProfileSnapshot | null,
  latestState: POSStorageMaintenanceLease['latestState'],
  queueMarkerSaved: boolean,
): MigrationPayloads {
  return {
    app_state: latestState,
    sync_queue: ensureOfflineStateWriteMarker(snapshot?.queue ?? [], queueMarkerSaved),
    meta: snapshot?.meta ?? { autoBackupHours: 6, backupCount: 0 },
    restore_checkpoint: snapshot?.restoreCheckpoint ?? null,
  };
}

/**
 * Copy the latest in-memory POS state plus every remaining IndexedDB domain to
 * the already-unlocked encrypted folder profile. IndexedDB is never cleared.
 */
export async function migrateIndexedDBToEncryptedPOSFolder(
  pauseStorageMaintenance: () => Promise<POSStorageMaintenanceLease>,
): Promise<StorageOverflowMigrationResult> {
  return runEncryptedPOSFolderMigration({
    getProfileStatus: getDesktopPOSProfileStatus,
    pauseStorageMaintenance,
    readSnapshot: async () => {
      const legacy = await idbReadLegacyProfileSnapshot();
      if (legacy.status === 'present' || legacy.status === 'missing_state') return legacy.snapshot;
      if (legacy.status === 'missing_database') return null;
      if (legacy.status === 'invalid_database' || legacy.status === 'invalid_state' || legacy.status === 'unavailable') {
        throw new Error(legacy.reason);
      }
      throw new Error('The existing IndexedDB data could not be read safely.');
    },
    buildPayloads,
    getJournal: getDesktopPOSMigrationJournal,
    begin: beginDesktopPOSStorageMigration,
    transition: transitionDesktopPOSStorageMigration,
    recordCopy: recordDesktopPOSMigrationCopy,
    recordVerification: recordDesktopPOSMigrationVerification,
    writePayload: writeDesktopProfilePayload,
    readPayload: readDesktopProfilePayload,
    setFolderPrimary: () => {
      try {
        setDesktopProfilePrimary(true);
      } catch {
        const error = new Error('Folder-primary cutover committed but the file-backed database adapter could not be activated. Keep POS closed and restart Nexfix.') as Error & { code?: string };
        error.code = 'ERR_POS_STORAGE_CUTOVER_UNCERTAIN';
        throw error;
      }
    },
    onCutoverUncertain: message => {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('nexfix:storage-primary-error', { detail: { message } }));
      }
    },
  });
}
