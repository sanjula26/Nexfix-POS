import {
  createDesktopPOSProfile,
  discoverDesktopPOSProfiles,
  getConfiguredPOSOverflowFolder,
  getDesktopPOSProfileStatus,
  lockDesktopPOSProfile,
  readDesktopProfilePayload,
  unlockDesktopPOSProfileWithOS,
  writeDesktopProfilePayload,
} from '../../src/lib/desktopProfileStorage.ts';
import {
  dispatchStorageQuotaWarning,
  subscribeToStorageQuotaWarnings,
} from '../../src/lib/storageOverflowEvents.ts';

const chooseButton = document.getElementById('choose-folder') as HTMLButtonElement;
const profileButton = document.getElementById('create-profile') as HTMLButtonElement;
const injectButton = document.getElementById('inject-quota') as HTMLButtonElement;
const result = document.getElementById('result') as HTMLParagraphElement;
const folderPathElement = document.getElementById('folder-path') as HTMLElement;

const QA_DATABASE = 'nexfix_storage_qa_fixture_v1';
let selectedFolder: string | null = null;
let profileReady = false;
let injectionUsed = false;
let quotaEventReceived = false;

subscribeToStorageQuotaWarnings(window, detail => {
  if (detail.reason !== 'quota_exceeded') return;
  quotaEventReceived = true;
  result.textContent = 'PASS: the shared production quota-warning event was received. The encrypted migration coordinator is not wired yet.';
});

function openQaDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(QA_DATABASE, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('records')) {
        database.createObjectStore('records', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open the disposable QA IndexedDB database.'));
  });
}

function writeBaseline(database: IDBDatabase, runId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('records', 'readwrite');
    transaction.objectStore('records').put({ id: 'baseline:' + runId, value: 'QA-only baseline record' });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('QA baseline write failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('QA baseline transaction was aborted.'));
  });
}

function injectOneShotQuotaFailure(database: IDBDatabase, runId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('records', 'readwrite');
    transaction.objectStore('records').put({ id: 'aborted:' + runId, value: 'This write must not commit.' });
    const injectedError = new DOMException('Controlled QA quota injection; no disk space is consumed.', 'QuotaExceededError');
    transaction.addEventListener('abort', () => {
      if (injectedError.name === 'QuotaExceededError') {
        dispatchStorageQuotaWarning(window, { reason: 'quota_exceeded' });
      }
      resolve();
    }, { once: true });
    transaction.addEventListener('complete', () => {
      reject(new Error('The injected QA transaction unexpectedly committed.'));
    }, { once: true });
    transaction.abort();
  });
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
      chooseButton.disabled = true;
      result.textContent = folder.error || 'The QA primary folder is unavailable. Reconnect it before continuing.';
    }
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : 'Could not read the QA folder status.';
  }
}

chooseButton.addEventListener('click', async () => {
  chooseButton.disabled = true;
  result.textContent = 'Waiting for folder selection and safety checks…';
  folderPathElement.textContent = '';
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
    await lockDesktopPOSProfile();

    profileReady = true;
    injectButton.disabled = false;
    result.textContent = 'PASS: encrypted profile round-trip and Windows OS unlock verified for QA profile ' + profileId + '. Recovery key was not displayed or saved.';
  } catch (error) {
    try { await lockDesktopPOSProfile(); } catch { /* keep the QA profile locked after a failed test */ }
    result.textContent = 'Encrypted profile QA failed: ' + (error instanceof Error ? error.message : 'unknown error');
  } finally {
    profileButton.disabled = false;
  }
});

injectButton.addEventListener('click', async () => {
  if (!selectedFolder || !profileReady || injectionUsed) return;
  injectionUsed = true;
  injectButton.disabled = true;
  const runId = crypto.randomUUID();
  result.textContent = 'Running one-shot synthetic quota test in the isolated QA database…';

  let database: IDBDatabase | null = null;
  try {
    database = await openQaDatabase();
    await writeBaseline(database, runId);
    await injectOneShotQuotaFailure(database, runId);
    if (!quotaEventReceived) throw new Error('The shared quota-warning event was not received.');
    result.textContent = 'PASS — QA run ' + runId + ': transaction abort and shared quota event verified. Encrypted profile round-trip passed; migration is not yet wired.';
  } catch (error) {
    result.textContent = 'QA test failed: ' + (error instanceof Error ? error.message : 'unknown error');
  } finally {
    database?.close();
  }
});

void refreshFolderStatus();
