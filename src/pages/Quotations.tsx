import { useMemo, useState } from 'react';
import { FileText, Plus, Trash2, ShoppingCart } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, Modal, Field, PageHeading, EmptyState, SearchInput } from '../components/ui';
import { fmtDate, fmtRs, uid } from '../lib/utils';
import type { Quotation, QuotationItem, QuoteStatus } from '../lib/types';

const STATUS_TONE: Record<QuoteStatus, 'slate' | 'blue' | 'emerald' | 'rose' | 'amber' | 'violet'> = {
  draft: 'slate',
  sent: 'blue',
  accepted: 'emerald',
  rejected: 'rose',
  expired: 'amber',
  converted: 'violet',
};

function loadQuotes(): Quotation[] {
  try {
    const raw = localStorage.getItem('nexfix_pos_v2');
    if (!raw) return [];
    return (JSON.parse(raw).quotations as Quotation[]) || [];
  } catch {
    return [];
  }
}

function persistQuotes(list: Quotation[], countersPatch?: Record<string, number>) {
  try {
    const raw = localStorage.getItem('nexfix_pos_v2');
    if (!raw) return;
    const data = JSON.parse(raw);
    data.quotations = list;
    if (countersPatch) data.counters = { ...data.counters, ...countersPatch };
    localStorage.setItem('nexfix_pos_v2', JSON.stringify(data));
  } catch { /* ignore */ }
}

export default function Quotations() {
  const { user, logAudit, state } = usePOS();
  const [q, setQ] = useState('');
  const [quotes, setQuotes] = useState<Quotation[]>(() => loadQuotes());
  const [editing, setEditing] = useState<Quotation | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [msg, setMsg] = useState('');

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
      quoteNo: 'Q-TEMP',
      customerName: '',
      customerPhone: '',
      status: 'draft',
      items: [{ name: '', qty: 1, price: 0 }],
      subtotal: 0,
      discount: 0,
      tax: 0,
      total: 0,
      createdAt: new Date().toISOString(),
      by: user?.name || 'Staff',
    });
    setIsNew(true);
  };

  const recalc = (items: QuotationItem[], discount = 0, tax = 0) => {
    const subtotal = items.reduce((s, it) => s + it.price * it.qty - (it.discount || 0), 0);
    return { subtotal, total: Math.max(0, subtotal - discount + tax) };
  };

  const updateItem = (idx: number, patch: Partial<QuotationItem>) => {
    if (!editing) return;
    const items = editing.items.map((it, i) => (i === idx ? { ...it, ...patch } : it));
    const { subtotal, total } = recalc(items, editing.discount, editing.tax);
    setEditing({ ...editing, items, subtotal, total });
  };

  const save = () => {
    if (!editing || !editing.customerName.trim()) {
      setMsg('Customer name is required');
      return;
    }
    const seq = ((state.counters as { quote?: number }).quote || quotes.length || 0) + 1;
    const quoteNo = isNew ? `QT-${String(seq).padStart(4, '0')}` : editing.quoteNo;
    const saved: Quotation = {
      ...editing,
      quoteNo,
      customerName: editing.customerName.trim(),
    };
    const next = isNew ? [saved, ...quotes] : quotes.map(x => (x.id === saved.id ? saved : x));
    setQuotes(next);
    persistQuotes(next, isNew ? { quote: seq } : undefined);
    logAudit(isNew ? 'CREATE' : 'UPDATE', 'Quotation', `${saved.quoteNo} · ${saved.customerName}`);
    setEditing(null);
    setIsNew(false);
    setMsg('');
  };

  const convertToSale = (quote: Quotation) => {
    const lines = quote.items
      .filter(it => it.name.trim())
      .map(it => {
        const product = state.products.find(
          p => p.name.toLowerCase() === it.name.toLowerCase() || p.id === it.productId,
        );
        return {
          productId: product?.id || '',
          name: it.name,
          qty: it.qty,
          price: it.price,
        };
      });
    try {
      sessionStorage.setItem(
        'nexfix_quote_convert',
        JSON.stringify({
          quoteId: quote.id,
          quoteNo: quote.quoteNo,
          customerName: quote.customerName,
          customerPhone: quote.customerPhone,
          lines,
        }),
      );
    } catch { /* ignore */ }

    const next = quotes.map(x =>
      x.id === quote.id ? { ...x, status: 'converted' as const } : x,
    );
    setQuotes(next);
    persistQuotes(next);
    logAudit('CONVERT', 'Quotation', `${quote.quoteNo} → POS`);
    window.location.hash = '#/pos';
  };

  return (
    <div className="space-y-4">
      <PageHeading
        chip="Sales"
        title="Quotations"
        sub="Estimates for customers — convert to a sale when accepted"
        actions={
          <button type="button" onClick={openNew} className="btn btn-primary">
            <Plus size={16} /> New Quote
          </button>
        }
      />

      <SearchInput value={q} onChange={setQ} placeholder="Search quote no, customer…" />

      {rows.length === 0 ? (
        <EmptyState
          icon={<FileText size={28} />}
          title="No quotations yet"
          sub="Create an estimate before converting it to a sale."
        />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-raised/60 text-left text-[11px] uppercase tracking-wider text-sub">
              <tr>
                <th className="px-4 py-3">Quote #</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Total</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr
                  key={r.id}
                  className="border-t border-line hover:bg-raised/40 cursor-pointer"
                  onClick={() => { setEditing(r); setIsNew(false); }}
                >
                  <td className="px-4 py-3 font-semibold text-ink">{r.quoteNo}</td>
                  <td className="px-4 py-3">{r.customerName}</td>
                  <td className="px-4 py-3 num font-medium">{fmtRs(r.total)}</td>
                  <td className="px-4 py-3"><Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge></td>
                  <td className="px-4 py-3 text-sub">{fmtDate(r.createdAt)}</td>
                  <td className="px-4 py-3 text-right" onClick={e => e.stopPropagation()}>
                    {r.status !== 'converted' && r.status !== 'rejected' && (
                      <button
                        type="button"
                        className="btn btn-soft !py-1.5 !px-3 text-xs"
                        onClick={() => convertToSale(r)}
                      >
                        <ShoppingCart size={14} /> To Sale
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={!!editing}
        onClose={() => { setEditing(null); setMsg(''); }}
        title={isNew ? 'New Quotation' : editing?.quoteNo || 'Quote'}
        sub={editing?.customerName}
        wide
      >
        {editing && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Customer name">
                <input
                  className="input"
                  value={editing.customerName}
                  onChange={e => setEditing({ ...editing, customerName: e.target.value })}
                />
              </Field>
              <Field label="Phone">
                <input
                  className="input"
                  value={editing.customerPhone || ''}
                  onChange={e => setEditing({ ...editing, customerPhone: e.target.value })}
                />
              </Field>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-sub">Line items</span>
                <button
                  type="button"
                  className="text-sm text-violet-600 font-medium"
                  onClick={() =>
                    setEditing({
                      ...editing,
                      items: [...editing.items, { name: '', qty: 1, price: 0 }],
                    })
                  }
                >
                  + Add line
                </button>
              </div>
              {editing.items.map((it, idx) => (
                <div key={idx} className="flex flex-wrap gap-2 items-center">
                  <input
                    placeholder="Item name"
                    className="input flex-1 min-w-[140px]"
                    value={it.name}
                    onChange={e => updateItem(idx, { name: e.target.value })}
                  />
                  <input
                    type="number"
                    className="input w-20"
                    value={it.qty}
                    onChange={e => updateItem(idx, { qty: Number(e.target.value) || 0 })}
                  />
                  <input
                    type="number"
                    className="input w-28"
                    value={it.price}
                    onChange={e => updateItem(idx, { price: Number(e.target.value) || 0 })}
                  />
                  <button type="button" className="icon-btn text-rose-500" onClick={() => {
                    const items = editing.items.filter((_, i) => i !== idx);
                    const { subtotal, total } = recalc(items, editing.discount, editing.tax);
                    setEditing({ ...editing, items, subtotal, total });
                  }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap justify-between items-center gap-3 pt-3 border-t border-line">
              <span className="text-lg font-bold num">Total: {fmtRs(editing.total)}</span>
              <div className="flex gap-2">
                {!isNew && editing.status !== 'converted' && (
                  <button type="button" className="btn btn-soft" onClick={() => convertToSale(editing)}>
                    <ShoppingCart size={15} /> Convert to Sale
                  </button>
                )}
                <button type="button" className="btn btn-primary" onClick={save}>Save</button>
              </div>
            </div>
            {msg && <p className="text-sm text-rose-500">{msg}</p>}
          </div>
        )}
      </Modal>
    </div>
  );
}
