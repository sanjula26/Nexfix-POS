import { useMemo, useState } from 'react';
import {
  Plus, Pencil, Trash2, Phone, Mail, MapPin, History, Users, UserPlus, CreditCard, BadgeDollarSign,
} from 'lucide-react';
import { usePOS } from '../lib/store';
import { SearchInput, Badge, Modal, Field, EmptyState, PageHeading } from '../components/ui';
import { fmtRs, fmtDate, timeAgo, uid, salePaymentLabel } from '../lib/utils';
import type { Customer } from '../lib/types';

export default function Customers() {
  const { state, saveCustomer, deleteCustomer, can } = usePOS();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Customer | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [deleting, setDeleting] = useState<Customer | null>(null);
  const [historyOf, setHistoryOf] = useState<Customer | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return state.customers.filter(c =>
      !q || c.name.toLowerCase().includes(q) || c.phone.replace(/\s/g, '').includes(q.replace(/\s/g, '')) ||
      (c.nic || '').includes(q) || (c.email || '').toLowerCase().includes(q)
    );
  }, [state.customers, search]);

  const credited = state.customers.filter(c => c.creditBalance > 0);

  const save = () => {
    if (!editing || !editing.name.trim() || !editing.phone.trim()) return;
    saveCustomer(editing);
    setEditing(null);
  };

  const purchaseRows = historyOf
    ? state.sales.filter(s => s.customerId === historyOf.id).sort((a, b) => +new Date(b.date) - +new Date(a.date))
    : [];

  const accountLedger = useMemo(() => {
    if (!historyOf) return [] as Array<{ id: string; date: string; billNo: string; type: 'charge' | 'refund'; amount: number; balance: number }>;

    const movements = state.sales
      .filter(s => s.customerId === historyOf.id && (s.status === 'completed' || s.status === 'refunded'))
      .map(s => {
        const creditAmount = Math.max(0, Math.min(s.total, s.total - s.amountPaid));
        const isRefund = s.status === 'refunded';
        return {
          id: `${s.id}-${isRefund ? 'refund' : 'charge'}`,
          date: s.date,
          billNo: s.billNo,
          type: isRefund ? 'refund' as const : 'charge' as const,
          amount: creditAmount,
        };
      })
      .filter(x => Number.isFinite(x.amount) && x.amount > 0)
      .sort((a, b) => +new Date(a.date) - +new Date(b.date));

    let balance = 0;
    return movements.map(m => {
      balance += m.type === 'charge' ? m.amount : -m.amount;
      return { ...m, balance };
    }).reverse();
  }, [historyOf, state.sales]);

  return (
    <div>
      <PageHeading
        chip="CRM" chipTone="blue"
        title="Customers"
        sub={`${state.customers.length} registered customers${credited.length ? ` · ${credited.length} with credit balance` : ''}`}
        actions={
          <button
            className="btn btn-primary"
            onClick={() => {
              setEditing({ id: uid(), name: '', phone: '', email: '', nic: '', address: '', createdAt: new Date().toISOString(), creditBalance: 0, loyaltyPoints: 0 });
              setIsNew(true);
            }}
          >
            <Plus size={15} /> Add Customer
          </button>
        }
      />

      {credited.length > 0 && (
        <div className="card mb-5 p-4 flex flex-wrap items-center gap-3 bg-gradient-to-r from-amber-500/[0.06] to-transparent">
          <Badge tone="amber"><BadgeDollarSign size={11} /> CREDIT OUTSTANDING</Badge>
          <div className="flex flex-wrap gap-2">
            {credited.map(c => (
              <span key={c.id} className="text-xs font-semibold text-sub bg-raised border border-line rounded-full px-3 py-1.5 num">
                {c.name}: <b className="text-amber-600 dark:text-amber-400">{fmtRs(c.creditBalance)}</b>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="p-4 border-b border-line">
          <SearchInput value={search} onChange={setSearch} placeholder="Search by name, phone, NIC..." className="max-w-md" />
        </div>
        {rows.length === 0 ? (
          <EmptyState icon={<Users size={26} />} title="No customers found" sub="Add your first customer to speed up billing" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px]">
              <thead>
                <tr>
                  <th className="th">Customer</th><th className="th">Contact</th><th className="th">Address</th>
                  <th className="th">Credit</th><th className="th">Limit</th><th className="th">Since</th><th className="th !text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(c => (
                  <tr key={c.id} className="hover:bg-raised/40 transition-colors">
                    <td className="td">
                      <div className="font-semibold text-ink">{c.name}</div>
                      {c.nic && <div className="text-[11px] text-violet-500 font-medium mt-0.5">NIC: {c.nic}</div>}
                    </td>
                    <td className="td">
                      <div className="flex items-center gap-1.5 text-[13px] text-sub"><Phone size={12} className="text-faint" />{c.phone}</div>
                      {c.email && <div className="flex items-center gap-1.5 text-[12px] text-sky-500 mt-1"><Mail size={12} />{c.email}</div>}
                    </td>
                    <td className="td text-[13px] text-sub">
                      {c.address ? <span className="flex items-center gap-1.5"><MapPin size={12} className="text-faint shrink-0" />{c.address}</span> : '—'}
                    </td>
                    <td className="td">
                      {c.creditBalance > 0
                        ? <Badge tone="amber" className="num">{fmtRs(c.creditBalance)}</Badge>
                        : <span className="text-xs text-faint">—</span>}
                    </td>
                    <td className="td num text-xs text-sub">{c.creditLimit && c.creditLimit > 0 ? fmtRs(c.creditLimit) : 'Unlimited'}</td>
                    <td className="td text-[13px] text-sub" title={fmtDate(c.createdAt)}>{timeAgo(c.createdAt)}</td>
                    <td className="td">
                      <div className="flex items-center justify-end gap-1">
                        <button className="icon-btn !w-8 !h-8" title="Purchase history" onClick={() => setHistoryOf(c)}><History size={14} /></button>
                        <button className="icon-btn !w-8 !h-8" title="Edit" onClick={() => { setEditing({ ...c }); setIsNew(false); }}><Pencil size={14} /></button>
                        {(can('act:deleteRecords')) && (
                          <button className="icon-btn !w-8 !h-8 hover:!bg-rose-500/10 hover:!text-rose-500" title="Delete" onClick={() => setDeleting(c)}>
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

      {/* add / edit */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={isNew ? 'Add customer' : 'Edit customer'} sub={isNew ? 'Register a walk-in regular' : editing?.name}>
        {editing && (
          <div className="space-y-4">
            <Field label="Full name">
              <input className="input" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="Customer name" />
            </Field>
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label="Phone">
                <input className="input num" value={editing.phone} onChange={e => setEditing({ ...editing, phone: e.target.value })} placeholder="+94 77 000 0000" />
              </Field>
              <Field label="NIC">
                <span className="relative block">
                  <CreditCard size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
                  <input className="input pl-9 num" value={editing.nic || ''} onChange={e => setEditing({ ...editing, nic: e.target.value })} placeholder="Optional" />
                </span>
              </Field>
            </div>
            <Field label="Email">
              <input className="input" value={editing.email || ''} onChange={e => setEditing({ ...editing, email: e.target.value })} placeholder="Optional" />
            </Field>
            <Field label="Address">
              <input className="input" value={editing.address || ''} onChange={e => setEditing({ ...editing, address: e.target.value })} placeholder="Street, City" />
            </Field>
            <Field label="Credit limit (Rs.)" hint="0 = unlimited. Credit sales are blocked when the limit would be exceeded.">
              <input className="input num" type="number" min={0} step={0.01} value={editing.creditLimit ?? ''} onChange={e => { const n = Math.max(0, Number(e.target.value) || 0); setEditing({ ...editing, creditLimit: n > 0 ? n : undefined }); }} placeholder="0 (unlimited)" />
            </Field>
            <Field label="Loyalty points" hint="Earned automatically: 1 pt per Rs. 1,000 · worth Rs. 20 each">
              <input
                className="input num"
                value={editing.loyaltyPoints || ''}
                onChange={e => setEditing({ ...editing, loyaltyPoints: Math.round(Number(e.target.value.replace(/\D/g, '')) || 0) })}
                placeholder="0" inputMode="numeric"
              />
            </Field>
            <div className="flex gap-2.5 pt-1">
              <button className="btn btn-primary flex-1" onClick={save} disabled={!editing.name.trim() || !editing.phone.trim()}>
                <UserPlus size={15} /> {isNew ? 'Add customer' : 'Save changes'}
              </button>
              <button className="btn btn-soft" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        )}
      </Modal>

      {/* delete */}
      <Modal open={!!deleting} onClose={() => setDeleting(null)} title="Delete customer?" sub={deleting?.name}>
        <p className="text-sm text-sub">Remove <b className="text-ink">{deleting?.name}</b> from the customer book? Their past bills will remain.</p>
        <div className="flex gap-2.5 mt-5">
          <button className="btn btn-danger-soft flex-1" onClick={() => { if (deleting) deleteCustomer(deleting.id); setDeleting(null); }}>
            <Trash2 size={15} /> Delete
          </button>
          <button className="btn btn-soft flex-1" onClick={() => setDeleting(null)}>Keep customer</button>
        </div>
      </Modal>

      {/* history + account ledger */}
      <Modal open={!!historyOf} onClose={() => setHistoryOf(null)} title="Purchase history" sub={historyOf?.name} wide>
        {historyOf && (
          <div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
              {[
                ['Bills', purchaseRows.length],
                ['Total spent', fmtRs(purchaseRows.reduce((a, s) => a + s.total, 0))],
                ['Credit balance', fmtRs(historyOf.creditBalance)],
                ['Loyalty points', `${historyOf.loyaltyPoints || 0} pts`],
              ].map(([l, v]) => (
                <div key={l as string} className="rounded-xl bg-raised border border-line p-3.5 text-center">
                  <div className="text-[10px] font-bold tracking-wider uppercase text-faint">{l}</div>
                  <div className="num text-base font-extrabold text-ink mt-1">{v}</div>
                </div>
              ))}
            </div>

            <div className="rounded-xl border border-line overflow-hidden mb-5">
              <div className="px-4 py-3 border-b border-line flex items-center justify-between">
                <div>
                  <div className="text-sm font-bold text-ink">Credit account ledger</div>
                  <div className="text-[11px] text-faint mt-0.5">Credit sales and refunds, oldest balance calculated forward</div>
                </div>
                <Badge tone={historyOf.creditBalance > 0 ? 'amber' : 'emerald'} className="num">
                  {fmtRs(historyOf.creditBalance)} outstanding
                </Badge>
              </div>
              {accountLedger.length === 0 ? (
                <div className="p-5 text-center text-xs text-faint">No credit movements recorded for this customer.</div>
              ) : (
                <div className="max-h-[32vh] overflow-y-auto">
                  <table className="w-full min-w-[560px]">
                    <thead>
                      <tr>
                        <th className="th">Date</th><th className="th">Reference</th><th className="th">Type</th>
                        <th className="th !text-right">Amount</th><th className="th !text-right">Running balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accountLedger.map(entry => (
                        <tr key={entry.id} className="hover:bg-raised/40">
                          <td className="td text-[12px] text-sub">{fmtDate(entry.date)}</td>
                          <td className="td font-semibold text-violet-500 text-[12px]">{entry.billNo}</td>
                          <td className="td">
                            <Badge tone={entry.type === 'charge' ? 'amber' : 'emerald'}>
                              {entry.type === 'charge' ? 'Credit charge' : 'Refund'}
                            </Badge>
                          </td>
                          <td className={`td !text-right num font-semibold ${entry.type === 'charge' ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                            {entry.type === 'charge' ? '+' : '-'}{fmtRs(entry.amount)}
                          </td>
                          <td className="td !text-right num font-bold text-ink">{fmtRs(entry.balance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {purchaseRows.length === 0 ? (
              <EmptyState icon={<History size={24} />} title="No purchases yet" />
            ) : (
              <div className="space-y-2 max-h-[46vh] overflow-y-auto pr-1">
                {purchaseRows.map(s => (
                  <div key={s.id} className="rounded-xl border border-line p-3.5">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-violet-500 text-[13px]">{s.billNo}</span>
                      <div className="flex items-center gap-2">
                        <Badge tone={s.payments && s.payments.length > 1 ? 'violet' : s.payment === 'cash' ? 'emerald' : s.payment === 'card' ? 'blue' : s.payment === 'credit' ? 'amber' : 'violet'}>{salePaymentLabel(s)}</Badge>
                        <span className="num font-bold text-ink text-[13px]">{fmtRs(s.total)}</span>
                      </div>
                    </div>
                    <div className="text-[11px] text-faint mt-1">{fmtDate(s.date)} · {s.items.map(i => `${i.name} ×${i.qty}`).join(', ')}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
