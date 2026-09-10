import { useState } from 'react';
import { Banknote, CreditCard, Landmark, Smartphone, Plus, Trash2, WalletCards } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, EmptyState, Field, Modal, PageHeading, SearchInput } from '../components/ui';
import { fmtDate, fmtRs } from '../lib/utils';
import { getSupplierOutstanding, type SupplierPaymentMethod } from '../lib/supplierPayments';

const METHODS: Array<{ value: SupplierPaymentMethod; label: string; icon: typeof Banknote }> = [
  { value: 'cash', label: 'Cash', icon: Banknote },
  { value: 'card', label: 'Card', icon: CreditCard },
  { value: 'bank', label: 'Bank', icon: Landmark },
  { value: 'mobile', label: 'Mobile', icon: Smartphone },
];

export default function SupplierPayments() {
  const { state, saveSupplierPayment, deleteSupplierPayment, can } = usePOS();
  const [supplierId, setSupplierId] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<SupplierPaymentMethod>('cash');
  const [purchaseId, setPurchaseId] = useState('');
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState('');

  const supplier = state.suppliers.find(s => s.id === supplierId);
  const payments = state.supplierPayments || [];
  const outstanding = supplier ? getSupplierOutstanding(supplier.id, state.purchases, payments, state.purchaseReturns || []) : 0;
  const supplierPurchases = supplier
    ? state.purchases.filter(p => p.supplierId === supplier.id && p.status === 'received').sort((a, b) => +new Date(b.date) - +new Date(a.date))
    : [];

  const q = search.trim().toLowerCase();
  const rows = [...payments]
    .filter(p => {
      const s = state.suppliers.find(x => x.id === p.supplierId);
      return !q || (s?.name || '').toLowerCase().includes(q) || (p.note || '').toLowerCase().includes(q) || p.method.includes(q);
    })
    .sort((a, b) => +new Date(b.date) - +new Date(a.date));

  const totalOutstanding = state.suppliers.reduce((sum, s) => sum + getSupplierOutstanding(s.id, state.purchases, payments, state.purchaseReturns || []), 0);
  const totalPaid = payments.reduce((sum, p) => sum + (Number.isFinite(p.amount) ? p.amount : 0), 0);

  const save = () => {
    setError('');
    const value = Number(amount);
    if (!supplier) return setError('Select a supplier.');
    if (!Number.isFinite(value) || value <= 0) return setError('Enter a valid payment amount.');
    if (value > outstanding) return setError(`Payment exceeds the supplier outstanding balance of ${fmtRs(outstanding)}.`);
    const payment = saveSupplierPayment({ supplierId: supplier.id, amount: Math.round(value * 100) / 100, method, purchaseId: purchaseId || undefined, note: note.trim() || undefined });
    if (!payment) return setError('Payment could not be saved.');
    setAmount(''); setPurchaseId(''); setNote('');
  };

  return (
    <div>
      <PageHeading chip="Payables" chipTone="violet" title="Supplier Payments" sub={`${payments.length} payments recorded · ${fmtRs(totalOutstanding)} outstanding`} actions={<button className="btn btn-primary" onClick={() => { setSupplierId(''); setAmount(''); setError(''); }}><Plus size={15} /> New Payment</button>} />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
        <div className="card p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-faint">Supplier outstanding</div><div className="num text-xl font-extrabold text-amber-600 mt-1">{fmtRs(totalOutstanding)}</div></div>
        <div className="card p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-faint">Payments recorded</div><div className="num text-xl font-extrabold text-emerald-600 mt-1">{fmtRs(totalPaid)}</div></div>
        <div className="card p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-faint">Suppliers</div><div className="num text-xl font-extrabold text-ink mt-1">{state.suppliers.length}</div></div>
      </div>
      <div className="card p-4 mb-5">
        <div className="grid md:grid-cols-2 gap-4">
          <Field label="Supplier"><select className="input" value={supplierId} onChange={e => { setSupplierId(e.target.value); setPurchaseId(''); setError(''); }}><option value="">Select supplier...</option>{state.suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="Amount (Rs.)" hint={supplier ? `Outstanding: ${fmtRs(outstanding)}` : undefined}><input className="input num" type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" /></Field>
          <Field label="Payment method"><div className="grid grid-cols-2 sm:grid-cols-4 gap-2">{METHODS.map(m => { const Icon = m.icon; return <button key={m.value} type="button" className={`btn !px-2 ${method === m.value ? 'btn-primary' : 'btn-soft'}`} onClick={() => setMethod(m.value)}><Icon size={13} /> {m.label}</button>; })}</div></Field>
          <Field label="Against purchase (optional)"><select className="input" value={purchaseId} onChange={e => setPurchaseId(e.target.value)} disabled={!supplier}><option value="">General supplier payment</option>{supplierPurchases.map(p => <option key={p.id} value={p.id}>{p.poNo} · {fmtRs(p.total)}</option>)}</select></Field>
          <Field label="Note"><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Optional reference or note" /></Field>
        </div>
        {error && <p className="text-sm text-rose-500 font-medium mt-3">{error}</p>}
        <div className="flex justify-end mt-4"><button className="btn btn-primary" onClick={save}><WalletCards size={15} /> Record payment</button></div>
      </div>
      <div className="card overflow-hidden">
        <div className="p-4 border-b border-line"><SearchInput value={search} onChange={setSearch} placeholder="Search supplier, method or note..." className="max-w-md" /></div>
        {rows.length === 0 ? <EmptyState icon={<Banknote size={26} />} title="No supplier payments" sub="Record a payment after receiving a purchase." /> : <div className="overflow-x-auto"><table className="w-full min-w-[760px]"><thead><tr><th className="th">Date</th><th className="th">Supplier</th><th className="th">Reference</th><th className="th">Method</th><th className="th">Note</th><th className="th !text-right">Amount</th><th className="th !text-right">Actions</th></tr></thead><tbody>{rows.map(p => { const s = state.suppliers.find(x => x.id === p.supplierId); return <tr key={p.id} className="hover:bg-raised/40"><td className="td text-xs text-sub">{fmtDate(p.date)}</td><td className="td font-semibold">{s?.name || 'Unknown supplier'}</td><td className="td text-xs text-sub">{p.purchaseId ? (state.purchases.find(x => x.id === p.purchaseId)?.poNo || p.purchaseId) : 'General'}</td><td className="td"><Badge tone="slate">{p.method.toUpperCase()}</Badge></td><td className="td text-xs text-sub">{p.note || '—'}</td><td className="td num font-bold text-right">{fmtRs(p.amount)}</td><td className="td text-right">{can('act:deleteRecords') && <button className="icon-btn !w-8 !h-8 hover:!bg-rose-500/10 hover:!text-rose-500" onClick={() => setConfirmDelete(p.id)}><Trash2 size={14} /></button>}</td></tr>; })}</tbody></table></div>}
      </div>
      <Modal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete supplier payment?"><p className="text-sm text-sub">This removes the payment from the supplier account ledger. The original purchase remains unchanged.</p><div className="flex gap-2.5 mt-5"><button className="btn btn-danger-soft flex-1" onClick={() => { if (confirmDelete) deleteSupplierPayment(confirmDelete); setConfirmDelete(null); }}>Delete payment</button><button className="btn btn-soft flex-1" onClick={() => setConfirmDelete(null)}>Cancel</button></div></Modal>
    </div>
  );
}
