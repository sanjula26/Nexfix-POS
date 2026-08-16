import { useMemo, useState } from 'react';
import { Cpu, Plus, Trash2, Smartphone } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, Modal, Field, PageHeading, EmptyState, SearchInput } from '../components/ui';
import { fmtDate, uid } from '../lib/utils';
import type { InventoryUnit, UnitStatus } from '../lib/types';

const STATUS_TONE: Record<UnitStatus, 'emerald'|'slate'|'amber'|'violet'|'rose'> = { in_stock:'emerald', sold:'slate', returned:'amber', reserved:'violet', defective:'rose', in_repair:'amber' };
const STATUS_LABEL: Record<UnitStatus,string> = { in_stock:'In stock', sold:'Sold', returned:'Returned', reserved:'Reserved', defective:'Defective', in_repair:'In repair' };

export default function Units() {
  const { state, saveUnit, deleteUnit, can } = usePOS();
  const [q,setQ]=useState(''); const [status,setStatus]=useState<string>('all');
  const [editing,setEditing]=useState<InventoryUnit|null>(null); const [isNew,setIsNew]=useState(false);
  const units=state.units||[]; const products=state.products;
  const rows=useMemo(()=>{ const query=q.trim().toLowerCase(); return units.filter(u=>{ if(status!=='all'&&u.status!==status)return false; if(!query)return true; const p=products.find(x=>x.id===u.productId); return `${p?.name||''} ${u.imei||''} ${u.serial||''}`.toLowerCase().includes(query); }); },[units,products,q,status]);
  return <div className="space-y-6">
    <PageHeading title="Units / IMEI & Serial" sub="Track individual sellable units and warranty status." actions={can('inventory.manage')?<button className="btn-primary" onClick={()=>{setEditing(null);setIsNew(true)}}><Plus size={16}/> Add unit</button>:undefined}/>
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3"><SearchInput value={q} onChange={setQ} placeholder="Search IMEI, serial or product"/><select className="input" value={status} onChange={e=>setStatus(e.target.value)}><option value="all">All statuses</option>{(Object.keys(STATUS_LABEL) as UnitStatus[]).map(s=><option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select><div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">Showing {rows.length} of {units.length} units</div></div>
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">{rows.length===0?<EmptyState icon={<Smartphone size={28}/>} title="No units found" sub="Add a unit or change the search filter."/>:<div className="divide-y divide-slate-100">{rows.map(u=>{const p=products.find(x=>x.id===u.productId);return <div key={u.id} className="flex items-center justify-between gap-4 px-4 py-3"><div><div className="font-medium text-slate-900">{p?.name||'Unknown product'}</div><div className="text-xs text-slate-500">{u.imei||u.serial||'No IMEI/serial'} · Added {fmtDate(u.createdAt)}</div></div><div className="flex items-center gap-3"><Badge tone={STATUS_TONE[u.status]}>{STATUS_LABEL[u.status]}</Badge>{can('inventory.manage')&&<button className="btn-ghost" onClick={()=>{setEditing(u);setIsNew(false)}} aria-label="Edit unit"><Cpu size={16}/></button>}{can('inventory.manage')&&<button className="btn-ghost text-rose-600" onClick={()=>deleteUnit(u.id)} aria-label="Delete unit"><Trash2 size={16}/></button>}</div></div>})}</div>}</div>
    {editing||isNew?<Modal open title={isNew?'Add inventory unit':'Edit inventory unit'} onClose={()=>{setEditing(null);setIsNew(false)}}><UnitEditor value={editing} products={products} onSave={saveUnit} onClose={()=>{setEditing(null);setIsNew(false)}}/></Modal>:null}
  </div>;
}

function UnitEditor({value,products,onSave,onClose}:{value:InventoryUnit|null;products:any[];onSave:(u:InventoryUnit)=>void;onClose:()=>void}){
 const [productId,setProductId]=useState(value?.productId||products[0]?.id||''); const [imei,setImei]=useState(value?.imei||''); const [serial,setSerial]=useState(value?.serial||''); const [status,setStatus]=useState<UnitStatus>(value?.status||'in_stock'); const [note,setNote]=useState(value?.note||'');
 const submit=()=>{if(!productId)return;onSave({id:value?.id||uid(),productId,imei:imei.trim()||undefined,serial:serial.trim()||undefined,status,note:note.trim()||undefined,createdAt:value?.createdAt||new Date().toISOString()});onClose()};
 return <div className="space-y-4"><Field label="Product"><select className="input" value={productId} onChange={e=>setProductId(e.target.value)}>{products.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field><div className="grid grid-cols-1 gap-4 md:grid-cols-2"><Field label="IMEI"><input className="input" value={imei} onChange={e=>setImei(e.target.value)}/></Field><Field label="Serial"><input className="input" value={serial} onChange={e=>setSerial(e.target.value)}/></Field></div><Field label="Status"><select className="input" value={status} onChange={e=>setStatus(e.target.value as UnitStatus)}>{(Object.keys(STATUS_LABEL) as UnitStatus[]).map(s=><option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></Field><Field label="Note"><textarea className="input min-h-24" value={note} onChange={e=>setNote(e.target.value)}/></Field><div className="flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={submit}>Save</button></div></div>;
}
