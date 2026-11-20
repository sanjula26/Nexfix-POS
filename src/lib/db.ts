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


export type ExistingPOSStateInspection =
  | { status: 'missing_database' }
  | { status: 'missing_state' }
  | { status: 'present'; state: POSState; updatedAt?: string }
  | { status: 'invalid_database' | 'invalid_state'; reason: string }
  | { status: 'unavailable'; reason: string };

/**
 * Inspect an existing POS database without creating it, seeding it, or changing
 * its schema. Profile recovery must use this before the normal boot path, because
 * an absent state row can mean an incomplete/old profile rather than a new shop.
 */
export async function idbInspectExistingState(factory: IDBFactory = indexedDB): Promise<ExistingPOSStateInspection> {
  if (!factory || typeof factory.databases !== 'function') {
    return { status: 'unavailable', reason: 'This runtime cannot safely enumerate existing IndexedDB databases.' };
  }

  let db: IDBDatabase | null = null;
  try {
    const existingDatabases = await factory.databases();
    if (!existingDatabases.some(info => info.name === DB_NAME)) {
      return { status: 'missing_database' };
    }

    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DB_NAME);
      let unexpectedUpgrade = false;
      request.onupgradeneeded = () => {
        // The database disappeared between enumeration and open. Abort rather
        // than creating a new, apparently valid empty POS database.
        unexpectedUpgrade = true;
        try { request.transaction?.abort(); } catch { /* request error handles this */ }
      };
      request.onsuccess = () => {
        if (unexpectedUpgrade) {
          request.result.close();
          reject(new Error('The IndexedDB database changed during profile inspection.'));
          return;
        }
        resolve(request.result);
      };
      request.onerror = () => reject(request.error || new Error('Existing POS database could not be opened.'));
      request.onblocked = () => reject(new Error('Existing POS database is blocked by another open connection.'));
    });

    if (!db.objectStoreNames.contains(STORE_STATE)) {
      return { status: 'invalid_database', reason: 'The existing database does not contain the POS state store.' };
    }

    const tx = db.transaction(STORE_STATE, 'readonly');
    const rowRequest = idbReq<{ key: string; value: POSState; updatedAt?: string } | undefined>(
      tx.objectStore(STORE_STATE).get('main'),
    );
    const txComplete = idbTransactionComplete(tx, 'Existing POS state inspection failed');
    const row = await rowRequest;
    await txComplete;

    if (!row) return { status: 'missing_state' };
    const state = row.value;
    if (!state || typeof state !== 'object' || !Array.isArray(state.products) ||
        !Array.isArray(state.users) || !Array.isArray(state.sales)) {
      return { status: 'invalid_state', reason: 'The saved POS state is incomplete or has an unsupported shape.' };
    }
    return {
      status: 'present',
      state,
      ...(typeof row.updatedAt === 'string' ? { updatedAt: row.updatedAt } : {}),
    };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : 'Existing POS database inspection failed.',
    };
  } finally {
    try { db?.close(); } catch { /* best-effort close */ }
  }
}

export interface LegacyPOSProfileSnapshot {
  state: POSState | null;
  stateUpdatedAt?: string;
  restoreCheckpoint: POSState | null;
  queue: QueueOp[];
  meta: BackupMeta;
  hasAnyBusinessData: boolean;
}

export type LegacyPOSProfileSnapshotResult =
  | { status: 'missing_database' }
  | { status: 'missing_state'; snapshot: LegacyPOSProfileSnapshot }
  | { status: 'present'; snapshot: LegacyPOSProfileSnapshot }
  | { status: 'invalid_database' | 'invalid_state' | 'unavailable'; reason: string };

/**
 * Read every legacy POS persistence store without creating, seeding, migrating,
 * or mutating the IndexedDB database. This is the source snapshot for encrypted
 * profile migration; callers must verify the encrypted copy before changing
 * the legacy database.
 */
export async function idbReadLegacyProfileSnapshot(factory: IDBFactory = indexedDB): Promise<LegacyPOSProfileSnapshotResult> {
  if (!factory || typeof factory.databases !== 'function') {
    return { status: 'unavailable', reason: 'This runtime cannot safely enumerate existing IndexedDB databases.' };
  }

  let db: IDBDatabase | null = null;
  try {
    const existingDatabases = await factory.databases();
    if (!existingDatabases.some(info => info.name === DB_NAME)) return { status: 'missing_database' };

    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DB_NAME);
      let unexpectedUpgrade = false;
      request.onupgradeneeded = () => {
        unexpectedUpgrade = true;
        try { request.transaction?.abort(); } catch { /* request error handles this */ }
      };
      request.onsuccess = () => {
        if (unexpectedUpgrade) {
          request.result.close();
          reject(new Error('The IndexedDB database changed during legacy profile snapshot.')); 
          return;
        }
        resolve(request.result);
      };
      request.onerror = () => reject(request.error || new Error('Existing POS database could not be opened.'));
      request.onblocked = () => reject(new Error('Existing POS database is blocked by another open connection.'));
    });

    if (!db.objectStoreNames.contains(STORE_STATE)) {
      return { status: 'invalid_database', reason: 'The existing database does not contain the POS state store.' };
    }

    const storeNames = [STORE_STATE];
    if (db.objectStoreNames.contains(STORE_QUEUE)) storeNames.push(STORE_QUEUE);
    if (db.objectStoreNames.contains(STORE_META)) storeNames.push(STORE_META);
    const tx = db.transaction(storeNames, 'readonly');
    const stateStore = tx.objectStore(STORE_STATE);
    const stateRequest = idbReq<{ key: string; value: POSState; updatedAt?: string } | undefined>(stateStore.get('main'));
    const checkpointRequest = idbReq<{ key: string; value: POSState } | undefined>(stateStore.get('restore_checkpoint'));
    const queueRequest = storeNames.includes(STORE_QUEUE)
      ? idbReq<QueueOp[]>(tx.objectStore(STORE_QUEUE).getAll())
      : Promise.resolve([]);
    const metaRequest = storeNames.includes(STORE_META)
      ? idbReq<{ key: string; value: BackupMeta } | undefined>(tx.objectStore(STORE_META).get('backup'))
      : Promise.resolve(undefined);
    const txComplete = idbTransactionComplete(tx, 'Legacy POS profile snapshot failed');
    const [stateRow, checkpointRow, queueRows, metaRow] = await Promise.all([
      stateRequest, checkpointRequest, queueRequest, metaRequest,
    ]);
    await txComplete;

    const validState = (value: unknown): value is POSState => Boolean(
      value && typeof value === 'object' &&
      Array.isArray((value as POSState).products) &&
      Array.isArray((value as POSState).users) &&
      Array.isArray((value as POSState).sales),
    );
    if (stateRow && !validState(stateRow.value)) {
      return { status: 'invalid_state', reason: 'The saved POS state is incomplete or has an unsupported shape.' };
    }
    if (checkpointRow && !validState(checkpointRow.value)) {
      return { status: 'invalid_state', reason: 'The saved POS restore checkpoint is incomplete or has an unsupported shape.' };
    }
    if (!Array.isArray(queueRows) || queueRows.some(item =>
      !item || typeof item !== 'object' || typeof item.id !== 'string' ||
      typeof item.ts !== 'string' || typeof item.type !== 'string')) {
      return { status: 'invalid_state', reason: 'The saved offline sync queue contains an invalid entry.' };
    }
    if (metaRow && (!metaRow.value || typeof metaRow.value !== 'object' ||
      !Number.isFinite(metaRow.value.autoBackupHours) || !Number.isFinite(metaRow.value.backupCount))) {
      return { status: 'invalid_state', reason: 'The saved backup metadata is invalid.' };
    }

    const snapshot: LegacyPOSProfileSnapshot = {
      state: stateRow?.value || null,
      ...(typeof stateRow?.updatedAt === 'string' ? { stateUpdatedAt: stateRow.updatedAt } : {}),
      restoreCheckpoint: checkpointRow?.value || null,
      queue: [...(queueRows || [])].sort((a, b) => a.ts.localeCompare(b.ts)),
      meta: { autoBackupHours: 6, backupCount: 0, ...(metaRow?.value || {}) },
      hasAnyBusinessData: Boolean(stateRow?.value || checkpointRow?.value || queueRows?.length),
    };
    return stateRow
      ? { status: 'present', snapshot }
      : { status: 'missing_state', snapshot };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : 'Legacy POS profile snapshot failed.',
    };
  } finally {
    try { db?.close(); } catch { /* best-effort close */ }
  }
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
export function idbAvailable():boolean{return typeof indexedDB!=='undefined';}