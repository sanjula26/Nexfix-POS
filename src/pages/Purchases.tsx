import { useMemo, useState } from 'react';
import { Plus, CheckCircle2, Trash2, ClipboardList, PackageCheck, Clock4, X } from 'lucide-react';
import { usePOS } from '../lib/store';
import { SearchInput, Badge, Modal, Field, EmptyState, PageHeading } from '../components/ui';
import { fmtRs, fmtDate } from '../lib/utils';

interface Row { productId: string; qty: number; cost: number }

export default function Purchases() {
  const { state, savePurchase, receivePurchase, deletePurchase, can } = usePOS();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [supplierId, setSupplierId] = useState('');
  const [rows, setRows] = useState<Row[]>([{ productId: '', qty: 1, cost: 0 }]);
  const [deleting, setDeleting] = useState<string | null>(null);

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...state.purchases]
      .filter(p => !q || p.poNo.toLowerCase().includes(q) || p.supplierName.toLowerCase().includes(q))
      .sort((a, b) => +new Date(b.date) - +new Date(a.date));
  }, [state.purchases, search]);

  const totalValue = state.purchases.reduce((a, p) => a + p.total, 0);
  const poTotal = rows.reduce((a, r) => a + r.qty * r.cost, 0);

  const setRow = (i: number, patch: Partial<Row>) => {
    const next = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    if (patch.productId) {
      const p = state.products.find(x => x.id === patch.productId);
      if (p) next[i].cost = p.cost;
    }
    setRows(next);
  };

  const submit = () => {
    const sup = state.suppliers.find(s => s.id === supplierId);
    const items = rows.filter(r => r.productId && r.qty > 0).map(r => ({
      productId: r.productId, name: state.products.find(p => p.id === r.productId)?.name || '', qty: r.qty, cost: r.cost,
    }));
    if (!sup || items.length === 0) return;
    savePurchase({ supplierId: sup.id, supplierName: sup.name, items, total: items.reduce((a, i) => a + i.qty * i.cost, 0) });
    setCreating(false);
    setSupplierId('');
    setRows([{ productId: '', qty: 1, cost: 0 }]);
  };

  return (
    <div>
      <PageHeading
        chip="Procurement" chipTone="blue"
        title="Purchases"
        sub={`${state.purchases.length} purchase orders · Total value: ${fmtRs(totalValue)}`}
        actions={<button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={15} /> New Purchase</button>}
      />

      <div className="card overflow-hidden">
        <div className="p-4 border-b border-line">
          <SearchInput value={search} onChange={setSearch} placeholder="Search by PO # or supplier..." className="max-w-md" />
        </div>
        {list.length === 0 ? (
          <EmptyState icon={<ClipboardList size={26} />} title="No purchase orders" sub="Create a PO to restock your shelves" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px]">
              <thead>
                <tr>
                  <th className="th">PO #</th><th className="th">Date</th><th className="th">Supplier</th>
                  <th className="th">Items</th><th className="th">Status</th><th className="th !text-right">Total</th>
                  <th className="th !text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.map(p => (
                  <tr key={p.id} className="hover:bg-raised/40 transition-colors">
                    <td className="td font-bold text-violet-500">{p.poNo}</td>
                    <td className="td text-[13px] text-sub">{fmtDate(p.date)}</td>
                    <td className="td font-medium text-ink">{p.supplierName}</td>
                    <td className="td text-[12px] text-sub max-w-[260px]">
                      {p.items.map(i => `${i.name} ×${i.qty}`).join(', ')}
                    </td>
                    <td className="td">
                      <Badge tone={p.status === 'received' ? 'emerald' : 'amber'}>
                        {p.status === 'received' ? <PackageCheck size={11} /> : <Clock4 size={11} />}
                        {p.status.toUpperCase()}
                      </Badge>
                    </td>
                    <td className="td num font-bold text-right">{fmtRs(p.total)}</td>
                    <td className="td">
                      <div className="flex items-center justify-end gap-1.5">
                        {p.status === 'pending' && (
                          <button className="btn btn-outline-emerald !py-1.5 !px-3 !text-xs" onClick={() => receivePurchase(p.id)}>
                            <CheckCircle2 size={13} /> Receive
                          </button>
                        )}
                        {can('act:deleteRecords') && p.status === 'pending' && (
                          <button className="icon-btn !w-8 !h-8 hover:!bg-rose-500/10 hover:!text-rose-500" onClick={() => setDeleting(p.id)}>
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* new PO modal */}
      <Modal open={creating} onClose={() => setCreating(false)} title="New purchase order" sub="Stock is added when the PO is marked received" wide>
        <div className="space-y-4">
          <Field label="Supplier">
            <select className="input" value={supplierId} onChange={e => setSupplierId(e.target.value)}>
              <option value="">Select supplier...</option>
              {state.suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>

          <div>
            <span className="block text-[11px] font-bold tracking-wider uppercase text-sub mb-1.5">Items</span>
            <div className="space-y-2">
              {rows.map((r, i) => (
                <div key={i} className="grid grid-cols-[1fr_80px_110px_36px] gap-2 items-center">
                  <select className="input" value={r.productId} onChange={e => setRow(i, { productId: e.target.value })}>
                    <option value="">Select product...</option>
                    {state.products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <input className="input num" value={r.qty || ''} placeholder="Qty" onChange={e => setRow(i, { qty: Math.round(Number(e.target.value.replace(/\D/g, '')) || 0) })} />
                  <input className="input num" value={r.cost || ''} placeholder="Cost" onChange={e => setRow(i, { cost: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 })} />
                  <button
                    className="icon-btn !w-9 !h-9 hover:!bg-rose-500/10 hover:!text-rose-500"
                    onClick={() => setRows(rs => rs.filter((_, idx) => idx !== i))}
                    disabled={rows.length === 1}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
            <button className="btn btn-soft !text-xs mt-2.5" onClick={() => setRows(rs => [...rs, { productId: '', qty: 1, cost: 0 }])}>
              <Plus size={13} /> Add line
            </button>
          </div>

          <div className="flex justify-between items-center rounded-xl bg-violet-500/[0.07] border border-violet-500/15 px-4 py-3">
            <span className="text-sm font-semibold text-sub">PO Total</span>
            <span className="num text-lg font-extrabold text-violet-500">{fmtRs(poTotal)}</span>
          </div>

          <div className="flex gap-2.5">
            <button className="btn btn-primary flex-1" onClick={submit} disabled={!supplierId || !rows.some(r => r.productId && r.qty > 0)}>
              <Plus size={15} /> Create purchase order
            </button>
            <button className="btn btn-soft" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </div>
      </Modal>

      <Modal open={!!deleting} onClose={() => setDeleting(null)} title="Delete purchase order?">
        <p className="text-sm text-sub">Only pending POs can be deleted. This won't affect current stock.</p>
        <div className="flex gap-2.5 mt-5">
          <button className="btn btn-danger-soft flex-1" onClick={() => { if (deleting) deletePurchase(deleting); setDeleting(null); }}>
            <Trash2 size={15} /> Delete
          </button>
          <button className="btn btn-soft flex-1" onClick={() => setDeleting(null)}>Cancel</button>
        </div>
      </Modal>
    </div>
  );
}
