import { useMemo, useState } from 'react';
import { Cpu, Plus, Trash2, Smartphone, ClipboardList } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, Modal, Field, PageHeading, EmptyState, SearchInput } from '../components/ui';
import { fmtDate, uid } from '../lib/utils';
import type { InventoryUnit, UnitStatus } from '../lib/types';

const STATUS_TONE: Record<UnitStatus, 'emerald'|'slate'|'amber'|'violet'|'rose'> = { in_stock:'emerald', sold:'slate', returned:'amber', reserved:'violet', defective:'rose', in_repair:'amber' };
const STATUS_LABEL: Record<UnitStatus,string> = { in_stock:'In stock', sold:'Sold', returned:'Returned', reserved:'Reserved', defective:'Defective', in_repair:'In repair' };

export default function Units() {
  const { state, saveUnit, saveUnitsBulk, deleteUnit, saveProduct, can } = usePOS();
  const [q,setQ]=useState(''); const [status,setStatus]=useState<string>('all');
  const [editing,setEditing]=useState<InventoryUnit|null>(null); const [isNew,setIsNew]=useState(false);
  const units=state.units||[]; const products=state.products;
  const trackedProducts=useMemo(()=>products.filter(p=>p.trackImei||p.trackSerial),[products]);
  const [bulkOpen,setBulkOpen]=useState(false); const [bulkProductId,setBulkProductId]=useState(''); const [bulkText,setBulkText]=useState(''); const [bulkMsg,setBulkMsg]=useState(''); const [bulkErrors,setBulkErrors]=useState<string[]>([]);
  const openBulk=()=>{setBulkProductId(trackedProducts[0]?.id||'');setBulkText('');setBulkMsg('');setBulkErrors([]);setBulkOpen(true)};
  const rows=useMemo(()=>{ const query=q.trim().toLowerCase(); return units.filter(u=>{ if(status!=='all'&&u.status!==status)return false; if(!query)return true; const p=products.find(x=>x.id===u.productId); return `${p?.name||''} ${u.imei||''} ${u.serial||''}`.toLowerCase().includes(query); }); },[units,products,q,status]);
  return <div className="space-y-6">
    <PageHeading title="Units / IMEI & Serial" sub="Track individual sellable units and warranty status." actions={can('act:manageStock')&&trackedProducts.length>0?<div className="flex gap-2"><button className="btn-secondary" onClick={openBulk}><ClipboardList size={16}/> Bulk add</button><button className="btn-primary" onClick={()=>{setEditing(null);setIsNew(true)}}><Plus size={16}/> Add unit</button></div>:undefined}/>
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3"><SearchInput value={q} onChange={setQ} placeholder="Search IMEI, serial or product"/><select className="input" value={status} onChange={e=>setStatus(e.target.value)}><option value="all">All statuses</option>{(Object.keys(STATUS_LABEL) as UnitStatus[]).map(s=><option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select><div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">Showing {rows.length} of {units.length} units</div></div>
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">{rows.length===0?<EmptyState icon={<Smartphone size={28}/>} title="No units found" sub="Add a unit or change the search filter."/>:<div className="divide-y divide-slate-100">{rows.map(u=>{const p=products.find(x=>x.id===u.productId);return <div key={u.id} className="flex items-center justify-between gap-4 px-4 py-3"><div><div className="font-medium text-slate-900">{p?.name||'Unknown product'}</div><div className="text-xs text-slate-500">{u.imei||u.serial||'No IMEI/serial'} · Added {fmtDate(u.createdAt)}</div></div><div className="flex items-center gap-3"><Badge tone={STATUS_TONE[u.status]}>{STATUS_LABEL[u.status]}</Badge>{can('act:manageStock')&&<button className="btn-ghost" onClick={()=>{setEditing(u);setIsNew(false)}} aria-label="Edit unit"><Cpu size={16}/></button>}{can('act:manageStock')&&u.status==='in_stock'&&<button className="btn-ghost text-rose-600" onClick={()=>{if(p) saveProduct({...p,stock:Math.max(0,p.stock-1)});deleteUnit(u.id)}} aria-label="Delete unit"><Trash2 size={16}/></button>}</div></div>})}</div>}</div>
    <Modal open={bulkOpen} onClose={()=>setBulkOpen(false)} title="Bulk add IMEI / Serial" sub="Paste one identifier per line; use IMEI,SERIAL when both are tracked." wide>
      <BulkUnitEditor product={trackedProducts.find(p=>p.id===bulkProductId)} productId={bulkProductId} setProductId={setBulkProductId} products={trackedProducts} text={bulkText} setText={setBulkText} msg={bulkMsg} errors={bulkErrors} onResult={(result)=>{setBulkMsg(result.msg);setBulkErrors(result.errors)}} onClose={()=>setBulkOpen(false)} saveUnitsBulk={saveUnitsBulk}/>
    </Modal>
    {editing||isNew?<Modal open title={isNew?'Add inventory unit':'Edit inventory unit'} onClose={()=>{setEditing(null);setIsNew(false)}}><UnitEditor value={editing} products={isNew?trackedProducts:products} units={units} isNew={isNew} onSave={(unit)=>{const p=products.find(x=>x.id===unit.productId);if(!p)return;if(isNew){const placeholder=units.find(x=>x.productId===p.id&&x.status==='in_stock'&&!!x.purchaseId&&((p.trackImei&&!x.imei)||(p.trackSerial&&!x.serial)));if(placeholder){saveUnit({...unit,id:placeholder.id,purchaseId:placeholder.purchaseId,createdAt:placeholder.createdAt,cost:placeholder.cost,expiryDate:placeholder.expiryDate,note:unit.note||placeholder.note});}else{saveProduct({...p,stock:p.stock+1});saveUnit(unit);}}else{saveUnit(unit);}}} onClose={()=>{setEditing(null);setIsNew(false)}}/></Modal>:null}
  </div>;
}

function UnitEditor({value,products,units,isNew,onSave,onClose}:{value:InventoryUnit|null;products:any[];units:InventoryUnit[];isNew:boolean;onSave:(u:InventoryUnit)=>void;onClose:()=>void}){
 const [productId,setProductId]=useState(value?.productId||products[0]?.id||''); const [imei,setImei]=useState(value?.imei||''); const [serial,setSerial]=useState(value?.serial||''); const [status,setStatus]=useState<UnitStatus>(value?.status||'in_stock'); const [note,setNote]=useState(value?.note||''); const [error,setError]=useState('');
 const submit=()=>{
   const product=products.find(p=>p.id===productId);
   if(!product){setError('Select a product.');return;}
   const normalizedImei=imei.trim(); const normalizedSerial=serial.trim();
   if(!product.trackImei&&!product.trackSerial){setError('This product is not configured for IMEI/Serial tracking.');return;}
   if(product.trackImei&&!normalizedImei){setError('IMEI is required for this tracked product.');return;}
   if(product.trackSerial&&!normalizedSerial){setError('Serial number is required for this tracked product.');return;}
   const duplicate=units.some(x=>x.id!==(value?.id||'')&&x.status==='in_stock'&&((normalizedImei&&x.imei===normalizedImei)||(normalizedSerial&&x.serial===normalizedSerial)));
   if(duplicate){setError('That IMEI or serial number is already assigned to another in-stock unit.');return;}
   const unit:InventoryUnit={id:value?.id||uid(),productId:isNew?productId:(value?.productId||productId),imei:normalizedImei||undefined,serial:normalizedSerial||undefined,status:isNew?'in_stock':(value?.status||status),note:note.trim()||undefined,createdAt:value?.createdAt||new Date().toISOString()};
   setError(''); onSave(unit); onClose();
 };
 return <div className="space-y-4"><Field label="Product"><select className="input" value={productId} onChange={e=>{setProductId(e.target.value);setError('')}} disabled={!isNew}>{products.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field><div className="grid grid-cols-1 gap-4 md:grid-cols-2"><Field label="IMEI"><input className="input" value={imei} onChange={e=>{setImei(e.target.value);setError('')}}/></Field><Field label="Serial"><input className="input" value={serial} onChange={e=>{setSerial(e.target.value);setError('')}}/></Field></div><Field label="Status"><select className="input" value={status} onChange={e=>setStatus(e.target.value as UnitStatus)} disabled={isNew||!!value}><option value="in_stock">In stock</option>{(Object.keys(STATUS_LABEL) as UnitStatus[]).filter(s=>s!=='in_stock').map(s=><option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select>{isNew?<div className="mt-1 text-xs text-slate-500">New units use an existing received stock unit when one is waiting for its IMEI/serial; otherwise stock increases by 1.</div>:<div className="mt-1 text-xs text-slate-500">Unit status is changed automatically by sales, returns, repairs and stock workflows.</div>}</Field><Field label="Note"><textarea className="input min-h-24" value={note} onChange={e=>setNote(e.target.value)}/></Field>{error&&<p role="alert" className="text-sm font-medium text-rose-600">{error}</p>}<div className="flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={submit}>Save</button></div></div>;
}

function BulkUnitEditor({product,productId,setProductId,products,text,setText,msg,errors,onResult,onClose,saveUnitsBulk}:{product:any;productId:string;setProductId:(v:string)=>void;products:any[];text:string;setText:(v:string)=>void;msg:string;errors:string[];onResult:(r:{msg:string;errors:string[]})=>void;onClose:()=>void;saveUnitsBulk:(units:InventoryUnit[])=>{ok:boolean;added:number;errors:string[]}}){
 const submit=()=>{
   if(!product){onResult({msg:'Select a tracked product.',errors:[]});return;}
   const lines=text.split(/\r?\n/); const units:InventoryUnit[]=[]; const parseErrors:string[]=[];
   for(let i=0;i<lines.length;i++){
     const raw=lines[i].trim(); if(!raw) continue;
     const parts=raw.split(',').map(x=>x.trim());
     let imei='',serial='';
     if(product.trackImei&&product.trackSerial){
       if(parts.length!==2||!parts[0]||!parts[1]){parseErrors.push('Line '+(i+1)+': expected IMEI,SERIAL');continue;}
       imei=parts[0]; serial=parts[1];
     } else if(product.trackImei){
       if(parts.length!==1||!parts[0]){parseErrors.push('Line '+(i+1)+': expected one IMEI');continue;}
       imei=parts[0];
     } else {
       if(parts.length!==1||!parts[0]){parseErrors.push('Line '+(i+1)+': expected one serial');continue;}
       serial=parts[0];
     }
     units.push({id:uid(),productId,imei:imei||undefined,serial:serial||undefined,status:'in_stock',createdAt:new Date().toISOString()});
   }
   const result=saveUnitsBulk(units);
   const errors=[...parseErrors,...result.errors];
   onResult({msg:result.added+' unit(s) added'+(errors.length?' · '+errors.length+' error(s)':''),errors});
   if(result.added>0) setText('');
 };
 return <div className="space-y-4">
   <Field label="Product"><select className="input" value={productId} onChange={e=>setProductId(e.target.value)}>{products.map(p=><option key={p.id} value={p.id}>{p.name} · {p.trackImei&&p.trackSerial?'IMEI + Serial':p.trackImei?'IMEI':'Serial'}</option>)}</select></Field>
   <Field label={product?.trackImei&&product?.trackSerial?'IMEI,SERIAL per line':'One IMEI or serial per line'} hint={product?.trackImei&&product?.trackSerial?'Example: 356789012345678,ABC123':'Blank lines are ignored; duplicates are rejected.'}><textarea className="input min-h-[220px] font-mono text-sm" value={text} onChange={e=>setText(e.target.value)} placeholder={product?.trackImei&&product?.trackSerial?'356789012345678,ABC123\n356789012345679,ABC124':'356789012345678\n356789012345679'} /></Field>
   {msg&&<p className="text-sm font-semibold text-emerald-600">{msg}</p>}
   {errors.length>0&&<div className="max-h-40 overflow-auto rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700"><div className="font-bold mb-1">Errors</div>{errors.map((e,i)=><div key={i}>{e}</div>)}</div>}
   <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Close</button><button className="btn-primary" onClick={submit} disabled={!product||!text.trim()}>Add units</button></div>
 </div>;
}
