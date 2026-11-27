/** Durable connectivity helpers and local sync queue. */
import type { InventoryUnit, Product, Purchase } from './types';
import { idbGetPendingSaleQueueIds, idbRemovePendingSaleQueueIds } from './db';
import { buildSaleCreateQueueInput } from './saleQueuePayload';
import { createDrainableWorkGate } from './drainableWorkGate';
import { idbAcknowledgeQueue, idbEnqueueDetailed, idbListQueue, idbLoadState } from './db';
import { getMachineIdentity } from './machine';
import { completeSaleAtomic, addInventoryUnitsAtomic, deleteInventoryUnitAtomic, adjustBranchStockAtomic, resolveCloudSalesmanId, registerTradeInAtomic, processSaleReturnAtomic, resolveSaleReturnLines, syncStateSnapshot, downloadStateSnapshot, ensureCloudShop, syncNormalizedCatalog, requestSaleReversal, approveSaleReversal, rejectSaleReversal, receivePurchaseAtomic, processRepairDeliveryAtomic } from './cloudSync';

type QueueStorageError = Error & { storageFailureKind?: 'quota_exceeded' | 'write_failed' };

async function idbEnqueueChecked(operation: Parameters<typeof idbEnqueueDetailed>[0]): Promise<boolean> {
  const result = await idbEnqueueDetailed(operation);
  if (!result.ok) {
    const error = new Error(result.error.message) as QueueStorageError;
    error.storageFailureKind = result.error.kind;
    throw error;
  }
  return true;
}

export type Connectivity = 'online' | 'offline' | 'unknown';
export function getConnectivity(): Connectivity { if(typeof navigator==='undefined') return 'unknown'; return navigator.onLine?'online':'offline'; }
export function onConnectivityChange(cb:(status:Connectivity)=>void):()=>void { const up=()=>cb('online'); const down=()=>cb('offline'); window.addEventListener('online',up); window.addEventListener('offline',down); return()=>{window.removeEventListener('online',up);window.removeEventListener('offline',down);}; }


const offlineQueueMutationWork = createDrainableWorkGate();
function runQueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  return offlineQueueMutationWork.run(
    operation,
    () => { throw new Error('POS local queue writes are temporarily paused for safe storage maintenance.'); },
  );
}

/**
 * Persists a pending local write. While offline, materialize local sales into
 * durable normalized transaction jobs. A sale job is keyed by its stable sale ID,
 * and existing queued sale IDs are checked before writing so repeated local-state
 * persistence does not repeatedly serialize/rewrite the same pending sale jobs.
 */
async function queueWriteWork(note?:string):Promise<void>{
  const queued=await idbEnqueueChecked({type:'state_write',note});
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
        branchId:sale.branchId || state.settings.branchId || 'local-main',
        customerId:sale.customerId,
        shipping:sale.shipping,
        discount:sale.discount,
        tradeInValue:sale.tradeIn?.value || 0,
        tradeIn: sale.tradeIn?.addToInventory && sale.tradeIn.productId ? {
          unitId: sale.tradeIn.unitId,
          productId: sale.tradeIn.productId,
          value: sale.tradeIn.value,
          imei: sale.tradeIn.imei,
          serial: sale.tradeIn.serial,
        } : undefined,
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
    const ok=await idbEnqueueChecked({type:'sale_create',id:`sale:${sale.id}`,payload:JSON.stringify(payload)});
    if(!ok)throw new Error('Local sync storage is unavailable; sale was not queued safely.');
  }
}

async function queueBranchStockAdjustmentWork(input:{shopId?:string;branchId:string;deviceId:string;productId:string;delta:number;note:string;adjustmentId:string;baseProduct?:Product}):Promise<void>{
  const queued=await idbEnqueueChecked({type:'branch_stock_adjustment',id:`branch-adjust:${input.adjustmentId}`,payload:JSON.stringify(input)});
  if(!queued)throw new Error('Local sync storage is unavailable; stock adjustment was not queued safely.');
}
async function queueInventoryUnitsAddWork(input:{shopId?:string;branchId:string;deviceId:string;units:InventoryUnit[];newUnitIds:string[];operationId:string}):Promise<void>{
  const queued=await idbEnqueueChecked({type:'inventory_units_add',id:`inventory-units:${input.operationId}`,payload:JSON.stringify(input)});
  if(!queued)throw new Error('Local sync storage is unavailable; tracked units were not queued safely.');
}
async function queueInventoryUnitDeleteWork(input:{shopId?:string;branchId:string;deviceId:string;unit:InventoryUnit;operationId:string}):Promise<void>{
  const queued=await idbEnqueueChecked({type:'inventory_unit_delete',id:`inventory-unit-delete:${input.operationId}`,payload:JSON.stringify(input)});
  if(!queued)throw new Error('Local sync storage is unavailable; tracked-unit deletion was not queued safely.');
}
async function queueRepairDeliveryWork(repairId:string,repair:unknown,deviceId:string):Promise<void>{const queued=await idbEnqueueChecked({type:'repair_delivery',id:`repair-delivery:${repairId}`,payload:JSON.stringify({repairId,repair,deviceId})});if(!queued)throw new Error('Local sync storage is unavailable; repair delivery was not queued safely.');}
async function queuePurchaseReceiveWork(purchaseId:string,input:{deviceId:string;purchase:unknown}):Promise<void>{const queued=await idbEnqueueChecked({type:'purchase_receive',id:`purchase-receive:${purchaseId}`,payload:JSON.stringify({purchaseId,input})});if(!queued)throw new Error('Local sync storage is unavailable; GRN was not queued safely.');}
async function queueSaleCreateWork(saleId:string,input:unknown):Promise<void>{const queued=await idbEnqueueChecked({type:'sale_create',id:`sale:${saleId}`,payload:JSON.stringify({saleId,input})});if(!queued)throw new Error('Local sync storage is unavailable; sale was not queued safely.');}
async function queueReturnCreateWork(returnId:string,input:{saleId:string;reason:string;mode:'refund'|'replace';paymentMethod?:string;lines:Array<{product_id:string;qty:number;unit_ids?:string[]}>}):Promise<void>{const queued=await idbEnqueueChecked({type:'return_create',id:`return:${returnId}`,payload:JSON.stringify({returnId,input})});if(!queued)throw new Error('Local sync storage is unavailable; return was not queued safely.');}
async function queueSaleReversalRequestWork(requestId:string,input:{saleId:string;reason:string}):Promise<void>{const queued=await idbEnqueueChecked({type:'sale_reversal_request',id:`sale-reversal-request:${requestId}`,payload:JSON.stringify({requestId,input})});if(!queued)throw new Error('Local sync storage is unavailable; reversal request was not queued safely.');}
async function queueSaleReversalApprovalWork(requestId:string):Promise<void>{const queued=await idbEnqueueChecked({type:'sale_reversal_approve',id:`sale-reversal-approve:${requestId}`,payload:JSON.stringify({requestId})});if(!queued)throw new Error('Local sync storage is unavailable; reversal approval was not queued safely.');}
async function queueSaleReversalRejectionWork(requestId:string,note?:string):Promise<void>{const queued=await idbEnqueueChecked({type:'sale_reversal_reject',id:`sale-reversal-reject:${requestId}`,payload:JSON.stringify({requestId,note})});if(!queued)throw new Error('Local sync storage is unavailable; reversal rejection was not queued safely.');}

/**
 * Pause all public queue-enqueue operations and wait for any in-flight
 * multi-record enqueue to finish before a consistent storage snapshot.
 * The caller must release the returned lease in a finally block.
 */
export function pauseOfflineQueueMutations(): Promise<() => void> {
  return offlineQueueMutationWork.pause();
}

export function queueWrite(note?: string): Promise<void> {
  return runQueueMutation(() => queueWriteWork(note));
}
export function queueBranchStockAdjustment(input: Parameters<typeof queueBranchStockAdjustmentWork>[0]): Promise<void> {
  return runQueueMutation(() => queueBranchStockAdjustmentWork(input));
}
export function queueInventoryUnitsAdd(input: Parameters<typeof queueInventoryUnitsAddWork>[0]): Promise<void> {
  return runQueueMutation(() => queueInventoryUnitsAddWork(input));
}
export function queueInventoryUnitDelete(input: Parameters<typeof queueInventoryUnitDeleteWork>[0]): Promise<void> {
  return runQueueMutation(() => queueInventoryUnitDeleteWork(input));
}
export function queueRepairDelivery(repairId: string, repair: unknown, deviceId: string): Promise<void> {
  return runQueueMutation(() => queueRepairDeliveryWork(repairId, repair, deviceId));
}
export function queuePurchaseReceive(purchaseId: string, input: Parameters<typeof queuePurchaseReceiveWork>[1]): Promise<void> {
  return runQueueMutation(() => queuePurchaseReceiveWork(purchaseId, input));
}
export function queueSaleCreate(saleId: string, input: unknown): Promise<void> {
  return runQueueMutation(() => queueSaleCreateWork(saleId, input));
}
export function queueReturnCreate(returnId: string, input: Parameters<typeof queueReturnCreateWork>[1]): Promise<void> {
  return runQueueMutation(() => queueReturnCreateWork(returnId, input));
}
export function queueSaleReversalRequest(requestId: string, input: Parameters<typeof queueSaleReversalRequestWork>[1]): Promise<void> {
  return runQueueMutation(() => queueSaleReversalRequestWork(requestId, input));
}
export function queueSaleReversalApproval(requestId: string): Promise<void> {
  return runQueueMutation(() => queueSaleReversalApprovalWork(requestId));
}
export function queueSaleReversalRejection(requestId: string, note?: string): Promise<void> {
  return runQueueMutation(() => queueSaleReversalRejectionWork(requestId, note));
}

/**
 * Recover the durable marker written before a local offline sale. State and
 * queue are separate storage domains, so a crash or quota failure between
 * them must leave a marker that lets the next sync attempt reconstruct the
 * exact normalized sale job from the saved sale record.
 */
export async function recoverPendingOfflineSaleQueues(): Promise<number> {
  const pendingIds = await idbGetPendingSaleQueueIds();
  if (!pendingIds.length) return 0;

  const state = await idbLoadState();
  if (!state) throw new Error('Could not read local POS state while recovering pending offline sales.');

  const queued = await idbListQueue();
  const confirmedIds: string[] = [];
  let restored = 0;

  for (const saleId of pendingIds) {
    const sale = state.sales.find(item => item.id === saleId);
    // Keep the marker when the sale is not in the committed local snapshot.
    // This avoids deleting a marker during a concurrent state-commit window.
    if (!sale) continue;

    const queueId = `sale:${saleId}`;
    const existing = queued.find(op => op.type === 'sale_create' && op.id === queueId);
    if (!existing) {
      await queueSaleCreate(saleId, buildSaleCreateQueueInput(sale, state.settings.branchId));
      restored += 1;
    }

    const readBack = await idbListQueue();
    if (!readBack.some(op => op.type === 'sale_create' && op.id === queueId)) {
      throw new Error(`Offline sale ${sale.billNo} is saved locally but its cloud sync queue could not be confirmed.`);
    }
    confirmedIds.push(saleId);
  }

  if (confirmedIds.length && !(await idbRemovePendingSaleQueueIds(confirmedIds))) {
    throw new Error('Offline sale queue was written, but its recovery marker could not be cleared. It will be checked again safely.');
  }
  return restored;
}

export async function getPendingSyncOperations(){return idbListQueue();}

let flushInFlight: Promise<{flushed:number;pending:number;synced:boolean;conflict:boolean}> | null = null;
const offlineQueueWork = createDrainableWorkGate();
export function pauseOfflineQueueFlush(): Promise<() => void> { return offlineQueueWork.pause(); }

/** Flush normalized transactions first, then legacy snapshot writes. */
export function flushSyncQueue():Promise<{flushed:number;pending:number;synced:boolean;conflict:boolean}>{
  if(flushInFlight) return flushInFlight;
  flushInFlight=offlineQueueWork.run(async()=>{
    await recoverPendingOfflineSaleQueues();
    const ops=await idbListQueue();
    let flushed=0;
    const acknowledged:string[]=[];
    const state=await idbLoadState();

    for(const op of ops){
      if(op.type==='inventory_unit_delete'){
        try{
          const parsed=JSON.parse(op.payload) as {shopId?:string;branchId:string;deviceId:string;unit:InventoryUnit;operationId:string};
          const shop=await ensureCloudShop('Nexfix Shop');
          if(!shop.ok || !shop.shopId) break;
          if(state){
            const catalog=await syncNormalizedCatalog({...state,units:[]},shop.shopId);
            if(!catalog.ok) break;
          }
          const restored=await addInventoryUnitsAtomic({shopId:shop.shopId,branchId:parsed.branchId,deviceId:parsed.deviceId,units:[parsed.unit]});
          if(!restored.ok) break;
          const deleted=await deleteInventoryUnitAtomic({shopId:shop.shopId,branchId:parsed.branchId,deviceId:parsed.deviceId,unitId:parsed.unit.id});
          if(!deleted.ok) break;
          acknowledged.push(op.id); flushed++;
          continue;
        }catch{break;}
      }
      if(op.type==='inventory_units_add'){
        try{
          const parsed=JSON.parse(op.payload) as {shopId?:string;branchId:string;deviceId:string;units:InventoryUnit[];newUnitIds:string[];operationId:string};
          const shop=await ensureCloudShop('Nexfix Shop');
          if(!shop.ok || !shop.shopId) break;
          if(state){
            const newIds=new Set(parsed.newUnitIds||[]);
            const additions=new Map<string,number>();
            for(const unit of parsed.units||[]) if(newIds.has(unit.id)) additions.set(unit.productId,(additions.get(unit.productId)||0)+1);
            const bootstrapState={...state,units:[],products:state.products.map(product=>({...product,stock:Math.max(0,product.stock-(additions.get(product.id)||0))}))};
            const catalog=await syncNormalizedCatalog(bootstrapState,shop.shopId);
            if(!catalog.ok) break;
          }
          const result=await addInventoryUnitsAtomic({...parsed,shopId:shop.shopId});
          if(!result.ok) break;
          acknowledged.push(op.id); flushed++;
          continue;
        }catch{break;}
      }
      if(op.type==='branch_stock_adjustment'){
        try{
          const parsed=JSON.parse(op.payload) as {shopId?:string;branchId:string;deviceId:string;productId:string;delta:number;note:string;adjustmentId:string;baseProduct?:Product};
          const shop=await ensureCloudShop('Nexfix Shop');
          if(!shop.ok || !shop.shopId) break;
          if(parsed.baseProduct && state){
            const hasBaseProduct=state.products.some(product=>product.id===parsed.baseProduct!.id); const bootstrapState={...state,products:hasBaseProduct?state.products.map(product=>product.id===parsed.baseProduct!.id?parsed.baseProduct!:product):[...state.products,parsed.baseProduct!]};
            const catalog=await syncNormalizedCatalog(bootstrapState,shop.shopId);
            if(!catalog.ok) break;
          }
          const result=await adjustBranchStockAtomic({...parsed,shopId:shop.shopId});
          if(!result.ok && result.error?.includes('Product is not synced to this cloud shop yet') && state){
            const catalog=await syncNormalizedCatalog(state,shop.shopId);
            if(!catalog.ok) break;
            // Catalog bootstrap already includes this local product's final stock.
            acknowledged.push(op.id); flushed++;
            continue;
          }
          if(!result.ok) break;
          acknowledged.push(op.id); flushed++;
          continue;
        }catch{break;}
      }

      if(op.type==='sale_create'){
        try{
          const parsed=JSON.parse(op.payload) as {saleId:string;input:{branchId?:string;customerId?:string;shipping?:number;discount:number;tradeInValue?:number;tradeIn?:{unitId?:string;productId:string;value:number;imei?:string;serial?:string};taxPct:number;pointsRedeemed?:number;note?:string;salesmanId?:string;lines:Array<{productId:string;qty:number;discount?:number;price?:number;unitIds?:string[]}>;payment:'cash'|'card'|'bank'|'mobile'|'credit';amountPaid:number;payments?:Array<{method:'cash'|'card'|'bank'|'mobile'|'credit';amount:number}>}};
          const shop=await ensureCloudShop('Nexfix Shop');
          if(!shop.ok || !shop.shopId) break;
          let customerIdMap: Record<string, string> = {};
          if(state) {
            const catalog=await syncNormalizedCatalog(state, shop.shopId);
            if(!catalog.ok && catalog.error !== 'Catalog sync requires admin or manager access') break;
            if(catalog.ok) customerIdMap = catalog.customerIdMap || {};
          }
          const payments=(parsed.input.payments&&parsed.input.payments.length)
            ? parsed.input.payments.filter(p=>p.amount>0).map(p=>({method:p.method,amount:p.amount}))
            : [{method:parsed.input.payment,amount:parsed.input.amountPaid}];
          const localSalesman = parsed.input.salesmanId && state
            ? state.users.find(u => u.id === parsed.input.salesmanId && u.active)
            : undefined;
          const cloudSalesmanId = await resolveCloudSalesmanId(shop.shopId, localSalesman);
          const result=await completeSaleAtomic({
            shopId:shop.shopId,branchId:parsed.input.branchId || state?.settings.branchId || 'local-main',deviceId:getMachineIdentity().id,saleId:parsed.saleId,customerId:parsed.input.customerId ? (customerIdMap[parsed.input.customerId] || parsed.input.customerId) : undefined,shipping:parsed.input.shipping,
            discount:parsed.input.discount + (parsed.input.tradeInValue || 0),taxPct:parsed.input.taxPct,pointsRedeemed:parsed.input.pointsRedeemed,note:parsed.input.note,
            salesmanId:cloudSalesmanId,lines:parsed.input.lines.map(l=>({product_id:l.productId,qty:l.qty,discount:l.discount,price:l.price,unit_ids:l.unitIds})),payments,
          });
          if(!result.ok) break;
          if (parsed.input.tradeIn?.productId && parsed.input.tradeIn.unitId) {
            const tradeIn = await registerTradeInAtomic({
              shopId: shop.shopId,
              saleId: parsed.saleId,
              unitId: parsed.input.tradeIn.unitId,
              productId: parsed.input.tradeIn.productId,
              value: parsed.input.tradeIn.value,
              imei: parsed.input.tradeIn.imei,
              serial: parsed.input.tradeIn.serial,
            });
            if (!tradeIn.ok) break;
          }
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
            if(!catalog.ok && catalog.error !== 'Catalog sync requires admin or manager access') break;
          }
          const result=await receivePurchaseAtomic({shopId:shop.shopId,branchId:parsed.input.purchase.branchId || state?.settings.branchId || 'local-main',deviceId:parsed.input.deviceId,purchaseId:parsed.purchaseId,purchase:parsed.input.purchase});
          if(!result.ok) break;
          acknowledged.push(op.id); flushed++;
          continue;
        }catch{break;}
      }

      if(op.type==='repair_delivery'){
        try{
          const parsed=JSON.parse(op.payload) as {repairId:string;repair:unknown;deviceId:string};
          const shop=await ensureCloudShop('Nexfix Shop');
          if(!shop.ok || !shop.shopId) break;
          const result=await processRepairDeliveryAtomic({shopId:shop.shopId,repairId:parsed.repairId,deviceId:parsed.deviceId,repair:parsed.repair});
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
  }, async()=>({flushed:0,pending:(await idbListQueue()).length,synced:false,conflict:false})).finally(()=>{flushInFlight=null;});
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
