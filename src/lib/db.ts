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
  | { id: string; ts: string; type: 'custom'; note: string; payload?: string };
export interface BackupMeta { lastAutoBackupAt?: string; lastManualBackupAt?: string; lastCloudBackupAt?: string; autoBackupHours: number; backupCount: number; }

function openDB(): Promise<IDBDatabase> { return new Promise((resolve,reject)=>{ const req=indexedDB.open(DB_NAME,DB_VERSION); req.onerror=()=>reject(req.error||new Error('IDB open failed')); req.onsuccess=()=>resolve(req.result); req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(STORE_STATE))db.createObjectStore(STORE_STATE,{keyPath:'key'});if(!db.objectStoreNames.contains(STORE_QUEUE)){const q=db.createObjectStore(STORE_QUEUE,{keyPath:'id'});q.createIndex('ts','ts',{unique:false});}if(!db.objectStoreNames.contains(STORE_META))db.createObjectStore(STORE_META,{keyPath:'key'});};}); }
function idbReq<T>(req: IDBRequest<T>): Promise<T> { return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);}); }
export async function idbLoadState():Promise<POSState|null>{try{const db=await openDB();const row=await idbReq<{key:string;value:POSState}|undefined>(db.transaction(STORE_STATE,'readonly').objectStore(STORE_STATE).get('main'));db.close();return row?.value??null;}catch{ /* storage unavailable */ return null; }}
export async function idbSaveState(state:POSState):Promise<boolean>{try{const db=await openDB();await idbReq(db.transaction(STORE_STATE,'readwrite').objectStore(STORE_STATE).put({key:'main',value:state,updatedAt:new Date().toISOString()}));db.close();return true;}catch{ /* storage unavailable */ return false; }}
export async function idbEnqueue(op:Omit<QueueOp,'id'|'ts'>&{id?:string;ts?:string}):Promise<void>{try{const db=await openDB();const entry={id:op.id||(crypto.randomUUID?.()||String(Date.now())),ts:op.ts||new Date().toISOString(),...op} as QueueOp;await idbReq(db.transaction(STORE_QUEUE,'readwrite').objectStore(STORE_QUEUE).put(entry));db.close();}catch{ /* queue unavailable; caller retains local state */ }}
export async function idbListQueue():Promise<QueueOp[]>{try{const db=await openDB();const all=await idbReq<QueueOp[]>(db.transaction(STORE_QUEUE,'readonly').objectStore(STORE_QUEUE).getAll());db.close();return(all||[]).sort((a,b)=>a.ts.localeCompare(b.ts));}catch{ /* queue unavailable */ return []; }}
/** Remove only operations covered by a successful cloud snapshot acknowledgement. */
export async function idbAcknowledgeQueue(ids:string[]):Promise<void>{if(!ids.length)return;try{const db=await openDB();const store=db.transaction(STORE_QUEUE,'readwrite').objectStore(STORE_QUEUE);for(const id of ids)await idbReq(store.delete(id));db.close();}catch{ /* acknowledgement will be retried */ }}
export async function idbClearQueue():Promise<void>{const ops=await idbListQueue();await idbAcknowledgeQueue(ops.map(op=>op.id));}
const DEFAULT_META:BackupMeta={autoBackupHours:6,backupCount:0};
export async function idbGetMeta():Promise<BackupMeta>{try{const db=await openDB();const row=await idbReq<{key:string;value:BackupMeta}|undefined>(db.transaction(STORE_META,'readonly').objectStore(STORE_META).get('backup'));db.close();return{...DEFAULT_META,...(row?.value||{})};}catch{ /* metadata unavailable */ return{...DEFAULT_META}; }}
export async function idbSetMeta(patch:Partial<BackupMeta>):Promise<BackupMeta>{const current=await idbGetMeta();const next={...current,...patch};try{const db=await openDB();await idbReq(db.transaction(STORE_META,'readwrite').objectStore(STORE_META).put({key:'backup',value:next}));db.close();}catch{ /* metadata write will be retried */ }return next;}
export function idbAvailable():boolean{return typeof indexedDB!=='undefined';}
