export type MigrationPurpose = 'app_state' | 'sync_queue' | 'meta' | 'restore_checkpoint';

export type MigrationLease<TState = unknown> = {
  latestState: TState;
  stateSaved: boolean;
  queueSaved: boolean;
  release: () => void;
};

export type MigrationSnapshot = unknown;
export type MigrationJournal = { phase: string };

export type MigrationDependencies<J extends MigrationJournal, S extends MigrationSnapshot, TState = unknown> = {
  getProfileStatus: () => Promise<{ unlocked: boolean; profile?: { profileId?: string } }>;
  pauseStorageMaintenance: () => Promise<MigrationLease<TState>>;
  readSnapshot: () => Promise<S | null>;
  buildPayloads: (snapshot: S | null, latestState: TState, queueSaved: boolean) => Record<MigrationPurpose, unknown>;
  getJournal: () => Promise<J | null>;
  begin: () => Promise<J>;
  transition: (phase: 'copying' | 'verifying' | 'ready_to_cutover' | 'folder_primary' | 'blocked_recovery') => Promise<J>;
  recordCopy: (purpose: MigrationPurpose, details: { revision: number; bytes: number; sha256: string }) => Promise<J>;
  recordVerification: (purpose: MigrationPurpose, details: { revision: number; bytes: number; sha256: string }) => Promise<J>;
  writePayload: (purpose: MigrationPurpose, serialized: string) => Promise<{ revision: number; bytes: number }>;
  readPayload: (purpose: MigrationPurpose) => Promise<string | null>;
  setFolderPrimary: () => void;
  onCutoverUncertain?: (message: string) => void;
};

const PURPOSES: MigrationPurpose[] = ['app_state', 'sync_queue', 'meta', 'restore_checkpoint'];

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function isCutoverUncertain(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' &&
    (error as { code?: unknown }).code === 'ERR_POS_STORAGE_CUTOVER_UNCERTAIN');
}

/**
 * Coordinates the encrypted-folder copy and verified cutover.
 * All side effects are injected so failure/retry behavior can be tested without Electron.
 */
export async function runEncryptedPOSFolderMigration<J extends MigrationJournal, S extends MigrationSnapshot, TState = unknown>(
  dependencies: MigrationDependencies<J, S, TState>,
): Promise<{
  profileId: string;
  journal: J;
  stateSavedToIndexedDB: boolean;
  queueMarkerSavedToIndexedDB: boolean;
}> {
  const profile = await dependencies.getProfileStatus();
  if (!profile.unlocked || !profile.profile?.profileId) {
    throw new Error('Unlock the encrypted POS profile before starting storage migration.');
  }

  const lease = await dependencies.pauseStorageMaintenance();
  let releaseOnFinish = true;
  try {
    const snapshot = await dependencies.readSnapshot();
    const payloads = dependencies.buildPayloads(snapshot, lease.latestState, lease.queueSaved);
    const serialized = {} as Record<MigrationPurpose, string>;
    const copied = {} as Record<MigrationPurpose, { revision: number; bytes: number; sha256: string }>;

    let journal = await dependencies.begin();
    await dependencies.transition('copying');

    for (const purpose of PURPOSES) {
      const payload = JSON.stringify(payloads[purpose]);
      if (typeof payload !== 'string') throw new Error(`POS ${purpose} data could not be serialized.`);
      serialized[purpose] = payload;
      const result = await dependencies.writePayload(purpose, payload);
      const bytes = new TextEncoder().encode(payload).byteLength;
      if (result.bytes !== bytes) {
        throw new Error(`POS ${purpose} write size did not match the encrypted storage response.`);
      }
      const sha256 = await sha256Hex(payload);
      copied[purpose] = { revision: result.revision, bytes: result.bytes, sha256 };
      journal = await dependencies.recordCopy(purpose, copied[purpose]);
    }

    await dependencies.transition('verifying');
    for (const purpose of PURPOSES) {
      const readBack = await dependencies.readPayload(purpose);
      if (readBack === null || readBack !== serialized[purpose]) {
        throw new Error(`POS ${purpose} read-back did not match the source snapshot.`);
      }
      const sha256 = await sha256Hex(readBack);
      if (sha256 !== copied[purpose].sha256 ||
          new TextEncoder().encode(readBack).byteLength !== copied[purpose].bytes) {
        throw new Error(`POS ${purpose} integrity verification failed.`);
      }
      journal = await dependencies.recordVerification(purpose, copied[purpose]);
    }

    await dependencies.transition('ready_to_cutover');
    try {
      journal = await dependencies.transition('folder_primary');
    } catch (error) {
      if (isCutoverUncertain(error)) {
        releaseOnFinish = false;
        dependencies.onCutoverUncertain?.(error instanceof Error ? error.message : 'POS storage cutover is uncertain. Keep POS closed.');
      }
      throw error;
    }

    try {
      dependencies.setFolderPrimary();
    } catch {
      releaseOnFinish = false;
      const message = 'Folder-primary cutover committed but the file-backed database adapter could not be activated. Keep POS closed and restart Nexfix.';
      dependencies.onCutoverUncertain?.(message);
      const uncertain = new Error(message) as Error & { code?: string };
      uncertain.code = 'ERR_POS_STORAGE_CUTOVER_UNCERTAIN';
      throw uncertain;
    }

    return {
      profileId: profile.profile.profileId,
      journal,
      stateSavedToIndexedDB: lease.stateSaved,
      queueMarkerSavedToIndexedDB: lease.queueSaved,
    };
  } catch (error) {
    // Until cutover is confirmed, IndexedDB remains authoritative. Record a
    // recovery phase so a partial folder copy is never treated as complete.
    if (!isCutoverUncertain(error)) {
      try {
        const current = await dependencies.getJournal();
        if (current && current.phase !== 'folder_primary' && current.phase !== 'blocked_recovery') {
          await dependencies.transition('blocked_recovery');
        }
      } catch {
        // Preserve the original error; startup must still inspect the journal.
      }
    }
    throw error;
  } finally {
    if (releaseOnFinish) lease.release();
  }
}
