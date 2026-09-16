// Durable IndexedDB state and sync queue for Nexfix POS.
import type { POSState } from './types';
import { buildSeed } from './seed';
import { SEED_HASH_ADMIN, SEED_HASH_CASHIER } from './utils';

const DB_NAME = 'nexfix_pos_db';
const DB_VERSION = 1;
const STORE_STATE = 'app_state';
const STORE_QUEUE = 'sync_queue';
const STORE_META = 'meta';
const DEFAULT_ADMIN_EMAIL = 'admin@nexfixsolution.com';
const DEFAULT_CASHIER_EMAIL = 'cashier@nexfixsolution.com';
const LEGACY_DEFAULT_ADMIN_EMAIL = 'admin@nexfix.lk';

export type QueueOp =
  | { id: string; ts: string; type: 'state_write'; note?: string }
  | { id: string; ts: string; type: 'backup'; note?: string }
  | { id: string; ts: string; type: 'custom'; note: string; payload?: string }
  | { id: string; ts: string; type: 'sale_create'; payload: string }
  | { id: string; ts: string; type: 'return_create'; payload: string };
export interface BackupMeta { lastAutoBackupAt?: string; lastManualBackupAt?: string; lastCloudBackupAt?: string; autoBackupHours: number; backupCount: number; }

function openDB(): Promise<IDBDatabase> { return new Promise((resolve,reject)=>{ const req=indexedDB.open(DB_NAME,DB_VERSION); req.onerror=()=>reject(req.error||new Error('IDB open failed')); req.onsuccess=()=>resolve(req.result); req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(STORE_STATE))db.createObjectStore(STORE_STATE,{keyPath:'key'});if(!db.objectStoreNames.contains(STORE_QUEUE)){const q=db.createObjectStore(STORE_QUEUE,{keyPath:'id'});q.createIndex('ts','ts',{unique:false});}if(!db.objectStoreNames.contains(STORE_META))db.createObjectStore(STORE_META,{keyPath:'key'});};}); }
function idbReq<T>(req: IDBRequest<T>): Promise<T> { return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);}); }

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

/** Repair only the documented recovery accounts. Existing business data and
 * all other user accounts are preserved. */
function repairDefaultAccounts(state: POSState): POSState {
  const users = [...(state.users || [])];
  let changed = false;
  const now = new Date().toISOString();

  const adminIdx = users.findIndex(u => {
    const email = (u.email || '').trim().toLowerCase();
    return email === DEFAULT_ADMIN_EMAIL || email === LEGACY_DEFAULT_ADMIN_EMAIL;
  });
  if (adminIdx < 0) {
    users.unshift({ id:'u-admin', name:'Shop Administrator', email:DEFAULT_ADMIN_EMAIL, password:SEED_HASH_ADMIN, role:'admin', active:true, createdAt:now });
    changed = true;
  } else {
    const u = users[adminIdx];
    if (u.email !== DEFAULT_ADMIN_EMAIL || u.password !== SEED_HASH_ADMIN || u.role !== 'admin' || !u.active) {
      users[adminIdx] = { ...u, email:DEFAULT_ADMIN_EMAIL, password:SEED_HASH_ADMIN, role:'admin', active:true, name:u.name || 'Shop Administrator' };
      changed = true;
    }
  }

  // Keep the normal cashier account available for the POS role-switch and
  // repair only that documented recovery account if it already exists.
  const cashierIdx = users.findIndex(u => (u.email || '').trim().toLowerCase() === DEFAULT_CASHIER_EMAIL);
  if (cashierIdx < 0) {
    users.push({ id:'u-nimal', name:'Cashier', email:DEFAULT_CASHIER_EMAIL, password:SEED_HASH_CASHIER, role:'cashier', active:true, createdAt:now });
    changed = true;
  } else {
    const u = users[cashierIdx];
    if (u.password !== SEED_HASH_CASHIER || u.role !== 'cashier' || !u.active) {
      users[cashierIdx] = { ...u, email:DEFAULT_CASHIER_EMAIL, password:SEED_HASH_CASHIER, role:'cashier', active:true, name:u.name || 'Cashier' };
      changed = true;
    }
  }

  return changed ? { ...state, users } : state;
}

export async function idbLoadState():Promise<POSState|null>{
  try {
    const db=await getDB();
    const row=await idbReq<{key:string;value:POSState}|undefined>(db.transaction(STORE_STATE,'readonly').objectStore(STORE_STATE).get('main'));
    const source=row?.value ?? buildSeed();
    const repaired=repairDefaultAccounts(source);
    if (!row?.value || repaired !== row.value) await idbSaveState(repaired);
    return repaired;
  } catch { return null; }
}
export async function idbSaveState(state:POSState):Promise<boolean>{try{const db=await getDB();await idbReq(db.transaction(STORE_STATE,'readwrite').objectStore(STORE_STATE).put({key:'main',value:state,updatedAt:new Date().toISOString()}));return true;}catch{return false;}}
export async function idbSaveRestoreCheckpoint(state:POSState):Promise<boolean>{try{const db=await getDB();const tx=db.transaction(STORE_STATE,'readwrite');tx.objectStore(STORE_STATE).put({key:'restore_checkpoint',value:state,updatedAt:new Date().toISOString()});await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error||new Error('Restore checkpoint failed'));tx.onabort=()=>reject(tx.error||new Error('Restore checkpoint aborted'));});return true;}catch{return false;}}
export async function idbLoadRestoreCheckpoint():Promise<POSState|null>{try{const db=await getDB();const row=await idbReq<{key:string;value:POSState}|undefined>(db.transaction(STORE_STATE,'readonly').objectStore(STORE_STATE).get('restore_checkpoint'));return row?.value??null;}catch{return null;}}
export async function idbClearRestoreCheckpoint():Promise<boolean>{try{const db=await getDB();await idbReq(db.transaction(STORE_STATE,'readwrite').objectStore(STORE_STATE).delete('restore_checkpoint'));return true;}catch{return false;}}

type QueueInput={type:QueueOp['type'];id?:string;ts?:string;note?:string;payload?:string};
export async function idbEnqueue(op:QueueInput):Promise<boolean>{try{const db=await getDB();const entry={id:op.id||(crypto.randomUUID?.()||String(Date.now())),ts:op.ts||new Date().toISOString(),...op} as QueueOp;await idbReq(db.transaction(STORE_QUEUE,'readwrite').objectStore(STORE_QUEUE).put(entry));return true;}catch{return false;}}
export async function idbListQueue():Promise<QueueOp[]>{try{const db=await getDB();const all=await idbReq<QueueOp[]>(db.transaction(STORE_QUEUE,'readonly').objectStore(STORE_QUEUE).getAll());return(all||[]).sort((a,b)=>a.ts.localeCompare(b.ts));}catch{return[];}}
export async function idbAcknowledgeQueue(ids:string[]):Promise<void>{if(!ids.length)return;try{const db=await getDB();const tx=db.transaction(STORE_QUEUE,'readwrite');const store=tx.objectStore(STORE_QUEUE);for(const id of ids)store.delete(id);await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error||new Error('Queue acknowledgement failed'));tx.onabort=()=>reject(tx.error||new Error('Queue acknowledgement aborted'));});}catch{/* best-effort cleanup */}}
export async function idbDeleteQueue(id:string):Promise<void>{if(!id)return;try{const db=await getDB();await idbReq(db.transaction(STORE_QUEUE,'readwrite').objectStore(STORE_QUEUE).delete(id));}catch{/* best-effort cleanup */}}
export async function idbClearQueue():Promise<void>{const ops=await idbListQueue();await idbAcknowledgeQueue(ops.map(op=>op.id));}
const DEFAULT_META:BackupMeta={autoBackupHours:6,backupCount:0};
export async function idbGetMeta():Promise<BackupMeta>{try{const db=await getDB();const row=await idbReq<{key:string;value:BackupMeta}|undefined>(db.transaction(STORE_META,'readonly').objectStore(STORE_META).get('backup'));return{...DEFAULT_META,...(row?.value||{})};}catch{return{...DEFAULT_META};}}
export async function idbSetMeta(patch:Partial<BackupMeta>):Promise<BackupMeta>{const current=await idbGetMeta();const next={...current,...patch};try{const db=await getDB();await idbReq(db.transaction(STORE_META,'readwrite').objectStore(STORE_META).put({key:'backup',value:next}));}catch{/* metadata is best-effort */}return next;}
export function idbAvailable():boolean{return typeof indexedDB!=='undefined';}
