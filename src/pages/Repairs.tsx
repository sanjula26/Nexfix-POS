import { useMemo, useState } from 'react';
import {
  Wrench, Plus, Trash2, ChevronRight, Phone, Laptop, Monitor,
} from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, Modal, Field, PageHeading, EmptyState, SearchInput, Avatar } from '../components/ui';
import { fmtDate, fmtRs, uid } from '../lib/utils';
import type { RepairJob, RepairStatus, RepairPart } from '../lib/types';

const PIPELINE: RepairStatus[] = ['received', 'diagnosed', 'waiting_parts', 'in_repair', 'ready', 'delivered'];

const STATUS_LABEL: Record<RepairStatus, string> = {
  received: 'Received',
  diagnosed: 'Diagnosed',
  waiting_parts: 'Waiting parts',
  in_repair: 'In repair',
  ready: 'Ready',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

const TONE: Record<string, string> = {
  received: 'sky',
  diagnosed: 'violet',
  waiting_parts: 'amber',
  in_repair: 'blue',
  ready: 'emerald',
  delivered: 'slate',
  cancelled: 'rose',
};

const emptyJob = (): RepairJob => ({
  id: uid(),
  jobNo: 'JOB-TEMP',
  customerName: '',
  deviceType: 'Phone',
  deviceBrand: '',
  deviceModel: '',
  fault: '',
  parts: [],
  laborCost: 0,
  status: 'received',
  receivedAt: new Date().toISOString(),
  by: '',
  warrantyDays: 30,
  advancePaid: 0,
});

export default function Repairs() {
  const { state, saveRepair, updateRepairStatus, deleteRepair, user, can } = usePOS();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<string>('active');
  const [editing, setEditing] = useState<RepairJob | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [partName, setPartName] = useState('');
  const [partCost, setPartCost] = useState(0);

  const jobs = state.repairs || [];

  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    return jobs.filter(j => {
      if (filter === 'active' && (j.status === 'delivered' || j.status === 'cancelled')) return false;
      if (filter !== 'all' && filter !== 'active' && j.status !== filter) return false;
      if (!query) return true;
      return (
        j.jobNo.toLowerCase().includes(query) ||
        j.customerName.toLowerCase().includes(query) ||
        j.deviceModel.toLowerCase().includes(query) ||
        j.deviceBrand.toLowerCase().includes(query) ||
        (j.imei || '').toLowerCase().includes(query) ||
        (j.serial || '').toLowerCase().includes(query) ||
        j.fault.toLowerCase().includes(query)
      );
    });
  }, [jobs, q, filter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    PIPELINE.forEach(s => { c[s] = jobs.filter(j => j.status === s).length; });
    return c;
  }, [jobs]);

  const openNew = () => {
    setEditing({
      ...emptyJob(),
      by: user?.name || 'Staff',
      warrantyDays: state.settings.repairWarrantyDays ?? 30,
    });
    setIsNew(true);
    setPartName('');
    setPartCost(0);
  };

  const addPart = () => {
    if (!editing || !partName.trim() || !Number.isFinite(partCost) || partCost < 0) return;
    const part: RepairPart = { name: partName.trim(), qty: 1, cost: partCost };
    setEditing({ ...editing, parts: [...editing.parts, part] });
    setPartName('');
    setPartCost(0);
  };

  const save = () => {
    if (!editing || !editing.customerName.trim() || !editing.deviceModel.trim() || !editing.fault.trim()) return;
    const financialValues = [editing.laborCost, editing.advancePaid || 0, editing.warrantyDays || 0];
    if (
      !financialValues.every(Number.isFinite) ||
      editing.laborCost < 0 ||
      (editing.advancePaid || 0) < 0 ||
      (editing.warrantyDays || 0) < 0 ||
      editing.parts.some(p => !Number.isFinite(p.cost) || p.cost < 0 || !Number.isFinite(p.qty) || p.qty <= 0)
    ) return;
    saveRepair({
      ...editing,
      customerName: editing.customerName.trim(),
      deviceBrand: editing.deviceBrand.trim(),
      deviceModel: editing.deviceModel.trim(),
      fault: editing.fault.trim(),
      diagnosis: editing.diagnosis?.trim() || undefined,
      imei: editing.imei?.trim() || undefined,
      serial: editing.serial?.trim() || undefined,
      customerPhone: editing.customerPhone?.trim() || undefined,
    });
    setEditing(null);
  };

  const totalFor = (j: RepairJob) => j.laborCost + j.parts.reduce((s, p) => s + p.cost * p.qty, 0);

  return (
    <div>
      <PageHeading
        chip="Service" chipTone="emerald"
        title="Repairs & Service Jobs"
        sub={`${jobs.filter(j => j.status !== 'delivered' && j.status !== 'cancelled').length} open jobs · phones, laptops & electronics`}
        actions={<button className="btn btn-primary" onClick={openNew}><Plus size={15} /> New job card</button>}
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-4">
        {PIPELINE.map(s => (
          <button key={s} type="button" onClick={() => setFilter(s)} className={`card p-3 text-left transition ${filter === s ? 'ring-2 ring-violet-500/50' : ''}`}>
            <div className="text-[10px] font-bold uppercase tracking-wider text-faint">{STATUS_LABEL[s]}</div>
            <div className="text-xl font-extrabold text-ink num mt-0.5">{counts[s] || 0}</div>
          </button>
        ))}
      </div>

      <div className="card overflow-hidden">
        <div className="p-4 border-b border-line flex flex-wrap gap-3 items-center">
          <SearchInput value={q} onChange={setQ} placeholder="Search job, customer, IMEI, model…" className="flex-1 min-w-[220px]" />
          <select className="input w-44" value={filter} onChange={e => setFilter(e.target.value)}>
            <option value="active">Active jobs</option><option value="all">All jobs</option>
            {PIPELINE.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        {rows.length === 0 ? <EmptyState icon={<Wrench size={26} />} title="No repair jobs" sub="Create a job card when a device is received" /> : (
          <div className="divide-y divide-line">
            {rows.map(j => (
              <div key={j.id} className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-3 hover:bg-raised/30">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-violet-500/10 text-violet-500 flex items-center justify-center shrink-0">{j.deviceType === 'Laptop' ? <Laptop size={18} /> : j.deviceType === 'Desktop' ? <Monitor size={18} /> : <Phone size={18} />}</div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><span className="font-bold text-ink">{j.jobNo}</span><Badge tone={(TONE[j.status] as any) || 'slate'}>{STATUS_LABEL[j.status]}</Badge></div>
                    <div className="text-[13px] text-ink mt-0.5 truncate">{j.deviceBrand} {j.deviceModel}<span className="text-faint"> · {j.customerName}</span></div>
                    <div className="text-[12px] text-faint mt-0.5 truncate">{j.fault}</div>
                    <div className="text-[11px] text-faint mt-1">Received {fmtDate(j.receivedAt)}{j.promisedAt ? ` · promised ${fmtDate(j.promisedAt)}` : ''}{j.imei ? ` · IMEI ${j.imei}` : ''}{j.serial ? ` · S/N ${j.serial}` : ''}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 sm:gap-3 shrink-0">
                  <div className="text-right mr-1"><div className="font-bold text-ink num text-[14px]">{fmtRs(totalFor(j), false)}</div><div className="text-[10px] text-faint">parts + labor</div></div>
                  {j.status !== 'delivered' && j.status !== 'cancelled' && <select className="input !py-1.5 !text-[12px] w-36" value={j.status} onChange={e => updateRepairStatus(j.id, e.target.value as RepairStatus)}>{PIPELINE.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}<option value="cancelled">Cancelled</option></select>}
                  <button className="icon-btn !w-8 !h-8" onClick={() => { setEditing({ ...j }); setIsNew(false); }}><ChevronRight size={16} /></button>
                  {can('act:deleteRecords') && <button className="icon-btn !w-8 !h-8 hover:!text-rose-500" onClick={() => deleteRepair(j.id)}><Trash2 size={14} /></button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={isNew ? 'New repair job' : editing?.jobNo || 'Job'} sub={editing ? `${editing.deviceBrand} ${editing.deviceModel}` : ''}>
        {editing && (
          <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Customer name"><input className="input" value={editing.customerName} onChange={e => setEditing({ ...editing, customerName: e.target.value })} list="cust-list" /><datalist id="cust-list">{state.customers.map(c => <option key={c.id} value={c.name} />)}</datalist></Field>
              <Field label="Phone"><input className="input" value={editing.customerPhone || ''} onChange={e => setEditing({ ...editing, customerPhone: e.target.value })} /></Field>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Type"><select className="input" value={editing.deviceType} onChange={e => setEditing({ ...editing, deviceType: e.target.value })}>{['Phone', 'Laptop', 'Desktop', 'Tablet', 'Other'].map(t => <option key={t}>{t}</option>)}</select></Field>
              <Field label="Brand"><input className="input" value={editing.deviceBrand} onChange={e => setEditing({ ...editing, deviceBrand: e.target.value })} list="brand-list" /><datalist id="brand-list">{(state.settings.brands || []).map(b => <option key={b} value={b} />)}</datalist></Field>
              <Field label="Model"><input className="input" value={editing.deviceModel} onChange={e => setEditing({ ...editing, deviceModel: e.target.value })} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3"><Field label="IMEI"><input className="input num" value={editing.imei || ''} onChange={e => setEditing({ ...editing, imei: e.target.value })} /></Field><Field label="Serial"><input className="input num" value={editing.serial || ''} onChange={e => setEditing({ ...editing, serial: e.target.value })} /></Field></div>
            <Field label="Fault reported"><textarea className="input min-h-[64px]" value={editing.fault} onChange={e => setEditing({ ...editing, fault: e.target.value })} /></Field>
            <Field label="Diagnosis"><textarea className="input min-h-[56px]" value={editing.diagnosis || ''} onChange={e => setEditing({ ...editing, diagnosis: e.target.value })} /></Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Labor (Rs)"><input className="input num" type="number" min="0" step="0.01" value={editing.laborCost} onChange={e => setEditing({ ...editing, laborCost: Number(e.target.value) || 0 })} /></Field>
              <Field label="Advance paid"><input className="input num" type="number" min="0" step="0.01" value={editing.advancePaid || 0} onChange={e => setEditing({ ...editing, advancePaid: Number(e.target.value) || 0 })} /></Field>
              <Field label="Warranty days"><input className="input num" type="number" min="0" step="1" value={editing.warrantyDays || 0} onChange={e => setEditing({ ...editing, warrantyDays: Number(e.target.value) || 0 })} /></Field>
            </div>
            <Field label="Promised date"><input className="input" type="date" value={editing.promisedAt?.slice(0, 10) || ''} onChange={e => setEditing({ ...editing, promisedAt: e.target.value || undefined })} /></Field>
            <div className="rounded-xl border border-line p-3">
              <div className="text-[12px] font-bold text-ink mb-2">Parts used</div>
              {editing.parts.map((p, i) => <div key={i} className="flex items-center justify-between text-[13px] py-1 border-b border-line last:border-0"><span>{p.name} ×{p.qty}</span><span className="num font-semibold">{fmtRs(p.cost * p.qty, false)}</span></div>)}
              <div className="flex gap-2 mt-2"><input className="input flex-1" placeholder="Part name" value={partName} onChange={e => setPartName(e.target.value)} /><input className="input w-24 num" type="number" min="0" step="0.01" placeholder="Cost" value={partCost || ''} onChange={e => setPartCost(Number(e.target.value) || 0)} /><button type="button" className="btn btn-soft" onClick={addPart}>Add</button></div>
            </div>
            <div className="flex items-center justify-between text-sm font-bold text-ink px-1"><span>Estimated total</span><span className="num">{fmtRs(totalFor(editing))}</span></div>
            {!isNew && <Field label="Status"><select className="input" value={editing.status} onChange={e => setEditing({ ...editing, status: e.target.value as RepairStatus })}>{[...PIPELINE, 'cancelled' as RepairStatus].map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></Field>}
            <div className="flex gap-2.5 pt-1"><button className="btn btn-primary flex-1" onClick={save}>{isNew ? 'Create job card' : 'Save changes'}</button><button className="btn btn-soft" onClick={() => setEditing(null)}>Cancel</button></div>
          </div>
        )}
      </Modal>
    </div>
  );
}
