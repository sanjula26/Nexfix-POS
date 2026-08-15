import { useMemo, useState } from 'react';
import { Landmark, Banknote, Wallet, TrendingUp, Lock, Unlock, CheckCircle2, CalendarDays } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, Modal, Field, Avatar, PageHeading } from '../components/ui';
import { fmtRs, dkey, fmtNum, salePayments } from '../lib/utils';

export default function CashierBalances() {
  const { state, closeSession, user } = usePOS();
  const today = dkey(new Date());
  const [settling, setSettling] = useState<string | null>(null);
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');

  const cashiers = state.users.filter(u => u.role === 'cashier');

  const todaySales = useMemo(
    () => state.sales.filter(s => s.status !== 'refunded' && dkey(s.date) === today),
    [state.sales, today],
  );
  const todayExpenses = state.expenses.filter(e => dkey(e.date) === today).reduce((a, e) => a + e.amount, 0);

  const rowFor = (id: string) => {
    const mine = todaySales.filter(s => s.cashierId === id);
    const session = state.sessions.find(x => x.cashierId === id && x.date === today);
    const cash = mine.reduce((a, s) => a + salePayments(s).filter(l => l.method === 'cash').reduce((x, l) => x + l.amount, 0), 0);
    const other = mine.reduce((a, s) => a + salePayments(s).filter(l => l.method !== 'cash').reduce((x, l) => x + l.amount, 0), 0);
    const opening = session?.opening ?? state.settings.openingFloat;
    return { mine, session, cash, other, opening, expected: opening + cash };
  };

  const settle = () => {
    if (!settling) return;
    closeSession(settling, Number(counted) || 0, note.trim());
    setSettling(null); setCounted(''); setNote('');
  };

  return (
    <div>
      <PageHeading
        chip="Cash Control" chipTone="emerald"
        title="Cashier Balances"
        sub={`Drawer control for ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long' })}`}
      />

      {/* shop summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { icon: Banknote, label: "Today's revenue", value: fmtRs(todaySales.reduce((a, s) => a + s.total, 0)), tint: 'from-emerald-400 to-teal-500' },
          { icon: TrendingUp, label: "Today's profit", value: fmtRs(todaySales.reduce((a, s) => a + s.profit, 0)), tint: 'from-violet-500 to-purple-600' },
          { icon: Wallet, label: "Today's expenses", value: fmtRs(todayExpenses), tint: 'from-amber-400 to-orange-500' },
          { icon: Landmark, label: 'Cash in drawers', value: fmtRs(cashiers.reduce((a, c) => a + rowFor(c.id).expected, 0)), tint: 'from-sky-400 to-blue-600' },
        ].map(s => (
          <div key={s.label} className="card p-4 flex items-center gap-3.5">
            <span className={`w-10 h-10 rounded-xl bg-gradient-to-br ${s.tint} text-white flex items-center justify-center shadow-md`}>
              <s.icon size={17} />
            </span>
            <div className="min-w-0">
              <div className="text-[10.5px] font-bold tracking-wider uppercase text-faint">{s.label}</div>
              <div className="num text-lg font-extrabold text-ink truncate">{s.value}</div>
            </div>
          </div>
        ))}
      </div>

      {/* per-cashier */}
      <div className="space-y-5">
        {cashiers.map(c => {
          const r = rowFor(c.id);
          const closed = r.session?.closed;
          const variance = closed && r.session && r.session.closing !== undefined ? r.session.closing - r.expected : null;
          return (
            <div key={c.id} className="card overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-b border-line bg-raised/40">
                <div className="flex items-center gap-3">
                  <Avatar name={c.name} size={38} />
                  <div>
                    <div className="font-bold text-ink">{c.name}</div>
                    <div className="text-[11px] text-faint flex items-center gap-1"><CalendarDays size={11} /> Session: {today}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2.5">
                  {closed
                    ? <Badge tone="emerald"><Lock size={11} /> SETTLED</Badge>
                    : <Badge tone="amber"><Unlock size={11} /> OPEN DRAWER</Badge>}
                  {!closed && user?.role === 'admin' && (
                    <button className="btn btn-primary !py-2 !text-xs" onClick={() => { setSettling(c.id); setCounted(String(r.expected)); }}>
                      <CheckCircle2 size={14} /> Settle drawer
                    </button>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-5 divide-x divide-line">
                {[
                  ['Opening float', r.opening, 'text-ink'],
                  ['Bills today', r.mine.length, 'text-ink', true],
                  ['Cash sales', r.cash, 'text-emerald-500'],
                  ['Card / other sales', r.other, 'text-sky-500'],
                  ['Expected in drawer', r.expected, 'text-violet-500'],
                ].map(([l, v, c, plain]) => (
                  <div key={l as string} className="px-5 py-4">
                    <div className="text-[10px] font-bold tracking-wider uppercase text-faint">{l}</div>
                    <div className={`num text-[17px] font-extrabold mt-1 ${c}`}>{plain ? fmtNum(v as number) : fmtRs(v as number, false)}</div>
                  </div>
                ))}
              </div>
              {closed && (
                <div className="px-6 py-3.5 border-t border-line bg-emerald-500/[0.05] flex flex-wrap items-center gap-4 text-[13px]">
                  <span className="text-sub">Counted: <b className="num text-ink">{fmtRs(r.session?.closing || 0)}</b></span>
                  <span className="text-sub">
                    Variance:{' '}
                    <b className={`num ${variance && variance !== 0 ? 'text-rose-500' : 'text-emerald-500'}`}>
                      {variance !== null ? fmtRs(variance) : '—'}
                    </b>
                  </span>
                  {r.session?.note && <span className="text-faint">Note: {r.session.note}</span>}
                </div>
              )}
            </div>
          );
        })}
        {cashiers.length === 0 && (
          <div className="card p-10 text-center text-sub text-sm">No cashier accounts. Add one under Users.</div>
        )}
      </div>

      <Modal open={!!settling} onClose={() => setSettling(null)} title="Settle drawer" sub={cashiers.find(c => c.id === settling)?.name}>
        {settling && (
          <div className="space-y-4">
            <div className="flex justify-between items-center rounded-xl bg-raised border border-line px-4 py-3">
              <span className="text-sm text-sub">Expected in drawer</span>
              <span className="num font-extrabold text-violet-500">{fmtRs(rowFor(settling).expected)}</span>
            </div>
            <Field label="Counted cash (Rs.)">
              <input className="input num !text-base !font-bold" value={counted} onChange={e => setCounted(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" />
            </Field>
            <Field label="Note (optional)">
              <input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Rs. 500 short — will replace tomorrow" />
            </Field>
            {counted && (
              <div className={`rounded-xl px-4 py-3 text-sm font-semibold flex justify-between ${
                Number(counted) - rowFor(settling).expected === 0
                  ? 'bg-emerald-500/10 text-emerald-500'
                  : 'bg-rose-500/10 text-rose-500'
              }`}>
                <span>Variance</span>
                <span className="num">{fmtRs(Number(counted) - rowFor(settling).expected)}</span>
              </div>
            )}
            <button className="btn btn-primary w-full" onClick={settle} disabled={!counted}>
              <Lock size={15} /> Close &amp; settle day
            </button>
          </div>
        )}
      </Modal>
    </div>
  );
}
