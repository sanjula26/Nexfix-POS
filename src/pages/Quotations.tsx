import { useMemo, useState } from 'react';
import { FileText, Plus, Trash2 } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, Modal, Field, PageHeading, EmptyState, SearchInput } from '../components/ui';
import { fmtDate, fmtRs, uid } from '../lib/utils';
import type { Quotation, QuotationItem, QuoteStatus } from '../lib/types';

const STATUS_TONE: Record<QuoteStatus, string> = {
  draft: 'slate',
  sent: 'sky',
  accepted: 'emerald',
  rejected: 'rose',
  expired: 'amber',
  converted: 'violet',
};

export default function Quotations() {
  const { state, user, logAudit } = usePOS() as ReturnType<typeof usePOS> & {
    // extended via local state until full store methods
  };
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Quotation | null>(null);
  const [isNew, setIsNew] = useState(false);

  // Local persistence via state mutation pattern — store will pick up on next full integration
  const quotes: Quotation[] = (state as { quotations?: Quotation[] }).quotations || [];

  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    return quotes.filter(x => {
      if (!query) return true;
      return (
        x.quoteNo.toLowerCase().includes(query) ||
        x.customerName.toLowerCase().includes(query) ||
        (x.customerPhone || '').includes(query)
      );
    });
  }, [quotes, q]);

  const openNew = () => {
    setEditing({
      id: uid(),
      quoteNo: `Q-TEMP`,
      customerName: '',
      customerPhone: '',
      status: 'draft',
      items: [],
      subtotal: 0,
      discount: 0,
      tax: 0,
      total: 0,
      createdAt: new Date().toISOString(),
      by: user?.name || 'Staff',
    });
    setIsNew(true);
  };

  const addItem = () => {
    if (!editing) return;
    const item: QuotationItem = { name: '', qty: 1, price: 0 };
    setEditing({ ...editing, items: [...editing.items, item] });
  };

  const updateItem = (idx: number, patch: Partial<QuotationItem>) => {
    if (!editing) return;
    const items = editing.items.map((it, i) => (i === idx ? { ...it, ...patch } : it));
    const subtotal = items.reduce((s, it) => s + it.price * it.qty - (it.discount || 0), 0);
    const total = Math.max(0, subtotal - editing.discount + editing.tax);
    setEditing({ ...editing, items, subtotal, total });
  };

  const removeItem = (idx: number) => {
    if (!editing) return;
    const items = editing.items.filter((_, i) => i !== idx);
    const subtotal = items.reduce((s, it) => s + it.price * it.qty - (it.discount || 0), 0);
    setEditing({ ...editing, items, subtotal, total: Math.max(0, subtotal - editing.discount + editing.tax) });
  };

  const save = () => {
    if (!editing || !editing.customerName.trim()) return;
    // Persist through localStorage bridge until store methods are wired
    const raw = localStorage.getItem('nexfix_pos_v2');
    if (raw) {
      try {
        const data = JSON.parse(raw);
        const list: Quotation[] = data.quotations || [];
        const seq = (data.counters?.quote || 0) + 1;
        const quoteNo = `QT-${String(seq).padStart(4, '0')}`;
        const saved: Quotation = {
          ...editing,
          quoteNo: isNew ? quoteNo : editing.quoteNo,
          customerName: editing.customerName.trim(),
        };
        data.quotations = isNew
          ? [saved, ...list]
          : list.map((x: Quotation) => (x.id === saved.id ? saved : x));
        data.counters = { ...data.counters, quote: isNew ? seq : data.counters?.quote || seq };
        localStorage.setItem('nexfix_pos_v2', JSON.stringify(data));
        logAudit?.(isNew ? 'CREATE' : 'UPDATE', 'Quotation', `${saved.quoteNo} · ${saved.customerName}`);
        window.location.reload();
      } catch { /* ignore */ }
    }
    setEditing(null);
    setIsNew(false);
  };

  return (
    <div className="space-y-4">
      <PageHeading
        title="Quotations"
        sub="Estimates for customers — convert to sale when accepted"
        actions={
          <button onClick={openNew} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700">
            <Plus size={16} /> New Quote
          </button>
        }
      />

      <SearchInput value={q} onChange={setQ} placeholder="Search quote no, customer…" />

      {rows.length === 0 ? (
        <EmptyState icon={<FileText size={32} />} title="No quotations yet" sub="Create an estimate for a customer before converting to a sale." />
      ) : (
        <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3">Quote #</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Total</th>
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
                  <td className="px-4 py-3 font-medium">{r.quoteNo}</td>
                  <td className="px-4 py-3">{r.customerName}</td>
                  <td className="px-4 py-3">{fmtRs(r.total)}</td>
                  <td className="px-4 py-3"><Badge tone={STATUS_TONE[r.status] as 'slate'}>{r.status}</Badge></td>
                  <td className="px-4 py-3 text-slate-500">{fmtDate(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <Modal title={isNew ? 'New Quotation' : editing.quoteNo} onClose={() => setEditing(null)} wide>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Customer name">
                <input
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
                  value={editing.customerName}
                  onChange={e => setEditing({ ...editing, customerName: e.target.value })}
                />
              </Field>
              <Field label="Phone">
                <input
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
                  value={editing.customerPhone || ''}
                  onChange={e => setEditing({ ...editing, customerPhone: e.target.value })}
                />
              </Field>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Line items</span>
                <button type="button" onClick={addItem} className="text-sm text-blue-600">+ Add line</button>
              </div>
              {editing.items.map((it, idx) => (
                <div key={idx} className="flex gap-2 items-center">
                  <input
                    placeholder="Item name"
                    className="flex-1 px-2 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent text-sm"
                    value={it.name}
                    onChange={e => updateItem(idx, { name: e.target.value })}
                  />
                  <input
                    type="number"
                    className="w-16 px-2 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent text-sm"
                    value={it.qty}
                    onChange={e => updateItem(idx, { qty: Number(e.target.value) || 0 })}
                  />
                  <input
                    type="number"
                    className="w-28 px-2 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-transparent text-sm"
                    value={it.price}
                    onChange={e => updateItem(idx, { price: Number(e.target.value) || 0 })}
                  />
                  <button type="button" onClick={() => removeItem(idx)} className="text-red-500 p-1">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>

            <div className="flex justify-between items-center pt-2 border-t border-slate-200 dark:border-slate-700">
              <span className="font-semibold">Total: {fmtRs(editing.total)}</span>
              <div className="flex gap-2">
                <button onClick={() => setEditing(null)} className="px-4 py-2 rounded-lg border text-sm">Cancel</button>
                <button onClick={save} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm">Save</button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
