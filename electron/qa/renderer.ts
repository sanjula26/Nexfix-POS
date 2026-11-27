import { runAutomaticPOSOverflowMigration } from '../../src/lib/storageOverflowAutoMigration.ts';
import {
  runEncryptedPOSFolderMigration,
  type MigrationDependencies,
} from '../../src/lib/storageOverflowMigrationCore.ts';
import {
  beginDesktopPOSStorageMigration,
  createDesktopPOSProfile,
  discoverDesktopPOSProfiles,
  getConfiguredPOSOverflowFolder,
  getDesktopPOSMigrationJournal,
  getDesktopPOSProfileStatus,
  lockDesktopPOSProfile,
  readDesktopProfilePayload,
  recordDesktopPOSMigrationCopy,
  recordDesktopPOSMigrationVerification,
  transitionDesktopPOSStorageMigration,
  unlockDesktopPOSProfileWithOS,
  writeDesktopProfilePayload,
} from '../../src/lib/desktopProfileStorage.ts';
import { subscribeToStorageQuotaWarnings } from '../../src/lib/storageOverflowEvents.ts';
import {
  idbEnqueueDetailed,
  idbGetMeta,
  idbGetMetaValue,
  idbListQueue,
  idbLoadRestoreCheckpoint,
  idbLoadState,
  idbPutMetaValue,
  idbReadLegacyProfileSnapshot,
  idbSaveRestoreCheckpointDetailed,
  idbSaveStateDetailed,
  idbSetMetaDetailed,
  type LegacyPOSProfileSnapshot,
} from '../../src/lib/db.ts';
import { ensureOfflineStateWriteMarker } from '../../src/lib/storageOverflowQueue.ts';
import type { POSState } from '../../src/lib/types.ts';
import { setDesktopProfilePrimary } from '../../src/lib/db.ts';
import { installOneShotQaQuotaInjection, type QaQuotaDomain } from './quota-injector.ts';

const chooseButton = document.getElementById('choose-folder') as HTMLButtonElement;
const profileButton = document.getElementById('create-profile') as HTMLButtonElement;
const injectButton = document.getElementById('inject-quota') as HTMLButtonElement;
const result = document.getElementById('result') as HTMLParagraphElement;
const folderPathElement = document.getElementById('folder-path') as HTMLElement;
const quotaDomainSelect = document.getElementById('quota-domain') as HTMLSelectElement;
let selectedFolder: string | null = null;
let profileReady = false;
let injectionUsed = false;
let quotaEventReceived = false;
let migrationPromise: Promise<void> | null = null;
let activeMigrationFixture: { latestState: POSState; stateSaved: boolean; queueSaved: boolean } | null = null;
let sourceSnapshotAtCutover: LegacyPOSProfileSnapshot | null = null;

subscribeToStorageQuotaWarnings(window, detail => {
  if (detail.reason !== 'quota_exceeded' || migrationPromise) return;
  quotaEventReceived = true;
  result.textContent = 'Quota warning received. Starting the real automatic encrypted-folder migration coordinator…';
  migrationPromise = runAutomaticPOSOverflowMigration({
    getFolder: getConfiguredPOSOverflowFolder,
    discoverProfiles: async root => {
      const found = await discoverDesktopPOSProfiles(root);
      return { available: found.available, duplicates: found.duplicates, invalid: found.invalid };
    },
    getProfileStatus: getDesktopPOSProfileStatus,
    unlockWithOS: unlockDesktopPOSProfileWithOS,
    migrate: async () => {
      const fixture = activeMigrationFixture;
      if (!fixture) throw new Error('The isolated QA migration fixture is not ready.');
      sourceSnapshotAtCutover = await migrateQaFixtureToEncryptedFolder(fixture.latestState, fixture.stateSaved, fixture.queueSaved);
    },
  }).then(async outcome => {
    if (outcome.status === 'migrated') {
      result.textContent = 'PASS: automatic migration completed for profile ' + outcome.profileId + '. All four encrypted domains were read back and verified; IndexedDB fixture remains intact.';
      await refreshFolderStatus();
    } else if (outcome.status === 'unlock_required') {
      result.textContent = 'BLOCKED: Windows OS unlock is unavailable. Manual passphrase/recovery-key unlock is required for ' + outcome.profileDirectory + '.';
    } else {
      throw new Error('The automatic encrypted-folder migration did not complete.');
    }
  }).catch(error => {
    result.textContent = 'Migration QA failed safely: ' + (error instanceof Error ? error.message : 'unknown error');
    throw error;
  });
});

function createQaPosState(runId: string): POSState {
  return {
    products: [],
    users: [],
    sales: [{
      id: 'QA-SALE-' + runId,
      date: new Date().toISOString(),
      total: 1250,
    }],
  } as unknown as POSState;
}

function createQaGrnWorkingDraft(runId: string) {
  return {
    id: 'QA-GRN-' + runId,
    editingId: null,
    supplierId: 'QA-SUPPLIER-001',
    invoiceNo: 'QA-INVOICE-' + runId,
    notes: 'Disposable GRN draft copied with the encrypted storage profile.',
    rows: [{
      productId: 'QA-PRODUCT-001',
      qty: 2,
      cost: 500,
      sellingPrice: 750,
      updateSellingPrice: false,
      unitText: 'QA-IMEI-' + runId,
    }],
    savedAt: new Date().toISOString(),
  };
}

async function seedIndexedDbFixture(runId: string): Promise<{
  baselineState: POSState;
  latestState: POSState;
  draftKey: string;
  draft: ReturnType<typeof createQaGrnWorkingDraft>;
}> {
  const baselineState = createQaPosState(runId);
  const latestState = {
    ...baselineState,
    sales: [
      ...baselineState.sales,
      { id: 'QA-SALE-MEMORY-' + runId, date: new Date().toISOString(), total: 2500 },
    ],
  } as POSState;
  const draftKey = 'grn_working_draft_v1:qa:' + runId;
  const draft = createQaGrnWorkingDraft(runId);

  const stateResult = await idbSaveStateDetailed(baselineState);
  if (!stateResult.ok) throw new Error('Could not seed the isolated QA POS state: ' + stateResult.error.message);
  const checkpointResult = await idbSaveRestoreCheckpointDetailed(baselineState);
  if (!checkpointResult.ok) throw new Error('Could not seed the isolated QA restore checkpoint: ' + checkpointResult.error.message);
  const queueResult = await idbEnqueueDetailed({
    id: 'QA-QUEUE-' + runId,
    ts: new Date().toISOString(),
    type: 'sale_create',
    payload: JSON.stringify({ saleId: 'QA-SALE-' + runId, total: 1250 }),
  });
  if (!queueResult.ok) throw new Error('Could not seed the isolated QA sync queue: ' + queueResult.error.message);
  const metaResult = await idbSetMetaDetailed({
    autoBackupHours: 6,
    backupCount: 1,
    grnWorkingDrafts: { [draftKey]: draft },
  });
  if (!metaResult.ok) throw new Error('Could not seed the isolated QA backup/GRN metadata: ' + metaResult.error.message);

  return { baselineState, latestState, draftKey, draft };
}

async function failOneProductionIndexedDbWrite(
  domain: QaQuotaDomain,
  runId: string,
  latestState: POSState,
): Promise<void> {
  let injectionMessage = '';
  const injector = installOneShotQaQuotaInjection(domain, runId, error => {
    injectionMessage = error.message;
    result.textContent = 'Injected QuotaExceededError at the production IndexedDB transaction boundary for ' + domain + '.';
  });

  let writeResult:
    | Awaited<ReturnType<typeof idbSaveStateDetailed>>
    | Awaited<ReturnType<typeof idbSaveRestoreCheckpointDetailed>>
    | Awaited<ReturnType<typeof idbEnqueueDetailed>>
    | Awaited<ReturnType<typeof idbSetMetaDetailed>>;

  try {
    switch (domain) {
      case 'app_state':
        writeResult = await idbSaveStateDetailed(latestState);
        break;
      case 'restore_checkpoint':
        writeResult = await idbSaveRestoreCheckpointDetailed(latestState);
        break;
      case 'sync_queue':
        writeResult = await idbEnqueueDetailed({
          id: 'QA-QUEUE-FAIL-' + runId,
          ts: new Date().toISOString(),
          type: 'sale_create',
          payload: JSON.stringify({ saleId: 'QA-SALE-FAIL-' + runId, total: 2500 }),
        });
        break;
      case 'meta':
        writeResult = await idbSetMetaDetailed(current => ({
          grnWorkingDrafts: {
            ...(current.grnWorkingDrafts || {}),
            ['grn_working_draft_v1:qa:' + runId]: {
              id: 'QA-GRN-FAILED-' + runId,
              editingId: null,
              supplierId: 'QA-SUPPLIER-001',
              invoiceNo: 'QA-INVOICE-FAILED-' + runId,
              notes: 'This failed update must not replace the previously saved GRN recovery draft.',
              rows: [],
              savedAt: new Date().toISOString(),
            },
          },
        }));
        break;
    }
  } finally {
    injector.dispose();
  }

  if (!injector.didInject || !injectionMessage.includes('QuotaExceededError')) {
    throw new Error('The selected production IndexedDB write did not reach the scoped one-shot quota injector.');
  }
  if (writeResult.ok || writeResult.error.kind !== 'quota_exceeded') {
    throw new Error('The production IndexedDB API did not report the injected QuotaExceededError.');
  }
}

async function readRequiredLegacySnapshot(): Promise<LegacyPOSProfileSnapshot> {
  const snapshot = await idbReadLegacyProfileSnapshot();
  if (snapshot.status === 'present' || snapshot.status === 'missing_state') return snapshot.snapshot;
  if ('reason' in snapshot) throw new Error(snapshot.reason);
  throw new Error('The isolated QA IndexedDB profile was not found after fixture setup.');
}

async function migrateQaFixtureToEncryptedFolder(latestState: POSState, stateSaved: boolean, queueSaved: boolean): Promise<LegacyPOSProfileSnapshot> {
  sourceSnapshotAtCutover = null;
  const dependencies: MigrationDependencies<{ phase: string }, LegacyPOSProfileSnapshot, POSState> = {
    getProfileStatus: getDesktopPOSProfileStatus,
    // No POS screens, cloud sync, backup timers or business mutation workers run in
    // this isolated app. The lease keeps the actual latest in-memory state explicit.
    pauseStorageMaintenance: async () => ({
      latestState,
      stateSaved,
      queueSaved,
      release: () => undefined,
    }),
    readSnapshot: readRequiredLegacySnapshot,
    buildPayloads: (snapshot, state, markerSaved) => ({
      app_state: state,
      sync_queue: ensureOfflineStateWriteMarker(snapshot?.queue ?? [], markerSaved),
      meta: snapshot?.meta ?? { autoBackupHours: 6, backupCount: 0 },
      restore_checkpoint: snapshot?.restoreCheckpoint ?? null,
    }),
    getJournal: getDesktopPOSMigrationJournal,
    begin: beginDesktopPOSStorageMigration,
    transition: transitionDesktopPOSStorageMigration,
    recordCopy: recordDesktopPOSMigrationCopy,
    recordVerification: recordDesktopPOSMigrationVerification,
    writePayload: writeDesktopProfilePayload,
    readPayload: readDesktopProfilePayload,
    setFolderPrimary: async () => {
      // Prove the IndexedDB source remains intact immediately before switching
      // the shared DB adapter. This read is forbidden after folder-primary mode.
      sourceSnapshotAtCutover = await readRequiredLegacySnapshot();
      setDesktopProfilePrimary(true);
    },
    onCutoverUncertain: message => { result.textContent = message; },
  };
  await runEncryptedPOSFolderMigration(dependencies);
  if (!sourceSnapshotAtCutover) throw new Error('The IndexedDB source snapshot was not verified before adapter activation.');
  return sourceSnapshotAtCutover;
}

function createEphemeralPassphrase(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const passphrase = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  bytes.fill(0);
  return passphrase;
}

async function refreshFolderStatus(): Promise<void> {
  try {
    const folder = await getConfiguredPOSOverflowFolder();
    if (folder.ok && folder.configured && folder.available && folder.folderPath) {
      selectedFolder = folder.folderPath;
      folderPathElement.textContent = selectedFolder;
      chooseButton.disabled = true;
      if (folder.storageMode === 'indexeddb') {
        profileButton.disabled = false;
        result.textContent = 'Disposable QA folder is ready. Next, verify the encrypted profile and Windows OS unlock.';
      } else {
        profileButton.disabled = true;
        injectButton.disabled = true;
        result.textContent = 'This QA folder is already marked primary. Do not inject another quota event.';
      }
    } else if (folder.storageMode === 'folder_primary') {
      chooseButton.disabled = folder.available === true;
      profileButton.disabled = true;
      injectButton.disabled = true;
      result.textContent = folder.error || 'The QA primary folder is unavailable. Choose the same existing QA folder to reconnect it.';
    } else {
      chooseButton.disabled = false;
      profileButton.disabled = true;
      injectButton.disabled = true;
      if (folder.configured) result.textContent = folder.error || 'The saved QA folder is unavailable. Choose a new disposable QA folder.';
    }
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : 'Could not read the QA folder status.';
  }
}

chooseButton.addEventListener('click', async () => {
  chooseButton.disabled = true;
  result.textContent = 'Waiting for folder selection and safety checks…';
  folderPathElement.textContent = '';
  profileReady = false;
  profileButton.disabled = true;
  injectButton.disabled = true;
  try {
    const selection = await window.nexfixStorageQA.chooseFolder();
    if (selection.canceled) {
      result.textContent = 'Folder selection cancelled.';
      return;
    }
    await refreshFolderStatus();
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : 'Folder selection failed safety validation.';
    chooseButton.disabled = false;
  } finally {
    if (!selectedFolder) chooseButton.disabled = false;
  }
});

profileButton.addEventListener('click', async () => {
  if (!selectedFolder) return;
  profileButton.disabled = true;
  result.textContent = 'Creating or unlocking the disposable encrypted QA profile…';
  let profileDirectory = '';
  try {
    const folder = await getConfiguredPOSOverflowFolder();
    if (!folder.ok || !folder.available || !folder.folderPath || folder.storageMode !== 'indexeddb') {
      throw new Error(folder.error || 'The QA folder is not available for an IndexedDB-to-folder migration test.');
    }

    const discovery = await discoverDesktopPOSProfiles(folder.folderPath);
    if (discovery.duplicates.length > 0 || discovery.invalid.length > 0 || discovery.available.length > 1) {
      throw new Error('The QA folder has duplicate, invalid or multiple profiles. Refusing an ambiguous test.');
    }

    let profileId = '';
    if (discovery.available.length === 1) {
      const existing = discovery.available[0];
      profileDirectory = existing.directory;
      profileId = existing.profileId;
      const status = await getDesktopPOSProfileStatus();
      if (status.unlocked && status.profile?.directory !== profileDirectory) {
        await lockDesktopPOSProfile();
      }
      const current = await getDesktopPOSProfileStatus();
      if (!current.unlocked) await unlockDesktopPOSProfileWithOS(profileDirectory);
    } else {
      const passphrase = createEphemeralPassphrase();
      const created = await createDesktopPOSProfile({
        storageRoot: folder.folderPath,
        directoryName: 'Nexfix-Storage-QA-Profile',
        label: 'Disposable Storage QA Profile',
        passphrase,
      });
      profileDirectory = created.profile.directory;
      profileId = created.profile.profileId;
      // The recovery key is deliberately discarded; it is never displayed or saved.
      void created.recoveryKey;
    }

    const sample = JSON.stringify({
      kind: 'nexfix-storage-qa-encrypted-profile-roundtrip',
      runId: crypto.randomUUID(),
      fixture: { invoiceId: 'QA-ONLY-001', total: 1250, currency: 'LKR' },
    });
    await writeDesktopProfilePayload('app_state', sample);
    const firstRead = await readDesktopProfilePayload('app_state');
    if (firstRead !== sample) throw new Error('Encrypted profile write/read-back verification failed.');

    await lockDesktopPOSProfile();
    await unlockDesktopPOSProfileWithOS(profileDirectory);
    const osUnlockedRead = await readDesktopProfilePayload('app_state');
    if (osUnlockedRead !== sample) throw new Error('Windows OS unlock did not restore the encrypted QA profile payload.');
    // Keep the disposable QA profile unlocked so the quota event can exercise
    // the same OS-unlocked automatic migration path used by the desktop app.
    profileReady = true;
    quotaDomainSelect.disabled = false;
    injectButton.disabled = false;
    result.textContent = 'PASS: encrypted profile round-trip and Windows OS unlock verified for QA profile ' + profileId + '. Recovery key was not displayed or saved.';
  } catch (error) {
    try { await lockDesktopPOSProfile(); } catch { /* keep the QA profile locked after a failed test */ }
    result.textContent = 'Encrypted profile QA failed: ' + (error instanceof Error ? error.message : 'unknown error');
  } finally {
    profileButton.disabled = profileReady;
  }
});

injectButton.addEventListener('click', async () => {
  if (!selectedFolder || !profileReady || injectionUsed) return;
  injectionUsed = true;
  injectButton.disabled = true;
  quotaDomainSelect.disabled = true;
  const runId = crypto.randomUUID();
  const domain = quotaDomainSelect.value as QaQuotaDomain;
  result.textContent = 'Preparing the isolated production IndexedDB fixture…';

  try {
    const fixture = await seedIndexedDbFixture(runId);
    activeMigrationFixture = {
      latestState: fixture.latestState,
      stateSaved: domain !== 'app_state',
      queueSaved: domain !== 'app_state' && domain !== 'sync_queue',
    };

    // The POS state held in memory is newer than the last durable state. For
    // non-state failure modes, persist that state before injecting the failure.
    const stateSaved = domain !== 'app_state';
    if (stateSaved) {
      const latestSave = await idbSaveStateDetailed(fixture.latestState);
      if (!latestSave.ok) throw new Error('Could not persist the latest QA in-memory state before the selected failure.');
    }

    await failOneProductionIndexedDbWrite(domain, runId, fixture.latestState);
    if (!quotaEventReceived || !migrationPromise) {
      throw new Error('The production IndexedDB quota-warning event did not start automatic migration.');
    }

    result.textContent = 'Production quota event received. Waiting for the encrypted four-domain migration…';
    await migrationPromise;

    const migratedState = JSON.parse((await readDesktopProfilePayload('app_state')) || 'null');
    if (!migratedState || !Array.isArray(migratedState.products) ||
        !Array.isArray(migratedState.users) || !Array.isArray(migratedState.sales) ||
        JSON.stringify(migratedState) !== JSON.stringify(fixture.latestState)) {
      throw new Error('The encrypted app-state payload did not preserve the latest in-memory POS state.');
    }

    const migratedQueue = JSON.parse((await readDesktopProfilePayload('sync_queue')) || 'null');
    if (!Array.isArray(migratedQueue) || migratedQueue.some((entry: { id?: unknown; ts?: unknown; type?: unknown }) =>
        !entry || typeof entry.id !== 'string' || typeof entry.ts !== 'string' || typeof entry.type !== 'string')) {
      throw new Error('The encrypted offline queue does not match the production QueueOp schema.');
    }
    if (!migratedQueue.some((entry: { id?: string }) => entry.id === 'QA-QUEUE-' + runId)) {
      throw new Error('The previously committed offline queue entry was not migrated.');
    }
    if (domain === 'sync_queue' && !migratedQueue.some((entry: { type?: string }) => entry.type === 'state_write')) {
      throw new Error('The failed queue write did not produce the state-write recovery marker.');
    }

    const migratedMeta = JSON.parse((await readDesktopProfilePayload('meta')) || 'null');
    if (!migratedMeta || !Number.isFinite(migratedMeta.autoBackupHours) ||
        !Number.isFinite(migratedMeta.backupCount) ||
        JSON.stringify(migratedMeta.grnWorkingDrafts?.[fixture.draftKey]) !== JSON.stringify(fixture.draft)) {
      throw new Error('Encrypted metadata did not preserve the unfinished GRN recovery draft.');
    }

    const migratedCheckpoint = JSON.parse((await readDesktopProfilePayload('restore_checkpoint')) || 'null');
    if (!migratedCheckpoint || !Array.isArray(migratedCheckpoint.products) ||
        !Array.isArray(migratedCheckpoint.users) || !Array.isArray(migratedCheckpoint.sales) ||
        JSON.stringify(migratedCheckpoint) !== JSON.stringify(fixture.baselineState)) {
      throw new Error('The encrypted restore checkpoint did not preserve the original checkpoint.');
    }

    const completedJournal = await getDesktopPOSMigrationJournal();
    if (!completedJournal || completedJournal.phase !== 'folder_primary' ||
        Object.values(completedJournal.entries).some(entry => entry.status !== 'verified')) {
      throw new Error('The encrypted QA migration journal is not fully verified and folder-primary.');
    }

    // Verify the production DB adapter now reads the encrypted folder, not IDB.
    const activeState = await idbLoadState();
    const activeQueue = await idbListQueue();
    const activeMeta = await idbGetMeta();
    const activeCheckpoint = await idbLoadRestoreCheckpoint();
    const activeDraft = await idbGetMetaValue<typeof fixture.draft>(fixture.draftKey);
    if (JSON.stringify(activeState) !== JSON.stringify(fixture.latestState) ||
        !activeQueue.some(entry => entry.id === 'QA-QUEUE-' + runId) ||
        !Number.isFinite(activeMeta.autoBackupHours) ||
        JSON.stringify(activeCheckpoint) !== JSON.stringify(fixture.baselineState) ||
        JSON.stringify(activeDraft) !== JSON.stringify(fixture.draft)) {
      throw new Error('The active encrypted-folder DB adapter did not preserve POS/GRN data across cutover.');
    }
    const postCutoverDraft = { ...fixture.draft, notes: fixture.draft.notes + ' Verified after cutover.' };
    if (!await idbPutMetaValue(fixture.draftKey, postCutoverDraft) ||
        JSON.stringify(await idbGetMetaValue(fixture.draftKey)) !== JSON.stringify(postCutoverDraft)) {
      throw new Error('The active encrypted-folder adapter could not save and reread the GRN recovery draft.');
    }

    const preservedSource = sourceSnapshotAtCutover;
    if (!preservedSource) throw new Error('The IndexedDB source was not captured before folder cutover.');
    const expectedSourceState = domain === 'app_state' ? fixture.baselineState : fixture.latestState;
    if (JSON.stringify(preservedSource.state) !== JSON.stringify(expectedSourceState) ||
        !preservedSource.queue.some(entry => entry.id === 'QA-QUEUE-' + runId) ||
        JSON.stringify(preservedSource.meta.grnWorkingDrafts?.[fixture.draftKey]) !== JSON.stringify(fixture.draft) ||
        JSON.stringify(preservedSource.restoreCheckpoint) !== JSON.stringify(fixture.baselineState)) {
      throw new Error('The original IndexedDB source domains were changed or cleared during migration.');
    }

    await refreshFolderStatus();
    result.textContent = 'PASS: ' + domain + ' generated a real QuotaExceededError in the production IndexedDB API. Automatic migration copied and verified all four encrypted domains, preserved latest in-memory state and retained the unfinished GRN recovery record and original IndexedDB source.';
  } catch (error) {
    result.textContent = 'QA test failed safely: ' + (error instanceof Error ? error.message : 'unknown error');
  }
});

void refreshFolderStatus();
