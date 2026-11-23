import assert from 'node:assert/strict';
import test from 'node:test';
import { runEncryptedPOSFolderMigration, type MigrationDependencies, type MigrationJournal, type MigrationPurpose } from '../src/lib/storageOverflowMigrationCore.ts';

type Journal = MigrationJournal & { phase: string; sequence: number };
const purposes: MigrationPurpose[] = ['app_state', 'sync_queue', 'meta', 'restore_checkpoint'];

function harness(failAt?: string) {
  let activeFailure = failAt;
  const files = new Map<MigrationPurpose, string>();
  const verified: MigrationPurpose[] = [];
  const copied: MigrationPurpose[] = [];
  const transitions: string[] = [];
  let phase = 'snapshotting';
  let released = 0;
  let primary = false;
  let sequence = 0;
  const lease = { latestState: { sales: [{ id: 'sale-1', total: 750 }] }, stateSaved: false, queueSaved: false, release: () => { released += 1; } };
  const journal = (): Journal => ({ phase, sequence: ++sequence });
  const dependencies: MigrationDependencies<Journal, { queue: unknown[] }> = {
    getProfileStatus: async () => ({ unlocked: true, profile: { profileId: 'profile-123' } }),
    pauseStorageMaintenance: async () => lease,
    readSnapshot: async () => ({ queue: [{ id: 'queued-sale' }] }),
    buildPayloads: (snapshot, latestState, queueSaved) => ({
      app_state: latestState,
      sync_queue: { queue: snapshot?.queue ?? [], queueSaved },
      meta: { backupCount: 2 },
      restore_checkpoint: { checkpointId: 'restore-1' },
    }),
    getJournal: async () => journal(),
    begin: async () => { phase = 'snapshotting'; return journal(); },
    transition: async next => {
      transitions.push(next);
      if (activeFailure === `transition:${next}`) {
        const error = new Error('injected transition failure') as Error & { code?: string };
        if (next === 'folder_primary') error.code = 'ERR_POS_STORAGE_CUTOVER_UNCERTAIN';
        throw error;
      }
      phase = next;
      return journal();
    },
    recordCopy: async purpose => { copied.push(purpose); return journal(); },
    recordVerification: async purpose => { verified.push(purpose); return journal(); },
    writePayload: async (purpose, serialized) => {
      if (activeFailure === `write:${purpose}`) throw new Error('injected write failure');
      files.set(purpose, serialized);
      return { revision: 1, bytes: new TextEncoder().encode(serialized).byteLength };
    },
    readPayload: async purpose => {
      if (activeFailure === `read:${purpose}`) return '{"tampered":true}';
      return files.get(purpose) ?? null;
    },
    setFolderPrimary: () => {
      if (activeFailure === 'activate-primary') throw new Error('adapter activation failed');
      primary = true;
    },
  };
  return { dependencies, files, copied, verified, transitions, lease, setFailure: (next?: string) => { activeFailure = next; }, get released() { return released; }, get primary() { return primary; }, get phase() { return phase; } };
}

test('copies and verifies all four domains before switching folder storage primary', async () => {
  const h = harness();
  const result = await runEncryptedPOSFolderMigration(h.dependencies);
  assert.deepEqual(h.copied, purposes);
  assert.deepEqual(h.verified, purposes);
  assert.equal(h.phase, 'folder_primary');
  assert.equal(h.primary, true);
  assert.equal(h.released, 1);
  assert.equal(result.profileId, 'profile-123');
  assert.equal(result.stateSavedToIndexedDB, false);
  assert.equal(result.queueMarkerSavedToIndexedDB, false);
  assert.deepEqual(JSON.parse(h.files.get('app_state')!), { sales: [{ id: 'sale-1', total: 750 }] });
});

test('copy failure marks blocked recovery and releases maintenance so IndexedDB can continue', async () => {
  const h = harness('write:sync_queue');
  await assert.rejects(runEncryptedPOSFolderMigration(h.dependencies), /injected write failure/);
  assert.equal(h.transitions.at(-1), 'blocked_recovery');
  assert.equal(h.released, 1);
  assert.equal(h.primary, false);
  assert.equal(h.phase, 'blocked_recovery');
});

test('read-back mismatch blocks cutover and preserves the IndexedDB primary', async () => {
  const h = harness('read:meta');
  await assert.rejects(runEncryptedPOSFolderMigration(h.dependencies), /read-back did not match/);
  assert.equal(h.transitions.at(-1), 'blocked_recovery');
  assert.equal(h.released, 1);
  assert.equal(h.primary, false);
});

test('uncertain main-process cutover keeps the maintenance lease held and does not mark recovery as safe', async () => {
  const h = harness('transition:folder_primary');
  await assert.rejects(runEncryptedPOSFolderMigration(h.dependencies), /injected transition failure/);
  assert.equal(h.transitions.includes('blocked_recovery'), false);
  assert.equal(h.released, 0);
  assert.equal(h.primary, false);
});

test('adapter activation failure after committed cutover keeps POS maintenance locked', async () => {
  const h = harness('activate-primary');
  await assert.rejects(runEncryptedPOSFolderMigration(h.dependencies), /adapter could not be activated/);
  assert.equal(h.phase, 'folder_primary');
  assert.equal(h.transitions.includes('blocked_recovery'), false);
  assert.equal(h.released, 0);
  assert.equal(h.primary, false);
});

test('refuses to start without an unlocked encrypted profile and does not acquire a maintenance lease', async () => {
  const h = harness();
  h.dependencies.getProfileStatus = async () => ({ unlocked: false });
  await assert.rejects(runEncryptedPOSFolderMigration(h.dependencies), /Unlock the encrypted POS profile/);
  assert.equal(h.released, 0);
  assert.equal(h.transitions.length, 0);
});


test('retries from a blocked recovery journal using a fresh verified snapshot', async () => {
  const h = harness('write:sync_queue');
  await assert.rejects(runEncryptedPOSFolderMigration(h.dependencies), /injected write failure/);
  assert.equal(h.phase, 'blocked_recovery');
  assert.equal(h.released, 1);

  h.setFailure(undefined);
  const result = await runEncryptedPOSFolderMigration(h.dependencies);
  assert.equal(result.journal.phase, 'folder_primary');
  assert.equal(h.phase, 'folder_primary');
  assert.equal(h.primary, true);
  assert.equal(h.released, 2);
});
