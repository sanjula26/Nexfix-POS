import { useMemo, useState } from 'react';
import { Shield, Plus } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, Modal, Field, PageHeading, EmptyState, SearchInput } from '../components/ui';
import { fmtDate, uid } from '../lib/utils';
import type { WarrantyClaim, ClaimStatus } from '../lib/types';

const STATUS_TONE: Record<ClaimStatus, 'slate' | 'blue' | 'emerald' | 'rose' | 'amber' | 'violet'> = {
  open: 'amber', approved: 'blue', rejected: 'rose', replaced: 'violet', repaired: 'emerald', closed: 'slate',
};

function loadClaims(): WarrantyClaim[] {
  try {
    const raw = localStorage.getItem('nexfix_pos_v2');
    if (!raw) return [];
    return (JSON.parse(raw).warrantyClaims as WarrantyClaim[]) || [];
  } catch { return []; }
}

function persistClaims(list: WarrantyClaim[], countersPatch?: Record<string, number>) {
  try {
    const raw = localStorage.getItem('nexfix_pos_v2');
    if (!raw) return;
    const data = JSON.parse(raw);
    data.warrantyClaims = list;
    if (countersPatch) data.counters = { ...data.counters, ...countersPatch };
    localStorage.setItem('nexfix_pos_v2', JSON.stringify(data));
  } catch { /* ignore */ }
}

export default function WarrantyClaims() {
  const { state, user, logAudit } = usePOS();
  const [q, setQ] = useState('');
  const [claims, setClaims] = useState<WarrantyClaim[]>(() => loadClaims());
  const [editing, setEditing] = useState<WarrantyClaim | null>(null);
  const [isNew, setIsNew] = useState(false);

  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    return claims.filter(c => !query || c.claimNo.toLowerCase().includes(query) || c.productName.toLowerCase().includes(query) ||
      (c.customerName || '').toLowerCase().includes(query) || (c.imeiOrSerial || '').toLowerCase().includes(query));
  }, [claims, q]);

  const openNew = () => {
    setEditing({ id: uid(), claimNo: 'CL-TEMP', productName: '', issueDescription: '', status: 'open', createdAt: new Date().toISOString(), by: user?.name || 'Staff' });
    setIsNew(true);
  };

  const save = () => {
    if (!editing || !editing.productName.trim() || !editing.issueDescription.trim()) return;
    const seq = ((state.counters as { claim?: number }).claim || claims.length || 0) + 1;
    const claimNo = isNew ? `CL-${String(seq).padStart(4, '0')}` : editing.claimNo;
    const saved: WarrantyClaim = {
      ...editing,
      claimNo,
      productName: editing.productName.trim(),
      issueDescription: editing.issueDescription.trim(),
      customerName: editing.customerName?.trim() || undefined,
      imeiOrSerial: editing.imeiOrSerial?.trim() || undefined,
      resolutionNotes: editing.resolutionNotes?.trim() || undefined,
      closedAt: editing.status === 'closed' ? (editing.closedAt || new Date().toISOString()) : undefined,
    };
    const next = isNew ? [saved, ...claims] : claims.map(x => x.id === saved.id ? saved : x);
    setClaims(next);
    persistClaims(next, isNew ? { claim: seq } : undefined);
    logAudit(isNew ? 'CREATE' : 'UPDATE', 'WarrantyClaim', `${saved.claimNo} · ${saved.productName}`);
    setEditing(null);
    setIsNew(false);
  };

  return (
    <div className="space-y-4">
      <PageHeading chip="Service" title="Warranty Claims" sub="Track claims linked to sold IMEI / Serial units"
        actions={<button type="button" onClick={openNew} className="btn btn-primary"><Plus size={16} /> New Claim</button>} />
      <SearchInput value={q} onChange={setQ} placeholder="Search claim, product, IMEI…" />
      {rows.length === 0 ? <EmptyState icon={<Shield size={28} />} title="No warranty claims" sub="Register a claim when a customer returns a unit under warranty." /> : (
        <div className="card overflow-hidden"><table className="w-full text-sm"><thead className="bg-raised/60 text-left text-[11px] uppercase tracking-wider text-sub"><tr>
          <th className="px-4 py-3">Claim #</th><th className="px-4 py-3">Product</th><th className="px-4 py-3">IMEI / Serial</th><th className="px-4 py-3">Customer</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Date</th>
        </tr></thead><tbody>{rows.map(r => <tr key={r.id} className="border-t border-line hover:bg-raised/40 cursor-pointer" onClick={() => { setEditing({ ...r }); setIsNew(false); }}>
          <td className="px-4 py-3 font-semibold">{r.claimNo}</td><td className="px-4 py-3">{r.productName}</td><td className="px-4 py-3 font-mono text-xs">{r.imeiOrSerial || '—'}</td><td className="px-4 py-3">{r.customerName || '—'}</td><td className="px-4 py-3"><Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge></td><td className="px-4 py-3 text-sub">{fmtDate(r.createdAt)}</td>
        </tr>)}</tbody></table></div>
      )}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={isNew ? 'New Warranty Claim' : editing?.claimNo || 'Claim'}>
        {editing && <div className="space-y-3">
          <Field label="Product name"><input className="input" value={editing.productName} onChange={e => setEditing({ ...editing, productName: e.target.value })} /></Field>
          <Field label="IMEI / Serial"><input className="input" value={editing.imeiOrSerial || ''} onChange={e => setEditing({ ...editing, imeiOrSerial: e.target.value })} /></Field>
          <Field label="Customer name"><input className="input" value={editing.customerName || ''} onChange={e => setEditing({ ...editing, customerName: e.target.value })} /></Field>
          <Field label="Issue description"><textarea className="input min-h-[80px]" value={editing.issueDescription} onChange={e => setEditing({ ...editing, issueDescription: e.target.value })} /></Field>
          {!isNew && <Field label="Status"><select className="input" value={editing.status} onChange={e => setEditing({ ...editing, status: e.target.value as ClaimStatus })}>{(Object.keys(STATUS_TONE) as ClaimStatus[]).map(s => <option key={s} value={s}>{s}</option>)}</select></Field>}
          <Field label="Resolution notes"><textarea className="input min-h-[60px]" value={editing.resolutionNotes || ''} onChange={e => setEditing({ ...editing, resolutionNotes: e.target.value })} /></Field>
          <div className="flex justify-end gap-2 pt-2"><button type="button" className="btn btn-soft" onClick={() => setEditing(null)}>Cancel</button><button type="button" className="btn btn-primary" onClick={save}>Save</button></div>
        </div>}
      </Modal>
    </div>
  );
}
