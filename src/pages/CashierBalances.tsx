import { useMemo, useState } from 'react';
import {
  Landmark, Banknote, Wallet, TrendingUp, Lock, Unlock, CheckCircle2,
  RotateCcw, HandCoins, CreditCard, Smartphone, Receipt,
} from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, Modal, Field, Avatar, PageHeading } from '../components/ui';
import { fmtRs, dkey, salePayments } from '../lib/utils';

export default function CashierBalances() {
  const { state, closeSession, openSession, user } = usePOS() as ReturnType<typeof usePOS> & {
    openSession: (cashierId: string, opening: number) => void;
  };
  const today = dkey(new Date());
  const [settling, setSettling] = useState<string | null>(null);
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [openFloatId, setOpenFloatId] = useState<string | null>(null);
  const [openingInput, setOpeningInput] = useState('');

  const cashiers = state.users.filter(u => u.role === 'cashier' || u.role === 'admin');

  const todaySales = useMemo(
    () => state.sales.filter(s => dkey(s.date) === today),
    [state.sales, today],
  );
  const completed = todaySales.filter(s => s.status === 'completed' || s.status === 'exchanged');
  const refunded = todaySales.filter(s => s.status === 'refunded');

  const sumMethod = (method: string) =>
    completed.reduce(
      (a, s) => a + salePayments(s).filter(l => l.method === method).reduce((x, l) => x + l.amount, 0),
      0,
    );

  const cashSales = sumMethod('cash');
  const cardSales = sumMethod('card');
  const bankSales = sumMethod('bank');
  const mobileSales = sumMethod('mobile');
  const creditSales = sumMethod('credit');
  const grossSales = completed.reduce((a, s) => a + s.total, 0);
  const refundTotal = refunded.reduce((a, s) => a + s.total, 0);
  const todayExpenses = state.expenses
    .filter(e => dkey(e.date) === today)
    .reduce((a, e) => a + e.amount, 0);

  const rowFor = (id: string) => {
    const mine = completed.filter(s => s.cashierId === id);
    const session = state.sessions.find(x => x.cashierId === id && x.date === today);
    const cash = mine.reduce(
      (a, s) => a + salePayments(s).filter(l => l.method === 'cash').reduce((x, l) => x + l.amount, 0),
      0,
    );
    const credit = mine.reduce(
      (a, s) => a + salePayments(s).filter(l => l.method === 'credit').reduce((x, l) => x + l.amount, 0),
      0,
    );
    const other = mine.reduce(
      (a, s) =>
        a +
        salePayments(s)
          .filter(l => l.method !== 'cash' && l.method !== 'credit')
          .reduce((x, l) => x + l.amount, 0),
      0,
    );
    const opening = session?.opening ?? state.settings.openingFloat;
    const myRefunds = state.sales.filter(s => s.status === 'refunded' && dkey(s.date) === today && s.cashierId === id);
    const cashRefunds = myRefunds.reduce((a, s) => {
      const cashPart = salePayments(s).filter(l => l.method === 'cash').reduce((x, l) => x + l.amount, 0);
      return a + (cashPart > 0 ? cashPart : s.total);
    }, 0);
    const expected = Math.round((opening + cash - cashRefunds) * 100) / 100;
    return { mine, session, cash, credit, other, opening, expected, cashRefunds };
  };

  const settleRow = settling ? rowFor(settling) : null;
  const countedAmount = Number(counted);
  const liveVariance = settleRow && Number.isFinite(countedAmount)
    ? Math.round((countedAmount - settleRow.expected) * 100) / 100
    : null;

  const settle = () => {
    if (!settling) return;
    const amount = Number(counted);
    if (!Number.isFinite(amount) || amount < 0) return;
    const session = state.sessions.find(x => x.cashierId === settling && x.date === today);
    if (!session || session.closed) return;
    closeSession(settling, Math.round(amount * 100) / 100, note.trim());
    setSettling(null);
    setCounted('');
    setNote('');
  };

  const startDay = () => {
    if (!openFloatId) return;
    const existing = state.sessions.find(x => x.cashierId === openFloatId && x.date === today);
    if (existing?.closed) {
      window.alert(`This cashier's session for ${today} is already closed. A closed session cannot be reopened.`);
      setOpenFloatId(null);
      setOpeningInput('');
      return;
    }
    const opening = Number(openingInput);
    if (!Number.isFinite(opening) || opening < 0) return;
    openSession(openFloatId, Math.round(opening * 100) / 100);
    setOpenFloatId(null);
    setOpeningInput('');
  };

  const cashRefundsShop = refunded.reduce((a, s) => {
    const cashPart = salePayments(s).filter(l => l.method === 'cash').reduce((x, l) => x + l.amount, 0);
    return a + (cashPart > 0 ? cashPart : s.total);
  }, 0);
  const openingTotal = state.sessions.filter(s => s.date === today).reduce((a, s) => a + s.opening, 0)
    || state.settings.openingFloat;
  const shopExpected = Math.round((openingTotal + cashSales - cashRefundsShop - todayExpenses) * 100) / 100;

  const cards = [
    { label: 'Opening float', value: fmtRs(openingTotal), icon: Wallet, tone: 'violet' },
    { label: "Today's sales", value: fmtRs(grossSales), icon: TrendingUp, tone: 'emerald' },
    { label: 'Cash in drawer', value: fmtRs(cashSales), icon: Banknote, tone: 'sky' },
    { label: 'Card / Bank / Mobile', value: fmtRs(cardSales + bankSales + mobileSales), icon: CreditCard, tone: 'blue' },
    { label: 'Credit (නයට)', value: fmtRs(creditSales), icon: HandCoins, tone: 'amber' },
    { label: 'Refunds / returns', value: fmtRs(refundTotal), icon: RotateCcw, tone: 'rose' },
    { label: 'Expenses', value: fmtRs(todayExpenses), icon: Receipt, tone: 'slate' },
    { label: 'Expected cash', value: fmtRs(shopExpected), icon: Landmark, tone: 'violet' },
  ];

  return (
    <div className="space-y-5">
      <PageHeading
        chip="Cash"
        title="Day cash & drawer"
        sub={`Today · ${today} — opening float, sales, credit, returns in one place`}
        actions={
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              const id = user?.id || cashiers[0]?.id;
              if (!id) return;
              const sess = state.sessions.find(x => x.cashierId === id && x.date === today);
              setOpenFloatId(id);
              setOpeningInput(String(sess?.opening ?? state.settings.openingFloat ?? 0));
            }}
          >
            <Unlock size={15} /> Set opening cash
          </button>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map(c => (
          <div key={c.label} className="card p-4 flex gap-3 items-start">
            <span className="w-9 h-9 rounded-xl bg-violet-500/10 text-violet-600 flex items-center justify-center shrink-0">
              <c.icon size={16} />
            </span>
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-sub">{c.label}</div>
              <div className="text-lg font-bold num text-ink truncate mt-0.5">{c.value}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-line font-semibold text-ink">Per cashier</div>
        <div className="divide-y divide-line">
          {cashiers.map(c => {
            const r = rowFor(c.id);
            const variance =
              r.session?.closed && r.session.closing != null
                ? r.session.closing - r.expected
                : null;
            return (
              <div key={c.id} className="p-4">
                <div className="flex flex-wrap items-center gap-3 justify-between">
                  <div className="flex items-center gap-3">
                    <Avatar name={c.name} />
                    <div>
                      <div className="font-semibold text-ink">{c.name}</div>
                      <div className="text-xs text-sub">{c.email}</div>
                    </div>
                    {r.session?.closed ? (
                      <Badge tone="emerald">Closed</Badge>
                    ) : (
                      <Badge tone="amber">Open</Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn btn-soft !py-1.5 !px-3 text-xs"
                      onClick={() => {
                        setOpenFloatId(c.id);
                        setOpeningInput(String(r.opening));
                      }}
                    >
                      Opening {fmtRs(r.opening)}
                    </button>
                    {!r.session?.closed && (
                      <button
                        type="button"
                        className="btn btn-primary !py-1.5 !px-3 text-xs"
                        onClick={() => {
                          setSettling(c.id);
                          setCounted(String(r.expected));
                          setNote('');
                        }}
                      >
                        <Lock size={14} /> Settle drawer
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                  <div className="rounded-lg bg-raised px-3 py-2">
                    <div className="text-[10px] uppercase text-faint">Cash sales</div>
                    <div className="font-semibold num">{fmtRs(r.cash)}</div>
                  </div>
                  <div className="rounded-lg bg-raised px-3 py-2">
                    <div className="text-[10px] uppercase text-faint">Credit</div>
                    <div className="font-semibold num text-amber-600">{fmtRs(r.credit)}</div>
                  </div>
                  <div className="rounded-lg bg-raised px-3 py-2">
                    <div className="text-[10px] uppercase text-faint">Card/Bank/Mobile</div>
                    <div className="font-semibold num">{fmtRs(r.other)}</div>
                  </div>
                  <div className="rounded-lg bg-raised px-3 py-2">
                    <div className="text-[10px] uppercase text-faint">Expected drawer</div>
                    <div className="font-semibold num text-violet-600">{fmtRs(r.expected)}</div>
                  </div>
                </div>
                {r.session?.closed && (
                  <div className="mt-2 text-sm text-sub flex flex-wrap gap-4">
                    <span>
                      Counted: <b className="text-ink num">{fmtRs(r.session.closing || 0)}</b>
                    </span>
                    <span>
                      Variance:{' '}
                      <b className={`num ${variance && variance !== 0 ? 'text-rose-500' : 'text-emerald-500'}`}>
                        {variance != null ? fmtRs(variance) : '—'}
                      </b>
                    </span>
                    {r.session.note && <span>Note: {r.session.note}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <Modal open={!!openFloatId} onClose={() => setOpenFloatId(null)} title="Set opening cash">
        <div className="space-y-3">
          <p className="text-sm text-sub">
            Morning float — අතේ තියෙන මුදල. Day end එකේ expected drawer = opening + cash sales.
          </p>
          <Field label="Opening amount (Rs.)">
            <input
              className="input num"
              type="number"
              min={0}
              step={0.01}
              value={openingInput}
              onChange={e => setOpeningInput(e.target.value)}
              autoFocus
            />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-soft" onClick={() => setOpenFloatId(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={startDay} disabled={!Number.isFinite(Number(openingInput)) || Number(openingInput) < 0}>
              <CheckCircle2 size={15} /> Save opening
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={!!settling} onClose={() => setSettling(null)} title="Settle cash drawer">
        <div className="space-y-3">
          <Field label="Counted cash in drawer (Rs.)">
            <input
              className="input num"
              type="number"
              min={0}
              step={0.01}
              value={counted}
              onChange={e => setCounted(e.target.value)}
              autoFocus
            />
          </Field>
          {settleRow && (
            <div className="grid grid-cols-2 gap-2 rounded-xl bg-raised p-3 text-sm">
              <div><div className="text-[10px] uppercase tracking-wide text-faint">Expected cash</div><div className="font-bold num text-ink mt-0.5">{fmtRs(settleRow.expected)}</div></div>
              <div><div className="text-[10px] uppercase tracking-wide text-faint">Variance</div><div className={`font-bold num mt-0.5 ${liveVariance == null || liveVariance === 0 ? 'text-emerald-600' : liveVariance > 0 ? 'text-sky-600' : 'text-rose-500'}`}>{liveVariance == null ? '—' : fmtRs(liveVariance)}</div></div>
            </div>
          )}
          <Field label="Note (optional)">
            <input className="input" value={note} onChange={e => setNote(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-soft" onClick={() => setSettling(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={settle} disabled={!Number.isFinite(Number(counted)) || Number(counted) < 0}>
              <Lock size={15} /> Close day
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
