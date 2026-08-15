/**
 * Native IndexedDB layer for Nexfix POS.
 * Replaces localStorage as primary store (handles far more than 5 MB).
 * Also stores offline write-queue + backup metadata.
 */

import type { POSState } from './types';

const DB_NAME = 'nexfix_pos_db';
const DB_VERSION = 1;
const STORE_STATE = 'app_state';
const STORE_QUEUE = 'sync_queue';
const STORE_META = 'meta';

export type QueueOp =
  | { id: string; ts: string; type: 'state_write'; note?: string }
  | { id: string; ts: string; type: 'backup'; note?: string }
  | { id: string; ts: string; type: 'custom'; note: string; payload?: string };

export interface BackupMeta {
  lastAutoBackupAt?: string;
  lastManualBackupAt?: string;
  autoBackupHours: number; // 0 = disabled
  backupCount: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error('IDB open failed'));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_STATE)) {
        db.createObjectStore(STORE_STATE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        const q = db.createObjectStore(STORE_QUEUE, { keyPath: 'id' });
        q.createIndex('ts', 'ts', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
  });
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Load full POS state from IndexedDB (or null if empty) */
export async function idbLoadState(): Promise<POSState | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_STATE, 'readonly');
    const row = await idbReq<{ key: string; value: POSState } | undefined>(
      tx.objectStore(STORE_STATE).get('main'),
    );
    db.close();
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/** Persist full POS state to IndexedDB */
export async function idbSaveState(state: POSState): Promise<boolean> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_STATE, 'readwrite');
    await idbReq(tx.objectStore(STORE_STATE).put({ key: 'main', value: state, updatedAt: new Date().toISOString() }));
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** Enqueue an offline / pending operation */
export async function idbEnqueue(op: Omit<QueueOp, 'id' | 'ts'> & { id?: string; ts?: string }): Promise<void> {
  try {
    const db = await openDB();
    const entry: QueueOp = {
      id: op.id || (crypto.randomUUID?.() || String(Date.now())),
      ts: op.ts || new Date().toISOString(),
      ...op,
    } as QueueOp;
    const tx = db.transaction(STORE_QUEUE, 'readwrite');
    await idbReq(tx.objectStore(STORE_QUEUE).put(entry));
    db.close();
  } catch { /* ignore */ }
}

/** Read all queued ops (oldest first) */
export async function idbListQueue(): Promise<QueueOp[]> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_QUEUE, 'readonly');
    const all = await idbReq<QueueOp[]>(tx.objectStore(STORE_QUEUE).getAll());
    db.close();
    return (all || []).sort((a, b) => a.ts.localeCompare(b.ts));
  } catch {
    return [];
  }
}

/** Clear the sync queue (after successful flush) */
export async function idbClearQueue(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_QUEUE, 'readwrite');
    await idbReq(tx.objectStore(STORE_QUEUE).clear());
    db.close();
  } catch { /* ignore */ }
}

const DEFAULT_META: BackupMeta = {
  autoBackupHours: 6,
  backupCount: 0,
};

export async function idbGetMeta(): Promise<BackupMeta> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_META, 'readonly');
    const row = await idbReq<{ key: string; value: BackupMeta } | undefined>(
      tx.objectStore(STORE_META).get('backup'),
    );
    db.close();
    return { ...DEFAULT_META, ...(row?.value || {}) };
  } catch {
    return { ...DEFAULT_META };
  }
}

export async function idbSetMeta(patch: Partial<BackupMeta>): Promise<BackupMeta> {
  const current = await idbGetMeta();
  const next = { ...current, ...patch };
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_META, 'readwrite');
    await idbReq(tx.objectStore(STORE_META).put({ key: 'backup', value: next }));
    db.close();
  } catch { /* ignore */ }
  return next;
}

/** Check IndexedDB availability */
export function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}
