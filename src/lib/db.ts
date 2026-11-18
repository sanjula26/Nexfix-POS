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

/** Read the authoritative state without creating demo data when the row is absent.
 * Returns undefined for a genuinely empty store and null when IndexedDB access fails.
 */
export async function idbReadState(): Promise<POSState | undefined | null> {
  try {
    const db = await getDB();
    const row = await idbReq<{ key: string; value: POSState } | undefined>(
      db.transaction(STORE_STATE, 'readonly').objectStore(STORE_STATE).get('main'),
    );
    if (!row) return undefined;
    if (!row.value || typeof row.value !== 'object' || Array.isArray(row.value)) return null;
    return row.value;
  } catch {
    return null;
  }
}

/** Detect durable evidence of previous use when the authoritative main row is missing.
 * Returns null when any of the required stores cannot be inspected.
 */
export async function idbHasPriorUseEvidence(): Promise<boolean | null> {
  try {
    const db = await getDB();
    const tx = db.transaction([STORE_STATE, STORE_QUEUE, STORE_META], 'readonly');
    const completed = idbTransactionComplete(tx, 'Could not verify IndexedDB prior-use evidence');
    const [stateCount, queueCount, metaCount] = await Promise.all([
      idbReq(tx.objectStore(STORE_STATE).count()),
      idbReq(tx.objectStore(STORE_QUEUE).count()),
      idbReq(tx.objectStore(STORE_META).count()),
      completed,
    ]);
    return stateCount > 0 || queueCount > 0 || metaCount > 0;
  } catch {
    return null;
  }
}

/** Atomically create the initial main row without overwriting a concurrent restore.
 * All readwrite transactions for this object store are serialized by IndexedDB.
 */
export async function idbInitializeStateIfAbsent(state: POSState): Promise<POSState | null> {
  try {
    const db = await getDB();
    const tx = db.transaction(STORE_STATE, 'readwrite');
    const completed = idbTransactionComplete(tx, 'Initial POS state creation failed');
    const store = tx.objectStore(STORE_STATE);
    const existing = await idbReq<{ key: string; value: unknown } | undefined>(store.get('main'));
    if (existing) {
      await completed;
      return existing.value && typeof existing.value === 'object' && !Array.isArray(existing.value)
        ? existing.value as POSState
        : null;
    }
    store.add({ key: 'main', value: state, updatedAt: new Date().toISOString() });
    await completed;
    return state;
  } catch {
    // If another window completed initialization, return its committed state.
    // Never fall back to put(), which could overwrite that state.
    const latest = await idbReadState();
    return latest && latest !== undefined ? latest : null;
  }
}

export async function idbLoadState(): Promise<POSState | null> {
  const stored = await idbReadState();
  if (stored !== undefined) return stored;

  // Only callers that have established this is a genuine first run should
  // request seed initialization. Existing shops must use the read-only probe.
  try {
    const { buildSeed } = await import('./seed');
    return await idbInitializeStateIfAbsent(buildSeed());
  } catch {
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