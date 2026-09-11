/** Durable connectivity helpers and local sync queue. */
import { idbAcknowledgeQueue, idbEnqueue, idbListQueue, idbLoadState } from './db';
import { syncStateSnapshot } from './cloudSync';

export type Connectivity = 'online' | 'offline' | 'unknown';
export function getConnectivity(): Connectivity { if(typeof navigator==='undefined') return 'unknown'; return navigator.onLine?'online':'offline'; }
export function onConnectivityChange(cb:(status:Connectivity)=>void):()=>void { const up=()=>cb('online'); const down=()=>cb('offline'); window.addEventListener('online',up); window.addEventListener('offline',down); return()=>{window.removeEventListener('online',up);window.removeEventListener('offline',down);}; }
/** Persists a pending write; failure is surfaced so the UI cannot report a write as safely queued when storage is unavailable. */
export async function queueWrite(note?:string):Promise<void>{const queued=await idbEnqueue({type:'state_write',note});if(!queued)throw new Error('Local sync storage is unavailable; write was not queued safely.');}
export async function getPendingSyncOperations(){return idbListQueue();}

let flushInFlight: Promise<{flushed:number;pending:number;synced:boolean;conflict:boolean}> | null = null;

/** A queue item is acknowledged only after the cloud RPC confirms the snapshot. Concurrent callers share one flush so the same queue item cannot be uploaded/acknowledged twice. */
export function flushSyncQueue():Promise<{flushed:number;pending:number;synced:boolean;conflict:boolean}>{
  if(flushInFlight) return flushInFlight;
  flushInFlight=(async()=>{
    const ops=await idbListQueue(); const state=await idbLoadState();
    if(!state) return {flushed:0,pending:ops.length,synced:false,conflict:false};
    const result=await syncStateSnapshot(state);
    if(result.status==='synced'){
      const ids=ops.map(op=>op.id);
      await idbAcknowledgeQueue(ids);
      const remaining=await idbListQueue();
      return {flushed:ids.length,pending:remaining.length,synced:true,conflict:false};
    }
    return {flushed:0,pending:ops.length,synced:false,conflict:result.status==='conflict'};
  })().finally(()=>{flushInFlight=null;});
  return flushInFlight;
}
export async function registerServiceWorker():Promise<boolean>{if(!('serviceWorker'in navigator))return false;try{const reg=await navigator.serviceWorker.register('/sw.js',{scope:'/'});if(reg.waiting)reg.waiting.postMessage({type:'SKIP_WAITING'});return true;}catch{return false;}}