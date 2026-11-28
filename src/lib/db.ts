// Durable IndexedDB state and sync queue for Nexfix POS.
import type { POSState } from './types';

const DB_NAME = 'nexfix_pos_db';
const DB_VERSION = 1;
const STORE_STATE = 'app_state';
const STORE_QUEUE = 'sync_queue';
const STORE_META = 'meta';

export type QueueOp =
  | { id: string; ts: string; type: 'state_write'; note?: string }
  | { id: string; ts: string; type: 'backup'; note?: string }
  | { id: string; ts: string; type: 'custom'; note: string; payload?: string }
  | { id: string; ts: string; type: 'sale_create'; payload: string }
  | { id: string; ts: string; type: 'return_create'; payload: string }
  | { id: string; ts: string; type: 'sale_reversal_request'; payload: string }
  | { id: string; ts: string; type: 'sale_reversal_approve'; payload: string }
  | { id: string; ts: string; type: 'sale_reversal_reject'; payload: string }
  | { id: string; ts: string; type: 'purchase_receive'; payload: string }
  | { id: string; ts: string; type: 'repair_delivery'; payload: string }
  | { id: string; ts: string; type: 'branch_stock_adjustment'; payload: string }
  | { id: string; ts: string; type: 'inventory_units_add'; payload: string }
  | { id: string; ts: string; type: 'inventory_unit_delete'; payload: string };
export interface CloudSyncMeta {
  lastSuccessAt: string;
  lastSuccessOperation: string;
}

export interface BackupMeta {
  lastAutoBackupAt?: string;
  lastManualBackupAt?: string;
  lastCloudBackupAt?: string;
  lastCloudBackupError?: string;
  pendingAutoBackupAt?: string;
  nextAutoBackupRetryAt?: string;
  autoBackupFailureCount?: number;
  autoBackupHours: number;
  backupCount: number;
}

function openDB(): Promise<IDBDatabase> { return new Promise((resolve,reject)=>{ const req=indexedDB.open(DB_NAME,DB_VERSION); req.onerror=()=>reject(req.error||new Error('IDB open failed')); req.onsuccess=()=>resolve(req.result); req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(STORE_STATE))db.createObjectStore(STORE_STATE,{keyPath:'key'});if(!db.objectStoreNames.contains(STORE_QUEUE)){const q=db.createObjectStore(STORE_QUEUE,{keyPath:'id'});q.createIndex('ts','ts',{unique:false});}if(!db.objectStoreNames.contains(STORE_META))db.createObjectStore(STORE_META,{keyPath:'key'});};}); }
function idbReq<T>(req: IDBRequest<T>): Promise<T> { return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);}); }

function idbTransactionComplete(tx: IDBTransaction, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error(message));
    tx.onabort = () => reject(tx.error || new Error(message + ' (transaction aborted)'));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
function getDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDB().then(db => {
      db.onversionchange = () => { db.close(); dbPromise = null; };
      return db;
    }).catch(error => { dbPromise = null; throw error; });
  }
  return dbPromise;
}

export async function idbLoadState():Promise<POSState|null>{
  try {
    const db=await getDB();
    const row=await idbReq<{key:string;value:POSState}|undefined>(db.transaction(STORE_STATE,'readonly').objectStore(STORE_STATE).get('main'));
    if (row?.value) return row.value;

    // Load the seed lazily so the IndexedDB persistence layer can be tested
    // independently in Node without eagerly importing browser-only seed code.
    const { buildSeed } = await import('./seed');
    const seed = buildSeed();
    const saved = await idbSaveState(seed);
    return saved ? seed : null;
  } catch {
    // Let callers choose an explicit localStorage fallback. Returning a seed
    // here could make a storage failure look like an empty, safe shop dataset.
    return null;
  }
}
export async function idbSaveState(state:POSState):Promise<boolean>{try{const db=await getDB();const tx=db.transaction(STORE_STATE,'readwrite');tx.objectStore(STORE_STATE).put({key:'main',value:state,updatedAt:new Date().toISOString()});await idbTransactionComplete(tx,'State save failed');return true;}catch{return false;}}
export async function idbSaveRestoreCheckpoint(state:POSState):Promise<boolean>{try{const db=await getDB();const tx=db.transaction(STORE_STATE,'readwrite');tx.objectStore(STORE_STATE).put({key:'restore_checkpoint',value:state,updatedAt:new Date().toISOString()});await idbTransactionComplete(tx,'Restore checkpoint failed');return true;}catch{return false;}}
export async function idbLoadRestoreCheckpoint():Promise<POSState|null>{try{const db=await getDB();const row=await idbReq<{key:string;value:POSState}|undefined>(db.transaction(STORE_STATE,'readonly').objectStore(STORE_STATE).get('restore_checkpoint'));return row?.value??null;}catch{return null;}}
export async function idbClearRestoreCheckpoint():Promise<boolean>{try{const db=await getDB();const tx=db.transaction(STORE_STATE,'readwrite');tx.objectStore(STORE_STATE).delete('restore_checkpoint');await idbTransactionComplete(tx,'Restore checkpoint cleanup failed');return true;}catch{return false;}}

type QueueInput={type:QueueOp['type'];id?:string;ts?:string;note?:string;payload?:string};
export async function idbEnqueue(op:QueueInput):Promise<boolean>{try{const db=await getDB();const entry={id:op.id||(crypto.randomUUID?.()||String(Date.now())),ts:op.ts||new Date().toISOString(),...op} as QueueOp;const tx=db.transaction(STORE_QUEUE,'readwrite');tx.objectStore(STORE_QUEUE).put(entry);await idbTransactionComplete(tx,'Offline queue write failed');return true;}catch{return false;}}
export async function idbListQueue():Promise<QueueOp[]>{if(!idbAvailable())return[];const db=await getDB();const all=await idbReq<QueueOp[]>(db.transaction(STORE_QUEUE,'readonly').objectStore(STORE_QUEUE).getAll());return(all||[]).sort((a,b)=>a.ts.localeCompare(b.ts));}
export async function idbAcknowledgeQueue(ids:string[]):Promise<void>{if(!ids.length)return;try{const db=await getDB();const tx=db.transaction(STORE_QUEUE,'readwrite');const store=tx.objectStore(STORE_QUEUE);for(const id of ids)store.delete(id);await idbTransactionComplete(tx,'Queue acknowledgement failed');}catch{/* best-effort cleanup */}}
export async function idbDeleteQueue(id:string):Promise<void>{if(!id)return;try{const db=await getDB();const tx=db.transaction(STORE_QUEUE,'readwrite');tx.objectStore(STORE_QUEUE).delete(id);await idbTransactionComplete(tx,'Offline queue delete failed');}catch{/* best-effort cleanup */}}
export async function idbClearQueue():Promise<void>{const ops=await idbListQueue();await idbAcknowledgeQueue(ops.map(op=>op.id));}
const DEFAULT_META:BackupMeta={autoBackupHours:6,backupCount:0};
export async function idbGetMeta():Promise<BackupMeta>{try{const db=await getDB();const row=await idbReq<{key:string;value:BackupMeta}|undefined>(db.transaction(STORE_META,'readonly').objectStore(STORE_META).get('backup'));return{...DEFAULT_META,...(row?.value||{})};}catch{return{...DEFAULT_META};}}
export async function idbSetMeta(patch:Partial<BackupMeta>):Promise<BackupMeta>{const current=await idbGetMeta();const next={...current,...patch};try{const db=await getDB();const tx=db.transaction(STORE_META,'readwrite');tx.objectStore(STORE_META).put({key:'backup',value:next});await idbTransactionComplete(tx,'Backup metadata write failed');}catch{/* metadata is best-effort */}return next;}

function cloudSyncMetaKey(shopId: string, userId: string): string | null {
  const shop = shopId.trim();
  const user = userId.trim();
  if (!shop || !user || shop.length > 100 || user.length > 100) return null;
  return `cloud_sync:${encodeURIComponent(shop)}:${encodeURIComponent(user)}`;
}

export async function idbGetCloudSyncMeta(shopId: string, userId: string): Promise<CloudSyncMeta | null> {
  const key = cloudSyncMetaKey(shopId, userId);
  if (!key) return null;
  try {
    const db = await getDB();
    const row = await idbReq<{ key: string; value?: unknown } | undefined>(db.transaction(STORE_META, 'readonly').objectStore(STORE_META).get(key));
    if (!row?.value || typeof row.value !== 'object') return null;
    const value = row.value as Partial<CloudSyncMeta>;
    if (typeof value.lastSuccessAt !== 'string' || !Number.isFinite(Date.parse(value.lastSuccessAt))) return null;
    if (typeof value.lastSuccessOperation !== 'string' || !value.lastSuccessOperation.trim() || value.lastSuccessOperation.length > 80) return null;
    return { lastSuccessAt: value.lastSuccessAt, lastSuccessOperation: value.lastSuccessOperation };
  } catch {
    return null;
  }
}

export async function idbSetCloudSyncMeta(shopId: string, userId: string, meta: CloudSyncMeta): Promise<boolean> {
  const key = cloudSyncMetaKey(shopId, userId);
  if (!key || !meta || typeof meta.lastSuccessAt !== 'string' || !Number.isFinite(Date.parse(meta.lastSuccessAt)) ||
      typeof meta.lastSuccessOperation !== 'string' || !meta.lastSuccessOperation.trim() || meta.lastSuccessOperation.length > 80) return false;
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put({ key, value: meta, updatedAt: new Date().toISOString() });
    await idbTransactionComplete(tx, 'Cloud sync metadata write failed');
    return true;
  } catch {
    return false;
  }
}

export type CloudRecordType = 'sale' | 'purchase';
export interface CloudRecordSyncEntry {
  confirmedAt?: string;
  attemptedAt?: string;
  operation: string;
  /** A failed last attempt is not proof that the server lacks the record; its queue row remains retryable. */
  status?: 'retry';
  error?: string;
}

const MAX_CLOUD_RECORD_SYNC_ENTRIES = 5000;

function cloudRecordSyncMetaKey(shopId: string, userId: string): string | null {
  const shop = shopId.trim();
  const user = userId.trim();
  if (!shop || !user || shop.length > 100 || user.length > 100) return null;
  return `cloud_record_sync:${encodeURIComponent(shop)}:${encodeURIComponent(user)}`;
}

function cloudRecordKey(type: CloudRecordType, recordId: string): string | null {
  const id = recordId.trim();
  if ((type !== 'sale' && type !== 'purchase') || !id || id.length > 200) return null;
  return `${type}:${encodeURIComponent(id)}`;
}

function validCloudRecordEntry(value: unknown): value is CloudRecordSyncEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<CloudRecordSyncEntry>;
  if (typeof entry.operation !== 'string' || !entry.operation.trim() || entry.operation.length > 80) return false;
  if (entry.status === 'retry') {
    return typeof entry.attemptedAt === 'string' && Number.isFinite(Date.parse(entry.attemptedAt)) &&
      typeof entry.error === 'string' && !!entry.error.trim() && entry.error.length <= 240;
  }
  // Entries written before retry-state support have no status field; keep reading them as confirmed receipts.
  return entry.status === undefined && typeof entry.confirmedAt === 'string' && Number.isFinite(Date.parse(entry.confirmedAt));
}

function mergeCloudRecordEntry(
  previous: unknown,
  key: string,
  entry: CloudRecordSyncEntry,
): Record<string, CloudRecordSyncEntry> {
  const records: Record<string, CloudRecordSyncEntry> = {};
  if (previous && typeof previous === 'object' && 'records' in previous && (previous as { records?: unknown }).records &&
      typeof (previous as { records?: unknown }).records === 'object') {
    for (const [existingKey, value] of Object.entries((previous as { records: Record<string, unknown> }).records)) {
      if (validCloudRecordEntry(value)) records[existingKey] = value;
    }
  }
  records[key] = entry;
  const keys = Object.keys(records);
  if (keys.length > MAX_CLOUD_RECORD_SYNC_ENTRIES) {
    const timestamp = (entry: CloudRecordSyncEntry) => Date.parse(entry.status === 'retry' ? entry.attemptedAt || '' : entry.confirmedAt || '');
    keys.sort((a, b) => timestamp(records[a]) - timestamp(records[b]));
    for (const oldKey of keys.slice(0, keys.length - MAX_CLOUD_RECORD_SYNC_ENTRIES)) delete records[oldKey];
  }
  return records;
}

export async function idbGetCloudRecordSyncStatuses(
  shopId: string,
  userId: string,
): Promise<Record<string, CloudRecordSyncEntry>> {
  const key = cloudRecordSyncMetaKey(shopId, userId);
  if (!key) return {};
  try {
    const db = await getDB();
    const row = await idbReq<{ key: string; value?: unknown } | undefined>(
      db.transaction(STORE_META, 'readonly').objectStore(STORE_META).get(key),
    );
    if (!row?.value || typeof row.value !== 'object' || !('records' in row.value)) return {};
    const raw = (row.value as { records?: unknown }).records;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const safe: Record<string, CloudRecordSyncEntry> = {};
    for (const [recordKey, value] of Object.entries(raw)) {
      if (validCloudRecordEntry(value)) safe[recordKey] = value;
    }
    return safe;
  } catch {
    return {};
  }
}

export async function idbMarkCloudRecordSynced(
  shopId: string,
  userId: string,
  type: CloudRecordType,
  recordId: string,
  operation: string,
  confirmedAt = new Date().toISOString(),
): Promise<boolean> {
  const metaKey = cloudRecordSyncMetaKey(shopId, userId);
  const recordKey = cloudRecordKey(type, recordId);
  if (!metaKey || !recordKey || typeof operation !== 'string' || !operation.trim() || operation.length > 80 ||
      !Number.isFinite(Date.parse(confirmedAt))) return false;
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_META, 'readwrite');
    const completed = idbTransactionComplete(tx, 'Cloud record confirmation write failed');
    const store = tx.objectStore(STORE_META);
    const row = await idbReq<{ key: string; value?: unknown } | undefined>(store.get(metaKey));
    const records = mergeCloudRecordEntry(row?.value, recordKey, { confirmedAt, operation });
    store.put({ key: metaKey, value: { records }, updatedAt: new Date().toISOString() });
    await completed;
    return true;
  } catch {
    return false;
  }
}

/** Persist a retryable last-attempt failure without removing or changing the durable queue row. */
export async function idbMarkCloudRecordSyncRetry(
  shopId: string,
  userId: string,
  type: CloudRecordType,
  recordId: string,
  operation: string,
  error: string,
  attemptedAt = new Date().toISOString(),
): Promise<boolean> {
  const metaKey = cloudRecordSyncMetaKey(shopId, userId);
  const recordKey = cloudRecordKey(type, recordId);
  const safeError = typeof error === 'string' ? error.trim().replace(/\s+/g, ' ').slice(0, 240) : '';
  if (!metaKey || !recordKey || typeof operation !== 'string' || !operation.trim() || operation.length > 80 ||
      !safeError || !Number.isFinite(Date.parse(attemptedAt))) return false;
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_META, 'readwrite');
    const completed = idbTransactionComplete(tx, 'Cloud record retry status write failed');
    const store = tx.objectStore(STORE_META);
    const row = await idbReq<{ key: string; value?: unknown } | undefined>(store.get(metaKey));
    const records = mergeCloudRecordEntry(row?.value, recordKey, {
      status: 'retry', attemptedAt, operation, error: safeError,
    });
    store.put({ key: metaKey, value: { records }, updatedAt: new Date().toISOString() });
    await completed;
    return true;
  } catch {
    return false;
  }
}

/** Atomically retain the positive Cloud acknowledgement and remove its matching queue item. */
export async function idbAcknowledgeCloudRecordQueue(
  shopId: string,
  userId: string,
  type: CloudRecordType,
  recordId: string,
  queueId: string,
  operation: string,
  confirmedAt = new Date().toISOString(),
): Promise<boolean> {
  const metaKey = cloudRecordSyncMetaKey(shopId, userId);
  const recordKey = cloudRecordKey(type, recordId);
  const expectedQueueId = type === 'sale' ? `sale:${recordId}` : `purchase-receive:${recordId}`;
  if (!metaKey || !recordKey || !queueId || queueId !== expectedQueueId ||
      typeof operation !== 'string' || !operation.trim() || operation.length > 80 ||
      !Number.isFinite(Date.parse(confirmedAt))) return false;
  try {
    const db = await getDB();
    const tx = db.transaction([STORE_QUEUE, STORE_META], 'readwrite');
    const completed = idbTransactionComplete(tx, 'Cloud queue acknowledgement failed');
    const queueStore = tx.objectStore(STORE_QUEUE);
    const metaStore = tx.objectStore(STORE_META);
    const [queued, meta] = await Promise.all([
      idbReq<QueueOp | undefined>(queueStore.get(queueId)),
      idbReq<{ key: string; value?: unknown } | undefined>(metaStore.get(metaKey)),
    ]);
    if (!queued || queued.id !== queueId || (type === 'sale' && queued.type !== 'sale_create') ||
        (type === 'purchase' && queued.type !== 'purchase_receive')) {
      try { tx.abort(); } catch { /* transaction may already be inactive */ }
      await completed.catch(() => {});
      return false;
    }
    const records = mergeCloudRecordEntry(meta?.value, recordKey, { confirmedAt, operation });
    metaStore.put({ key: metaKey, value: { records }, updatedAt: new Date().toISOString() });
    queueStore.delete(queueId);
    await completed;
    return true;
  } catch {
    return false;
  }
}

export function idbAvailable():boolean{return typeof indexedDB!=='undefined';}