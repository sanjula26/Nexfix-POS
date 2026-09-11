/** Durable connectivity helpers and local sync queue. */
import { idbAcknowledgeQueue, idbEnqueue, idbListQueue, idbLoadState } from './db';
import { completeSaleAtomic, processSaleReturnAtomic, resolveSaleReturnLines, syncStateSnapshot } from './cloudSync';
import type { NewSaleInput } from './store';

export type Connectivity = 'online' | 'offline' | 'unknown';
export function getConnectivity(): Connectivity { if(typeof navigator==='undefined') return 'unknown'; return navigator.onLine?'online':'offline'; }
export function onConnectivityChange(cb:(status:Connectivity)=>void):()=>void { const up=()=>cb('online'); const down=()=>cb('offline'); window.addEventListener('online',up); window.addEventListener('offline',down); return()=>{window.removeEventListener('online',up);window.removeEventListener('offline',down);}; }
/** Persists a pending write; failure is surfaced so the UI cannot report a write as safely queued when storage is unavailable. */
export async function queueWrite(note?:string):Promise<void>{const queued=await idbEnqueue({type:'state_write',note});if(!queued)throw new Error('Local sync storage is unavailable; write was not queued safely.');}
export async function queueSaleCreate(saleId:string,input:NewSaleInput):Promise<void>{const queued=await idbEnqueue({type:'sale_create',id:`sale:${saleId}`,payload:JSON.stringify({saleId,input})});if(!queued)throw new Error('Local sync storage is unavailable; sale was not queued safely.');}
export async function queueReturnCreate(returnId:string,input:{saleId:string;reason:string;mode:'refund'|'replace';paymentMethod?:string;lines:Array<{product_id:string;qty:number;unit_ids?:string[]}>}):Promise<void>{const queued=await idbEnqueue({type:'return_create',id:`return:${returnId}`,payload:JSON.stringify({returnId,input})});if(!queued)throw new Error('Local sync storage is unavailable; return was not queued safely.');}
export async function getPendingSyncOperations(){return idbListQueue();}

let flushInFlight: Promise<{flushed:number;pending:number;synced:boolean;conflict:boolean}> | null = null;

/**
 * Flush transactional operations first. Each normalized cloud RPC is idempotent by its
 * stable sale/return identifier. Snapshot writes are handled afterwards so they never
 * substitute for a missing normalized transaction.
 */
export function flushSyncQueue():Promise<{flushed:number;pending:number;synced:boolean;conflict:boolean}>{
  if(flushInFlight) return flushInFlight;
  flushInFlight=(async()=>{
    const ops=await idbListQueue();
    let flushed=0;
    const acknowledged:string[]=[];

    for(const op of ops){
      if(op.type==='sale_create'){
        try{
          const parsed=JSON.parse(op.payload) as {saleId:string;input:NewSaleInput};
          const { ensureCloudShop, syncNormalizedCatalog } = await import('./cloudSync');
          const shop=await ensureCloudShop('Nexfix Shop');
          if(!shop.ok || !shop.shopId) break;
          const state=await idbLoadState();
          if(!state) break;
          if(state.users.some(u=>u.id===parsed.input.salesmanId) || state.users.length>0){
            const catalog=await syncNormalizedCatalog(state,shop.shopId);
            if(!catalog.ok) break;
          }
          const payments=(parsed.input.payments&&parsed.input.payments.length)
            ? parsed.input.payments.filter(p=>p.amount>0).map(p=>({method:p.method,amount:p.amount}))
            : [{method:parsed.input.payment,amount:parsed.input.amountPaid}];
          const result=await completeSaleAtomic({
            shopId:shop.shopId,saleId:parsed.saleId,customerId:parsed.input.customerId,shipping:parsed.input.shipping,
            discount:parsed.input.discount,taxPct:parsed.input.taxPct,pointsRedeemed:parsed.input.pointsRedeemed,note:parsed.input.note,
            salesmanId:parsed.input.salesmanId,lines:parsed.input.lines.map(l=>({product_id:l.productId,qty:l.qty,discount:l.discount,price:l.price,unit_ids:l.unitIds})),payments,
          });
          if(!result.ok) break;
          acknowledged.push(op.id); flushed++;
          continue;
        }catch{break;}
      }

      if(op.type==='return_create'){
        try{
          const parsed=JSON.parse(op.payload) as {returnId:string;input:{saleId:string;reason:string;mode:'refund'|'replace';paymentMethod?:string;lines:Array<{product_id:string;qty:number;unit_ids?:string[]}>}};
          const { ensureCloudShop } = await import('./cloudSync');
          const shop=await ensureCloudShop('Nexfix Shop');
          if(!shop.ok || !shop.shopId) break;
          const resolved=await resolveSaleReturnLines({shopId:shop.shopId,saleId:parsed.input.saleId,lines:parsed.input.lines});
          if(!resolved.ok || !resolved.lines) break;
          const result=await processSaleReturnAtomic({shopId:shop.shopId,returnId:parsed.returnId,saleId:parsed.input.saleId,reason:parsed.input.reason,mode:parsed.input.mode,paymentMethod:parsed.input.paymentMethod,lines:resolved.lines});
          if(!result.ok) break;
          acknowledged.push(op.id); flushed++;
          continue;
        }catch{break;}
      }
    }

    if(acknowledged.length) await idbAcknowledgeQueue(acknowledged);
    const remaining=await idbListQueue();
    const state=await idbLoadState();
    if(!state) return {flushed,pending:remaining.length,synced:false,conflict:false};
    const snapshotOps=remaining.filter(op=>op.type==='state_write' || op.type==='backup' || op.type==='custom');
    if(!snapshotOps.length) return {flushed,pending:remaining.length,synced:true,conflict:false};
    const result=await syncStateSnapshot(state);
    if(result.status==='synced'){
      const ids=snapshotOps.map(op=>op.id);
      await idbAcknowledgeQueue(ids);
      const after=await idbListQueue();
      return {flushed:flushed+ids.length,pending:after.length,synced:true,conflict:false};
    }
    return {flushed,pending:remaining.length,synced:false,conflict:result.status==='conflict'};
  })().finally(()=>{flushInFlight=null;});
  return flushInFlight;
}
export async function registerServiceWorker():Promise<boolean>{if(!('serviceWorker'in navigator))return false;try{const reg=await navigator.serviceWorker.register('/sw.js',{scope:'/'});if(reg.waiting)reg.waiting.postMessage({type:'SKIP_WAITING'});return true;}catch{return false;}}