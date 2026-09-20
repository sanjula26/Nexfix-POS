import { useMemo, useState } from 'react';
import { Plus, Trash2, Wallet, TrendingDown, PieChart } from 'lucide-react';
import { usePOS } from '../lib/store';
import { SearchInput, Badge, Modal, Field, EmptyState, PageHeading } from '../components/ui';
import { fmtRs, fmtDateTime, periodRange, inRange } from '../lib/utils';

const CATS = ['Rent', 'Utilities', 'Salary', 'Transport', 'Supplies', 'Marketing', 'Maintenance', 'Other'];
const CAT_TONE: Record<string, 'violet' | 'emerald' | 'amber' | 'rose' | 'blue' | 'slate'> = {
  Rent: 'violet', Utilities: 'blue', Salary: 'emerald', Transport: 'amber',
  Supplies: 'slate', Marketing: 'rose', Maintenance: 'blue', Other: 'slate',
};

export default function Expenses() {
  const { state, addExpense, deleteExpense, can } = usePOS();
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('all');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ category: 'Rent', note: '', amount: '', periodStart: '', periodEnd: '' });
  const [deleting, setDeleting] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...state.expenses]
      .sort((a, b) => +new Date(b.date) - +new Date(a.date))
      .filter(e => (!q || e.note.toLowerCase().includes(q) || e.category.toLowerCase().includes(q)) && (cat === 'all' || e.category === cat));
  }, [state.expenses, search, cat]);

  const monthTotal = state.expenses.filter(e => inRange(e.date, periodRange('month'))).reduce((a, e) => a + e.amount, 0);
  const todayTotal = state.expenses.filter(e => inRange(e.date, periodRange('today'))).reduce((a, e) => a + e.amount, 0);
  const shownTotal = rows.reduce((a, e) => a + e.amount, 0);

  const byCat = useMemo(() => {
    const m = new Map<string, number>();
    state.expenses.forEach(e => m.set(e.category, (m.get(e.category) || 0) + e.amount));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [state.expenses]);
  const maxCat = Math.max(1, ...byCat.map(c => c[1]));

  const submit = () => {
    const amount = Number(form.amount.replace(/[^\d.]/g, '')) || 0;
    if (amount <= 0) return;
    addExpense({ category: form.category, note: form.note.trim() || form.category, amount });
    setCreating(false);
    setForm({ category: 'Rent', note: '', amount: '', periodStart: '', periodEnd: '' });
  };

  return (
    <div>
      <PageHeading
        chip="Finance" chipTone="amber"
        title="Expenses"
        sub={`This month: ${fmtRs(monthTotal)} · Today: ${fmtRs(todayTotal)}`}
        actions={<button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={15} /> Add Expense</button>}
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5 items-start">
        <div className="card overflow-hidden">
          <div className="p-4 border-b border-line flex flex-wrap gap-3">
            <SearchInput value={search} onChange={setSearch} placeholder="Search expenses..." className="flex-1 min-w-[200px]" />
            <select className="input w-40" value={cat} onChange={e => setCat(e.target.value)}>
              <option value="all">All categories</option>
              {CATS.map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
          {rows.length === 0 ? (
            <EmptyState icon={<Wallet size={26} />} title="No expenses recorded" sub="Track shop spending to see true profit" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px]">
                <thead>
                  <tr>
                    <th className="th">Date</th><th className="th">Category</th><th className="th">Note</th>
                    <th className="th">By</th><th className="th !text-right">Amount</th><th className="th !text-right"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(e => (
                    <tr key={e.id} className="hover:bg-raised/40 transition-colors">
                      <td className="td text-[13px] text-sub whitespace-nowrap">{fmtDateTime(e.date)}</td>
                      <td className="td"><Badge tone={CAT_TONE[e.category] || 'slate'}>{e.category.toUpperCase()}</Badge></td>
                      <td className="td text-[13px] font-medium">{e.note}{(e.periodStart || e.periodEnd) && <div className="text-[10px] text-faint mt-0.5">Period: {e.periodStart || "—"} → {e.periodEnd || "—"}</div>}</td>
                      <td className="td text-[13px] text-sub">{e.by}</td>
                      <td className="td num font-bold text-right text-rose-500">{fmtRs(e.amount)}</td>
                      <td className="td text-right">
                        {can('act:deleteRecords') && (
                          <button className="icon-btn !w-8 !h-8 hover:!bg-rose-500/10 hover:!text-rose-500" onClick={() => setDeleting(e.id)}>
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td className="td font-bold text-sub" colSpan={4}>Total (filtered)</td>
                    <td className="td num font-extrabold text-right text-rose-500">{fmtRs(shownTotal)}</td>
                    <td className="td"></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        {/* category breakdown */}
        <div className="card p-5">
          <h3 className="font-bold text-ink flex items-center gap-2 mb-4">
            <PieChart size={15} className="text-violet-500" /> By Category
          </h3>
          <div className="space-y-3">
            {byCat.map(([c, v]) => (
              <div key={c}>
                <div className="flex justify-between text-[12.5px] mb-1">
                  <span className="font-semibold text-sub flex items-center gap-1.5"><TrendingDown size={12} className="text-faint" />{c}</span>
                  <span className="num font-bold text-ink">{fmtRs(v, false)}</span>
                </div>
                <div className="h-2 rounded-full bg-raised overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-violet-500 to-indigo-500"
                    style={{ width: `${(v / maxCat) * 100}%` }}
                  />
                </div>
              </div>
            ))}
            {byCat.length === 0 && <p className="text-sm text-faint text-center py-6">Nothing yet</p>}
          </div>
        </div>
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title="Add expense" sub="Recorded against your login">
        <div className="space-y-4">
          <Field label="Category">
            <select className="input" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
              {CATS.map(c => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Note">
            <input className="input" value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} placeholder="e.g. Shop rent - monthly" />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Period start (optional)">
              <input type="date" className="input" value={form.periodStart} onChange={e => setForm({ ...form, periodStart: e.target.value })} />
            </Field>
            <Field label="Period end (optional)">
              <input type="date" className="input" value={form.periodEnd} min={form.periodStart || undefined} onChange={e => setForm({ ...form, periodEnd: e.target.value })} />
            </Field>
          </div>
          <Field label="Amount (Rs.)">
            <input className="input num" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value.replace(/[^\d.]/g, '') })} placeholder="0.00" inputMode="decimal" />
          </Field>
          <div className="flex gap-2.5 pt-1">
            <button className="btn btn-primary flex-1" onClick={submit} disabled={!form.amount}>
              <Plus size={15} /> Add expense
            </button>
            <button className="btn btn-soft" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </div>
      </Modal>

      <Modal open={!!deleting} onClose={() => setDeleting(null)} title="Delete expense?">
        <p className="text-sm text-sub">This expense record will be removed and deducted from totals.</p>
        <div className="flex gap-2.5 mt-5">
          <button className="btn btn-danger-soft flex-1" onClick={() => { if (deleting) deleteExpense(deleting); setDeleting(null); }}>
            <Trash2 size={15} /> Delete
          </button>
          <button className="btn btn-soft flex-1" onClick={() => setDeleting(null)}>Cancel</button>
        </div>
      </Modal>
    </div>
  );
}
