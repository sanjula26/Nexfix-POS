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

export type StorageOverflowMigrationResult = {
  profileId: string;
  journal: Awaited<ReturnType<typeof beginDesktopPOSStorageMigration>>;
  stateSavedToIndexedDB: boolean;
  queueMarkerSavedToIndexedDB: boolean;
};

type MigrationPayloads = Record<DesktopPOSMigrationPurpose, unknown>;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

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

function cutoverUncertain(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' &&
    (error as { code?: unknown }).code === 'ERR_POS_STORAGE_CUTOVER_UNCERTAIN');
}

/**
 * Copy the latest in-memory POS state plus every remaining IndexedDB domain to
 * the already-unlocked encrypted folder profile. IndexedDB is never cleared.
 */
export async function migrateIndexedDBToEncryptedPOSFolder(
  pauseStorageMaintenance: () => Promise<POSStorageMaintenanceLease>,
): Promise<StorageOverflowMigrationResult> {
  const profile = await getDesktopPOSProfileStatus();
  if (!profile.unlocked || !profile.profile?.profileId) {
    throw new Error('Unlock the encrypted POS profile before starting storage migration.');
  }

  const lease = await pauseStorageMaintenance();
  let releaseOnFinish = true;
  try {
    const legacy = await idbReadLegacyProfileSnapshot();
    let snapshot: LegacyPOSProfileSnapshot | null = null;
    if (legacy.status === 'present' || legacy.status === 'missing_state') {
      snapshot = legacy.snapshot;
    } else if (legacy.status !== 'missing_database') {
      throw new Error(legacy.status === 'invalid_database' || legacy.status === 'invalid_state' || legacy.status === 'unavailable'
        ? legacy.reason
        : 'The existing IndexedDB data could not be read safely.');
    }

    const payloads = buildPayloads(snapshot, lease.latestState, lease.queueSaved);
    const serialized = {} as Record<DesktopPOSMigrationPurpose, string>;
    const copied = {} as Record<DesktopPOSMigrationPurpose, { revision: number; bytes: number; sha256: string }>;
    const purposes: DesktopPOSMigrationPurpose[] = ['app_state', 'sync_queue', 'meta', 'restore_checkpoint'];

    let journal = await beginDesktopPOSStorageMigration();
    await transitionDesktopPOSStorageMigration('copying');

    for (const purpose of purposes) {
      const payload = JSON.stringify(payloads[purpose]);
      if (typeof payload !== 'string') throw new Error(`POS ${purpose} data could not be serialized.`);
      serialized[purpose] = payload;
      const result = await writeDesktopProfilePayload(purpose, payload);
      const sha256 = await sha256Hex(payload);
      if (result.bytes !== new TextEncoder().encode(payload).byteLength) {
        throw new Error(`POS ${purpose} write size did not match the encrypted storage response.`);
      }
      copied[purpose] = { revision: result.revision, bytes: result.bytes, sha256 };
      journal = await recordDesktopPOSMigrationCopy(purpose, copied[purpose]);
    }

    await transitionDesktopPOSStorageMigration('verifying');
    for (const purpose of purposes) {
      const readBack = await readDesktopProfilePayload(purpose);
      if (readBack === null || readBack !== serialized[purpose]) {
        throw new Error(`POS ${purpose} read-back did not match the source snapshot.`);
      }
      const sha256 = await sha256Hex(readBack);
      if (sha256 !== copied[purpose].sha256 ||
          new TextEncoder().encode(readBack).byteLength !== copied[purpose].bytes) {
        throw new Error(`POS ${purpose} integrity verification failed.`);
      }
      journal = await recordDesktopPOSMigrationVerification(purpose, copied[purpose]);
    }

    journal = await transitionDesktopPOSStorageMigration('ready_to_cutover');
    try {
      journal = await transitionDesktopPOSStorageMigration('folder_primary');
    } catch (error) {
      if (cutoverUncertain(error)) {
        releaseOnFinish = false;
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('nexfix:storage-primary-error', {
            detail: { message: error instanceof Error ? error.message : 'POS storage cutover is uncertain. Keep POS closed.' },
          }));
        }
      }
      throw error;
    }

    try {
      setDesktopProfilePrimary(true);
    } catch {
      releaseOnFinish = false;
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('nexfix:storage-primary-error', {
          detail: { message: 'Folder-primary cutover committed but the file-backed database adapter could not be activated. Keep POS closed and restart Nexfix.' },
        }));
      }
      const uncertain = new Error('Folder-primary cutover committed but the file-backed database adapter could not be activated. Keep POS closed and restart Nexfix.') as Error & { code?: string };
      uncertain.code = 'ERR_POS_STORAGE_CUTOVER_UNCERTAIN';
      throw uncertain;
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('nexfix:storage-primary-committed'));
    }
    return {
      profileId: profile.profile.profileId,
      journal,
      stateSavedToIndexedDB: lease.stateSaved,
      queueMarkerSavedToIndexedDB: lease.queueSaved,
    };
  } catch (error) {
    // Before a confirmed folder-primary cutover, IndexedDB remains the source
    // of truth. Persist an explicit recovery state so an interrupted copy is
    // never mistaken for a completed migration on the next launch.
    if (!cutoverUncertain(error)) {
      try {
        const current = await getDesktopPOSMigrationJournal();
        if (current && current.phase !== 'folder_primary' && current.phase !== 'blocked_recovery') {
          await transitionDesktopPOSStorageMigration('blocked_recovery');
        }
      } catch {
        // Preserve the original failure. A later startup can still inspect the
        // encrypted journal and keep IndexedDB primary.
      }
    }
    throw error;
  } finally {
    if (releaseOnFinish) lease.release();
  }
}
