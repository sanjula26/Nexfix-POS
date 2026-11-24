import {
  dispatchStorageQuotaWarning,
  subscribeToStorageQuotaWarnings,
} from '../../../src/lib/storageOverflowEvents.ts';

const chooseButton = document.getElementById('choose-folder') as HTMLButtonElement;
const injectButton = document.getElementById('inject-quota') as HTMLButtonElement;
const result = document.getElementById('result') as HTMLParagraphElement;
const folderPathElement = document.getElementById('folder-path') as HTMLElement;

const QA_DATABASE = 'nexfix_storage_qa_fixture_v1';
let selectedFolder: string | null = null;
let injectionUsed = false;
let quotaEventReceived = false;

subscribeToStorageQuotaWarnings(window, detail => {
  if (detail.reason !== 'quota_exceeded') return;
  quotaEventReceived = true;
  result.textContent = 'PASS: the shared production quota-warning event was received. No migration has been started.';
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

    // The synthetic DOMException is confined to this QA-only IndexedDB transaction.
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

    // Abort after queuing the disposable write. This exercises the transaction
    // abort boundary without filling a drive or touching production IndexedDB.
    transaction.abort();
  });
}

chooseButton.addEventListener('click', async () => {
  chooseButton.disabled = true;
  result.textContent = 'Waiting for folder selection and safety checks…';
  folderPathElement.textContent = '';
  try {
    const selection = await window.nexfixStorageQA.chooseFolder();
    if (selection.cancelled) {
      result.textContent = 'Folder selection cancelled.';
      return;
    }
    selectedFolder = selection.folderPath;
    folderPathElement.textContent = selectedFolder;
    injectButton.disabled = false;
    result.textContent = 'Disposable QA folder prepared. The production POS folder and data remain untouched.';
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : 'Folder selection failed safety validation.';
  } finally {
    chooseButton.disabled = false;
  }
});

injectButton.addEventListener('click', async () => {
  if (!selectedFolder || injectionUsed) return;
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
    result.textContent = 'PASS — QA run ' + runId + ': transaction abort and shared quota event verified. No folder migration or disk filling was performed.';
  } catch (error) {
    result.textContent = 'QA test failed: ' + (error instanceof Error ? error.message : 'unknown error');
  } finally {
    database?.close();
  }
});
