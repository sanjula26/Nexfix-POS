import { useMemo, useState } from 'react';
import { Cpu, Plus, Trash2, Smartphone } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, Modal, Field, PageHeading, EmptyState, SearchInput } from '../components/ui';
import { fmtDate, uid } from '../lib/utils';
import type { InventoryUnit, UnitStatus } from '../lib/types';

const STATUS_TONE: Record<UnitStatus, 'emerald'|'slate'|'amber'|'violet'|'rose'> = { in_stock:'emerald', sold:'slate', returned:'amber', reserved:'violet', defective:'rose', in_repair:'amber' };
const STATUS_LABEL: Record<UnitStatus,string> = { in_stock:'In stock', sold:'Sold', returned:'Returned', reserved:'Reserved', defective:'Defective', in_repair:'In repair' };

export default function Units() {
  const { state, saveUnit, deleteUnit, saveProduct, can } = usePOS();
  const [q,setQ]=useState(''); const [status,setStatus]=useState<string>('all');
  const [editing,setEditing]=useState<InventoryUnit|null>(null); const [isNew,setIsNew]=useState(false);
  const units=state.units||[]; const products=state.products;
  const trackedProducts=useMemo(()=>products.filter(p=>p.trackImei||p.trackSerial),[products]);
  const rows=useMemo(()=>{ const query=q.trim().toLowerCase(); return units.filter(u=>{ if(status!=='all'&&u.status!==status)return false; if(!query)return true; const p=products.find(x=>x.id===u.productId); return `${p?.name||''} ${u.imei||''} ${u.serial||''}`.toLowerCase().includes(query); }); },[units,products,q,status]);
  return <div className="space-y-6">
    <PageHeading title="Units / IMEI & Serial" sub="Track individual sellable units and warranty status." actions={can('act:manageStock')&&trackedProducts.length>0?<button className="btn-primary" onClick={()=>{setEditing(null);setIsNew(true)}}><Plus size={16}/> Add unit</button>:undefined}/>
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3"><SearchInput value={q} onChange={setQ} placeholder="Search IMEI, serial or product"/><select className="input" value={status} onChange={e=>setStatus(e.target.value)}><option value="all">All statuses</option>{(Object.keys(STATUS_LABEL) as UnitStatus[]).map(s=><option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select><div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">Showing {rows.length} of {units.length} units</div></div>
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">{rows.length===0?<EmptyState icon={<Smartphone size={28}/>} title="No units found" sub="Add a unit or change the search filter."/>:<div className="divide-y divide-slate-100">{rows.map(u=>{const p=products.find(x=>x.id===u.productId);return <div key={u.id} className="flex items-center justify-between gap-4 px-4 py-3"><div><div className="font-medium text-slate-900">{p?.name||'Unknown product'}</div><div className="text-xs text-slate-500">{u.imei||u.serial||'No IMEI/serial'} · Added {fmtDate(u.createdAt)}</div></div><div className="flex items-center gap-3"><Badge tone={STATUS_TONE[u.status]}>{STATUS_LABEL[u.status]}</Badge>{can('act:manageStock')&&<button className="btn-ghost" onClick={()=>{setEditing(u);setIsNew(false)}} aria-label="Edit unit"><Cpu size={16}/></button>}{can('act:manageStock')&&u.status==='in_stock'&&<button className="btn-ghost text-rose-600" onClick={()=>{if(p) saveProduct({...p,stock:Math.max(0,p.stock-1)});deleteUnit(u.id)}} aria-label="Delete unit"><Trash2 size={16}/></button>}</div></div>})}</div>}</div>
    {editing||isNew?<Modal open title={isNew?'Add inventory unit':'Edit inventory unit'} onClose={()=>{setEditing(null);setIsNew(false)}}><UnitEditor value={editing} products={isNew?trackedProducts:products} units={units} isNew={isNew} onSave={(unit)=>{const p=products.find(x=>x.id===unit.productId);if(!p)return;if(isNew){const placeholder=units.find(x=>x.productId===p.id&&x.status==='in_stock'&&((p.trackImei&&!x.imei)||(p.trackSerial&&!x.serial)));if(placeholder){saveUnit({...unit,id:placeholder.id,purchaseId:placeholder.purchaseId,createdAt:placeholder.createdAt});}else{saveProduct({...p,stock:p.stock+1});saveUnit(unit);}}else{saveUnit(unit);}}} onClose={()=>{setEditing(null);setIsNew(false)}}/></Modal>:null}
  </div>;
}

function UnitEditor({value,products,units,isNew,onSave,onClose}:{value:InventoryUnit|null;products:any[];units:InventoryUnit[];isNew:boolean;onSave:(u:InventoryUnit)=>void;onClose:()=>void}){
 const [productId,setProductId]=useState(value?.productId||products[0]?.id||''); const [imei,setImei]=useState(value?.imei||''); const [serial,setSerial]=useState(value?.serial||''); const [status,setStatus]=useState<UnitStatus>(value?.status||'in_stock'); const [note,setNote]=useState(value?.note||''); const [error,setError]=useState('');
 const submit=()=>{
   const product=products.find(p=>p.id===productId);
   if(!product){setError('Select a product.');return;}
   const normalizedImei=imei.trim(); const normalizedSerial=serial.trim();
   if(product.trackImei&&!normalizedImei){setError('IMEI is required for this tracked product.');return;}
   if(product.trackSerial&&!normalizedSerial){setError('Serial number is required for this tracked product.');return;}
   if(isNew&&units.some(x=>x.status==='in_stock'&&((normalizedImei&&x.imei===normalizedImei)||(normalizedSerial&&x.serial===normalizedSerial)))){setError('That IMEI or serial number is already in stock.');return;}
   const unit:InventoryUnit={id:value?.id||uid(),productId:isNew?productId:(value?.productId||productId),imei:normalizedImei||undefined,serial:normalizedSerial||undefined,status:isNew?'in_stock':(value?.status||status),note:note.trim()||undefined,createdAt:value?.createdAt||new Date().toISOString()};
   setError(''); onSave(unit); onClose();
 };
 return <div className="space-y-4"><Field label="Product"><select className="input" value={productId} onChange={e=>{setProductId(e.target.value);setError('')}} disabled={!isNew}>{products.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field><div className="grid grid-cols-1 gap-4 md:grid-cols-2"><Field label="IMEI"><input className="input" value={imei} onChange={e=>{setImei(e.target.value);setError('')}}/></Field><Field label="Serial"><input className="input" value={serial} onChange={e=>{setSerial(e.target.value);setError('')}}/></Field></div><Field label="Status"><select className="input" value={status} onChange={e=>setStatus(e.target.value as UnitStatus)} disabled={isNew||!!value}><option value="in_stock">In stock</option>{(Object.keys(STATUS_LABEL) as UnitStatus[]).filter(s=>s!=='in_stock').map(s=><option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select>{isNew?<div className="mt-1 text-xs text-slate-500">New units use an existing received stock unit when one is waiting for its IMEI/serial; otherwise stock increases by 1.</div>:<div className="mt-1 text-xs text-slate-500">Unit status is changed automatically by sales, returns, repairs and stock workflows.</div>}</Field><Field label="Note"><textarea className="input min-h-24" value={note} onChange={e=>setNote(e.target.value)}/></Field>{error&&<p role="alert" className="text-sm font-medium text-rose-600">{error}</p>}<div className="flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={submit}>Save</button></div></div>;
}
