import { useMemo, useState } from 'react';
import { Shield, Plus } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, Modal, Field, PageHeading, EmptyState, SearchInput } from '../components/ui';
import { fmtDate, uid } from '../lib/utils';
import type { WarrantyClaim, ClaimStatus } from '../lib/types';

const STATUS_TONE: Record<ClaimStatus, string> = {
  open: 'amber',
  approved: 'sky',
  rejected: 'rose',
  replaced: 'violet',
  repaired: 'emerald',
  closed: 'slate',
};

export default function WarrantyClaims() {
  const { state, user, logAudit } = usePOS();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<WarrantyClaim | null>(null);
  const [isNew, setIsNew] = useState(false);

  const claims: WarrantyClaim[] = (state as { warrantyClaims?: WarrantyClaim[] }).warrantyClaims || [];

  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    return claims.filter(c => {
      if (!query) return true;
      return (
        c.claimNo.toLowerCase().includes(query) ||
        c.productName.toLowerCase().includes(query) ||
        (c.customerName || '').toLowerCase().includes(query) ||
        (c.imeiOrSerial || '').toLowerCase().includes(query)
      );
    });
  }, [claims, q]);

  const openNew = () => {
    setEditing({
      id: uid(),
      claimNo: 'CL-TEMP',
      productName: '',
      issueDescription: '',
      status: 'open',
      createdAt: new Date().toISOString(),
      by: user?.name || 'Staff',
    });
    setIsNew(true);
  };

  const save = () => {
    if (!editing || !editing.productName.trim() || !editing.issueDescription.trim()) return;
    const raw = localStorage.getItem('nexfix_pos_v2');
    if (raw) {
      try {
        const data = JSON.parse(raw);
        const list: WarrantyClaim[] = data.warrantyClaims || [];
        const seq = (data.counters?.claim || 0) + 1;
        const claimNo = `CL-${String(seq).padStart(4, '0')}`;
        const saved: WarrantyClaim = {
          ...editing,
          claimNo: isNew ? claimNo : editing.claimNo,
          productName: editing.productName.trim(),
          issueDescription: editing.issueDescription.trim(),
        };
        data.warrantyClaims = isNew
          ? [saved, ...list]
          : list.map((x: WarrantyClaim) => (x.id === saved.id ? saved : x));
        data.counters = { ...data.counters, claim: isNew ? seq : data.counters?.claim || seq };
        localStorage.setItem('nexfix_pos_v2', JSON.stringify(data));
        logAudit?.(isNew ? 'CREATE' : 'UPDATE', 'WarrantyClaim', `${saved.claimNo} · ${saved.productName}`);
        window.location.reload();
      } catch { /* ignore */ }
    }
    setEditing(null);
    setIsNew(false);
  };

  return (
    <div className="space-y-4">
      <PageHeading
        title="Warranty Claims"
        sub="Track warranty claims linked to sold IMEI / Serial units"
        actions={
          <button onClick={openNew} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700">
            <Plus size={16} /> New Claim
          </button>
        }
      />

      <SearchInput value={q} onChange={setQ} placeholder="Search claim, product, IMEI…" />

      {rows.length === 0 ? (
        <EmptyState
          icon={<Shield size={32} />}
          title="No warranty claims"
          sub="When a customer returns a unit under warranty, register the claim here."
        />
      ) : (
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3">Claim #</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">IMEI / Serial</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Date</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr
                  key={r.id}
                  className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer"
                  onClick={() => { setEditing(r); setIsNew(false); }}
                >
                  <td className="px-4 py-3 font-medium">{r.claimNo}</td>
                  <td className="px-4 py-3">{r.productName}</td>
                  <td className="px-4 py-3 font-mono text-xs">{r.imeiOrSerial || '—'}</td>
                  <td className="px-4 py-3">{r.customerName || '—'}</td>
                  <td className="px-4 py-3"><Badge tone={STATUS_TONE[r.status] as 'slate'}>{r.status}</Badge></td>
                  <td className="px-4 py-3 text-slate-500">{fmtDate(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <Modal title={isNew ? 'New Warranty Claim' : editing.claimNo} onClose={() => setEditing(null)}>
          <div className="space-y-3">
            <Field label="Product name">
              <input
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
                value={editing.productName}
                onChange={e => setEditing({ ...editing, productName: e.target.value })}
              />
            </Field>
            <Field label="IMEI / Serial">
              <input
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
                value={editing.imeiOrSerial || ''}
                onChange={e => setEditing({ ...editing, imeiOrSerial: e.target.value })}
              />
            </Field>
            <Field label="Customer name">
              <input
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
                value={editing.customerName || ''}
                onChange={e => setEditing({ ...editing, customerName: e.target.value })}
              />
            </Field>
            <Field label="Issue description">
              <textarea
                rows={3}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
                value={editing.issueDescription}
                onChange={e => setEditing({ ...editing, issueDescription: e.target.value })}
              />
            </Field>
            {!isNew && (
              <Field label="Status">
                <select
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
                  value={editing.status}
                  onChange={e => setEditing({ ...editing, status: e.target.value as ClaimStatus })}
                >
                  {Object.keys(STATUS_TONE).map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Resolution notes">
              <textarea
                rows={2}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
                value={editing.resolutionNotes || ''}
                onChange={e => setEditing({ ...editing, resolutionNotes: e.target.value })}
              />
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setEditing(null)} className="px-4 py-2 rounded-lg border text-sm">Cancel</button>
              <button onClick={save} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm">Save</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
