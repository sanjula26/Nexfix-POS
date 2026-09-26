/** Durable connectivity helpers and local sync queue. */
import type { Purchase } from './types';
import { idbAcknowledgeQueue, idbEnqueue, idbListQueue, idbLoadState } from './db';
import { completeSaleAtomic, processSaleReturnAtomic, resolveSaleReturnLines, syncStateSnapshot, downloadStateSnapshot, ensureCloudShop, syncNormalizedCatalog, requestSaleReversal, approveSaleReversal, rejectSaleReversal, receivePurchaseAtomic } from './cloudSync';

export type Connectivity = 'online' | 'offline' | 'unknown';
export function getConnectivity(): Connectivity { if(typeof navigator==='undefined') return 'unknown'; return navigator.onLine?'online':'offline'; }
export function onConnectivityChange(cb:(status:Connectivity)=>void):()=>void { const up=()=>cb('online'); const down=()=>cb('offline'); window.addEventListener('online',up); window.addEventListener('offline',down); return()=>{window.removeEventListener('online',up);window.removeEventListener('offline',down);}; }

/**
 * Persists a pending local write. While offline, materialize local sales into
 * durable normalized transaction jobs. A sale job is keyed by its stable sale ID,
 * and existing queued sale IDs are checked before writing so repeated local-state
 * persistence does not repeatedly serialize/rewrite the same pending sale jobs.
 */
export async function queueWrite(note?:string):Promise<void>{
  const queued=await idbEnqueue({type:'state_write',note});
  if(!queued)throw new Error('Local sync storage is unavailable; write was not queued safely.');
  const state=await idbLoadState();
  if(!state) return;
  const existingSaleIds=new Set(
    (await idbListQueue())
      .filter(op=>op.type==='sale_create')
      .map(op=>op.id.slice('sale:'.length)),
  );
  for(const sale of state.sales){
    if(existingSaleIds.has(sale.id)) continue;
    const payload={
      saleId:sale.id,
      input:{
        customerId:sale.customerId,
        shipping:sale.shipping,
        discount:sale.discount,
        tradeInValue:sale.tradeIn?.value || 0,
        taxPct:Math.max(0,sale.subtotal-sale.discount-(sale.tradeIn?.value || 0))>0 ? (sale.tax / Math.max(0,sale.subtotal-sale.discount-(sale.tradeIn?.value || 0))) * 100 : 0,
        pointsRedeemed:sale.pointsRedeemed,
        note:sale.note,
        salesmanId:sale.cashierId,
        lines:sale.items.map(item=>({productId:item.productId,qty:item.qty,discount:item.discount,price:item.price,unitIds:item.unitIds})),
        payment:sale.payment,
        amountPaid:sale.amountPaid,
        payments:sale.payments,
      },
    };
    const ok=await idbEnqueue({type:'sale_create',id:`sale:${sale.id}`,payload:JSON.stringify(payload)});
    if(!ok)throw new Error('Local sync storage is unavailable; sale was not queued safely.');
  }
}

export async function queuePurchaseReceive(purchaseId:string,input:{deviceId:string;purchase:unknown}):Promise<void>{const queued=await idbEnqueue({type:'purchase_receive',id:`purchase-receive:${purchaseId}`,payload:JSON.stringify({purchaseId,input})});if(!queued)throw new Error('Local sync storage is unavailable; GRN was not queued safely.');}
export async function queueSaleCreate(saleId:string,input:unknown):Promise<void>{const queued=await idbEnqueue({type:'sale_create',id:`sale:${saleId}`,payload:JSON.stringify({saleId,input})});if(!queued)throw new Error('Local sync storage is unavailable; sale was not queued safely.');}
export async function queueReturnCreate(returnId:string,input:{saleId:string;reason:string;mode:'refund'|'replace';paymentMethod?:string;lines:Array<{product_id:string;qty:number;unit_ids?:string[]}>}):Promise<void>{const queued=await idbEnqueue({type:'return_create',id:`return:${returnId}`,payload:JSON.stringify({returnId,input})});if(!queued)throw new Error('Local sync storage is unavailable; return was not queued safely.');}
export async function queueSaleReversalRequest(requestId:string,input:{saleId:string;reason:string}):Promise<void>{const queued=await idbEnqueue({type:'sale_reversal_request',id:`sale-reversal-request:${requestId}`,payload:JSON.stringify({requestId,input})});if(!queued)throw new Error('Local sync storage is unavailable; reversal request was not queued safely.');}
export async function queueSaleReversalApproval(requestId:string):Promise<void>{const queued=await idbEnqueue({type:'sale_reversal_approve',id:`sale-reversal-approve:${requestId}`,payload:JSON.stringify({requestId})});if(!queued)throw new Error('Local sync storage is unavailable; reversal approval was not queued safely.');}
export async function queueSaleReversalRejection(requestId:string,note?:string):Promise<void>{const queued=await idbEnqueue({type:'sale_reversal_reject',id:`sale-reversal-reject:${requestId}`,payload:JSON.stringify({requestId,note})});if(!queued)throw new Error('Local sync storage is unavailable; reversal rejection was not queued safely.');}
export async function getPendingSyncOperations(){return idbListQueue();}

let flushInFlight: Promise<{flushed:number;pending:number;synced:boolean;conflict:boolean}> | null = null;

/** Flush normalized transactions first, then legacy snapshot writes. */
export function flushSyncQueue():Promise<{flushed:number;pending:number;synced:boolean;conflict:boolean}>{
  if(flushInFlight) return flushInFlight;
  flushInFlight=(async()=>{
    const ops=await idbListQueue();
    let flushed=0;
    const acknowledged:string[]=[];
    const state=await idbLoadState();

    for(const op of ops){
      if(op.type==='sale_create'){
        try{
          const parsed=JSON.parse(op.payload) as {saleId:string;input:{customerId?:string;shipping?:number;discount:number;tradeInValue?:number;taxPct:number;pointsRedeemed?:number;note?:string;salesmanId?:string;lines:Array<{productId:string;qty:number;discount?:number;price?:number;unitIds?:string[]}>;payment:'cash'|'card'|'bank'|'mobile'|'credit';amountPaid:number;payments?:Array<{method:'cash'|'card'|'bank'|'mobile'|'credit';amount:number}>}};
          const shop=await ensureCloudShop('Nexfix Shop');
          if(!shop.ok || !shop.shopId) break;
          if(state) {
            const catalog=await syncNormalizedCatalog(state, shop.shopId);
            if(!catalog.ok && catalog.error !== 'Catalog sync requires admin or manager access') break;
          }
          const payments=(parsed.input.payments&&parsed.input.payments.length)
            ? parsed.input.payments.filter(p=>p.amount>0).map(p=>({method:p.method,amount:p.amount}))
            : [{method:parsed.input.payment,amount:parsed.input.amountPaid}];
          const result=await completeSaleAtomic({
            shopId:shop.shopId,saleId:parsed.saleId,customerId:parsed.input.customerId,shipping:parsed.input.shipping,
            discount:parsed.input.discount + (parsed.input.tradeInValue || 0),taxPct:parsed.input.taxPct,pointsRedeemed:parsed.input.pointsRedeemed,note:parsed.input.note,
            salesmanId:parsed.input.salesmanId,lines:parsed.input.lines.map(l=>({product_id:l.productId,qty:l.qty,discount:l.discount,price:l.price,unit_ids:l.unitIds})),payments,
          });
          if(!result.ok) break;
          acknowledged.push(op.id); flushed++;
          continue;
        }catch{break;}
      }

      if(op.type==='purchase_receive'){
        try{
          const parsed=JSON.parse(op.payload) as {purchaseId:string;input:{deviceId:string;purchase:Purchase}};
          const shop=await ensureCloudShop('Nexfix Shop');
          if(!shop.ok || !shop.shopId) break;
          const catalogState=state || undefined;
          if(catalogState){
            const catalog=await syncNormalizedCatalog(catalogState,shop.shopId);
            if(!catalog.ok) break;
          }
          const result=await receivePurchaseAtomic({shopId:shop.shopId,purchaseId:parsed.purchaseId,deviceId:parsed.input.deviceId,purchase:parsed.input.purchase});
          if(!result.ok) break;
          acknowledged.push(op.id); flushed++;
          continue;
        }catch{break;}
      }

      if(op.type==='sale_reversal_request'){
        try{
          const parsed=JSON.parse(op.payload) as {requestId:string;input:{saleId:string;reason:string}};
          const shop=await ensureCloudShop('Nexfix Shop');
          if(!shop.ok || !shop.shopId) break;
          const result=await requestSaleReversal({shopId:shop.shopId,requestId:parsed.requestId,saleId:parsed.input.saleId,reason:parsed.input.reason});
          if(!result.ok) break;
          acknowledged.push(op.id); flushed++;
          continue;
        }catch{break;}
      }

      if(op.type==='sale_reversal_approve'){
        try{
          const parsed=JSON.parse(op.payload) as {requestId:string};
          const shop=await ensureCloudShop('Nexfix Shop');
          if(!shop.ok || !shop.shopId) break;
          const result=await approveSaleReversal({shopId:shop.shopId,requestId:parsed.requestId});
          if(!result.ok) break;
          acknowledged.push(op.id); flushed++;
          continue;
        }catch{break;}
      }

      if(op.type==='sale_reversal_reject'){
        try{
          const parsed=JSON.parse(op.payload) as {requestId:string;note?:string};
          const shop=await ensureCloudShop('Nexfix Shop');
          if(!shop.ok || !shop.shopId) break;
          const result=await rejectSaleReversal({shopId:shop.shopId,requestId:parsed.requestId,note:parsed.note});
          if(!result.ok) break;
          acknowledged.push(op.id); flushed++;
          continue;
        }catch{break;}
      }

      if(op.type==='return_create'){
        try{
          const parsed=JSON.parse(op.payload) as {returnId:string;input:{saleId:string;reason:string;mode:'refund'|'replace';paymentMethod?:string;lines:Array<{product_id:string;qty:number;unit_ids?:string[]}>}};
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
    const latestState=await idbLoadState();
    if(!latestState) return {flushed,pending:remaining.length,synced:false,conflict:false};
    const snapshotOps=remaining.filter(op=>op.type==='state_write' || op.type==='backup' || op.type==='custom');

    // Bootstrap the cloud snapshot even when the durable queue is empty.
    // This is important for a freshly connected POS: otherwise the first
    // successful startup could report "synced" without ever publishing the
    // existing local state, leaving read-only/mobile cloud views empty.
    // Never overwrite an existing cloud snapshot here; normal queued writes
    // continue to use the revision/conflict protocol below.
    if(!snapshotOps.length){
      const shop=await ensureCloudShop('Nexfix Shop');
      if(!shop.ok || !shop.shopId){
        return {flushed,pending:remaining.length,synced:false,conflict:false};
      }
      const remote=await downloadStateSnapshot();
      if(!remote){
        const initial=await syncStateSnapshot(latestState);
        if(initial.status==='synced') return {flushed,pending:remaining.length,synced:true,conflict:false};
        if(initial.status==='conflict') return {flushed,pending:remaining.length,synced:false,conflict:true};
        return {flushed,pending:remaining.length,synced:false,conflict:false};
      }
      return {flushed,pending:remaining.length,synced:true,conflict:false};
    }

    const result=await syncStateSnapshot(latestState);
    if(result.status==='synced'){
      const ids=snapshotOps.map(op=>op.id);
      await idbAcknowledgeQueue(ids);
      const after=await idbListQueue();
      return {flushed:flushed+ids.length,pending:after.length,synced:true,conflict:false};
    }
    if(result.status==='conflict' && typeof window !== 'undefined'){
      window.setTimeout(() => {
        window.alert('Nexfix POS: Another PC has changed the cloud snapshot. Your local data was NOT overwritten. Pending sync items were kept safe. Review the cloud/local data before trying Sync again.');
      }, 0);
    }
    return {flushed,pending:remaining.length,synced:false,conflict:result.status==='conflict'};
  })().finally(()=>{flushInFlight=null;});
  return flushInFlight;
}

export async function registerServiceWorker():Promise<boolean>{
  if(typeof window==='undefined' || typeof navigator==='undefined') return false;
  const isElectronRuntime =
    window.location.protocol === 'file:' ||
    navigator.userAgent.toLowerCase().includes('electron') ||
    Boolean((window as Window & {nexfixDesktop?: unknown}).nexfixDesktop);
  if(isElectronRuntime) return false;
  if(!('serviceWorker' in navigator)) return false;
  try {
    const baseUrl = import.meta.env.BASE_URL || '/';
    const serviceWorkerUrl = new URL('sw.js', new URL(baseUrl, window.location.origin));
    const scope = new URL(baseUrl, window.location.origin).pathname;
    const reg = await navigator.serviceWorker.register(serviceWorkerUrl, { scope });
    if(reg.waiting) reg.waiting.postMessage({type:'SKIP_WAITING'});
    return true;
  } catch {
    return false;
  }
}
