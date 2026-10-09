import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Banknote, Wallet, TrendingUp, Lock, Unlock, CheckCircle2, RotateCcw,
  HandCoins, CreditCard, Smartphone, Receipt, Landmark, ShieldCheck, AlertTriangle,
  Printer, FileText, Cloud, CloudOff, Loader2,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { usePOS } from '../lib/store';
import { Badge, Modal, Field, Avatar, PageHeading } from '../components/ui';
import { fmtRs, dkey } from '../lib/utils';
import { calculateDayEndTotals } from '../lib/dayEnd';
import { downloadBackup } from '../lib/backup';
import { getLocalShopId, getGoogleScriptUrl, isGoogleSyncEnabled } from '../lib/driveSync';
import { hasRecoveryKey } from '../lib/backupCrypto';
import type { DaySession } from '../lib/types';

type BackupStatus = { target: string; kind: 'backing-up' | 'success' | 'failed' | 'offline' | 'skipped'; message: string };

async function backupWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise(resolve => {
    const timer = window.setTimeout(() => resolve(null), timeoutMs);
    promise.then(value => { window.clearTimeout(timer); resolve(value); })
      .catch(() => { window.clearTimeout(timer); resolve(null); });
  });
}

const varianceLabel = (variance: number) => variance === 0 ? 'Balanced' : variance > 0 ? 'Over' : 'Short';
const varianceTone = (variance: number): 'emerald' | 'amber' | 'rose' =>
  variance === 0 ? 'emerald' : variance > 0 ? 'amber' : 'rose';

export default function CashierBalances() {
  const { state, closeSession, closeDay, openSession, user, connectivity } = usePOS();
  const navigate = useNavigate();
  const today = dkey(new Date());
  const [settling, setSettling] = useState<string | null>(null);
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [signOffError, setSignOffError] = useState('');
  const [openFloatId, setOpenFloatId] = useState<string | null>(null);
  const [openingInput, setOpeningInput] = useState('');
  const [dayCloseOpen, setDayCloseOpen] = useState(false);
  const [dayCounts, setDayCounts] = useState<Record<string, string>>({});
  const [dayCloseNote, setDayCloseNote] = useState('');
  const [dayCloseError, setDayCloseError] = useState('');
  const [backupTarget, setBackupTarget] = useState('');
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const attemptedBackup = useRef(new Set<string>());

  const cashiers = useMemo(() => user?.role === 'admin'
    ? state.users.filter(person => person.role === 'cashier' || person.role === 'admin')
    : state.users.filter(person => person.id === user?.id), [state.users, user?.id, user?.role]);

  const rowCache = useMemo(() => {
    const ids = user?.role === 'admin'
      ? Array.from(new Set([
          ...cashiers.map(person => person.id),
          ...state.sessions.filter(session => session.date === today).map(session => session.cashierId),
        ]))
      : [user?.id || ''];
    const cache = new Map<string, ReturnType<typeof calculateDayEndTotals> & { session: DaySession | null }>();
    for (const cashierId of ids) {
      if (!cashierId) continue;
      const person = state.users.find(candidate => candidate.id === cashierId);
      const session = state.sessions.find(item => item.cashierId === cashierId && item.date === today);
      const effectiveSession: DaySession = session || {
        id: 'preview-' + cashierId,
        cashierId,
        cashierName: person?.name || user?.name || 'Cashier',
        date: today,
        opening: state.settings.openingFloat || 0,
        closed: false,
      };
      cache.set(cashierId, { ...calculateDayEndTotals(state, today, effectiveSession), session: session || null });
    }
    return cache;
  }, [state, today, cashiers, user?.id, user?.name, user?.role]);

  const rowFor = (cashierId: string) => rowCache.get(cashierId) || {
    ...calculateDayEndTotals(state, today),
    session: null,
  };

  const selectedRow = settling ? rowFor(settling) : null;
  const countedAmount = counted.trim() === '' ? NaN : Number(counted);
  const liveVariance = selectedRow && Number.isFinite(countedAmount)
    ? Math.round((countedAmount - selectedRow.expected) * 100) / 100
    : null;

  const topTotals = useMemo(() => {
    if (user?.role !== 'admin') {
      const session = state.sessions.find(item => item.cashierId === user?.id && item.date === today);
      if (session) return calculateDayEndTotals(state, today, session);
      const person = state.users.find(item => item.id === user?.id);
      return calculateDayEndTotals(state, today, {
        id: 'preview-current', cashierId: user?.id || '', cashierName: person?.name || user?.name || '',
        date: today, opening: state.settings.openingFloat || 0, closed: false,
      });
    }
    return calculateDayEndTotals(state, today);
  }, [state, today, user?.id, user?.name, user?.role]);

  const openSessions = useMemo(() => state.sessions.filter(session => session.date === today && !session.closed), [state.sessions, today]);

  const settle = () => {
    if (!settling || !selectedRow) return;
    const amount = Number(counted);
    if (counted.trim() === '' || !Number.isFinite(amount) || amount < 0) {
      setSignOffError('Enter the physical cash count (zero is allowed).');
      return;
    }
    const variance = Math.round((amount - selectedRow.expected) * 100) / 100;
    if (variance !== 0 && !note.trim()) {
      setSignOffError('Please add a short note explaining the shortage or overage.');
      return;
    }
    if (state.held.length) {
      setSignOffError('Complete or clear held bills before signing off.');
      return;
    }
    if ((state.reverseRequests || []).some(request => request.status === 'pending')) {
      setSignOffError('Resolve pending bill reverse approvals before signing off.');
      return;
    }
    const cashierId = settling;
    const sessionId = selectedRow.session?.id;
    if (!sessionId || selectedRow.session?.closed) {
      setSignOffError('This drawer is already closed or has not been opened.');
      return;
    }
    const ok = closeSession(cashierId, Math.round(amount * 100) / 100, note.trim());
    if (!ok) {
      setSignOffError('Sign off was blocked. Refresh the report and check the session status.');
      return;
    }
    setBackupTarget('session:' + sessionId);
    setSignOffError('');
    setSettling(null);
    setCounted('');
    setNote('');
  };

  const startDay = () => {
    if (!openFloatId) return;
    const existing = state.sessions.find(session => session.cashierId === openFloatId && session.date === today);
    if (existing?.closed) {
      window.alert('This cashier session is already signed off for today and cannot be reopened.');
      setOpenFloatId(null);
      setOpeningInput('');
      return;
    }
    const opening = Math.round(Number(openingInput) * 100) / 100;
    if (openingInput.trim() === '' || !Number.isFinite(opening) || opening < 0) return;
    if (existing && existing.opening !== opening) {
      const cashierName = state.users.find(person => person.id === openFloatId)?.name || '';
      const hasSales = state.sales.some(sale => dkey(sale.date) === today && sale.cashierId === openFloatId);
      const hasCashExpenses = state.expenses.some(expense => dkey(expense.date) === today && (expense.paymentMethod || 'cash') === 'cash' && expense.by === cashierName);
      if (hasSales || hasCashExpenses) {
        setSignOffError('Opening float cannot be changed after sales or cash expenses. Confirm the existing opening amount instead.');
        window.alert('Opening float cannot be changed after sales or cash expenses. Use the existing amount to confirm the opening float.');
        return;
      }
    }
    openSession(openFloatId, opening);
    setOpenFloatId(null);
    setOpeningInput('');
  };

  const openDayClose = () => {
    if (!openSessions.length) return;
    const initial: Record<string, string> = {};
    for (const session of openSessions) initial[session.cashierId] = String(rowFor(session.cashierId).expected);
    setDayCounts(initial);
    setDayCloseNote('');
    setDayCloseError('');
    setDayCloseOpen(true);
  };

  const submitDayClose = () => {
    if (!openSessions.length) return;
    if (state.held.length) {
      setDayCloseError('Complete or clear held bills before closing the full day.');
      return;
    }
    if ((state.reverseRequests || []).some(request => request.status === 'pending')) {
      setDayCloseError('Resolve pending bill reverse approvals before closing the full day.');
      return;
    }
    const counts: Record<string, number> = {};
    let varianceExists = false;
    for (const session of openSessions) {
      const raw = dayCounts[session.cashierId] ?? '';
      const value = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(value) || value < 0) {
        setDayCloseError(`Enter the counted cash for ${session.cashierName}.`);
        return;
      }
      counts[session.cashierId] = Math.round(value * 100) / 100;
      if (Math.round((counts[session.cashierId] - rowFor(session.cashierId).expected) * 100) / 100 !== 0) varianceExists = true;
    }
    if (varianceExists && !dayCloseNote.trim()) {
      setDayCloseError('A variance note is required when any counted drawer differs from expected cash.');
      return;
    }
    if (!window.confirm('Sign off every open cashier drawer for today? The POS will remain open on the Day End screen.')) return;
    const ok = closeDay(counts, dayCloseNote.trim());
    if (!ok) {
      setDayCloseError('Day close was blocked. Refresh the report and check open drawers, held bills, and reverse approvals.');
      return;
    }
    setDayCloseOpen(false);
    setBackupTarget('day:' + today);
  };

  useEffect(() => {
    if (!backupTarget) return;
    if (attemptedBackup.current.has(backupTarget)) return;
    const isDay = backupTarget.startsWith('day:');
    const targetId = isDay ? '' : backupTarget.slice('session:'.length);
    const targetSession = targetId ? state.sessions.find(session => session.id === targetId) : null;
    const closed = isDay
      ? !state.sessions.some(session => session.date === today && !session.closed)
      : !!targetSession?.closed;
    if (!closed) return;

    if (typeof navigator !== 'undefined' && !navigator.onLine || connectivity !== 'online') {
      setBackupStatus({ target: backupTarget, kind: 'offline', message: 'Day closed locally; Drive backup will retry when online.' });
      return;
    }
    const shopId = getLocalShopId();
    if (!isGoogleSyncEnabled() || !getGoogleScriptUrl() || !shopId || !hasRecoveryKey(shopId)) {
      attemptedBackup.current.add(backupTarget);
      setBackupStatus({ target: backupTarget, kind: 'skipped', message: 'Day closed locally. Google Drive backup is not ready on this device (configuration or Recovery Key missing).' });
      return;
    }
    attemptedBackup.current.add(backupTarget);
    setBackupStatus({ target: backupTarget, kind: 'backing-up', message: 'Day closed. Backing up encrypted POS data to Google Drive…' });
    void (async () => {
      const result = await backupWithTimeout(downloadBackup(state, 'auto', { download: false, cloud: true }), 7000);
      if (!result) {
        setBackupStatus({ target: backupTarget, kind: 'failed', message: 'Day closed locally. Drive backup timed out after 7 seconds; the upload may still finish in the background.' });
      } else if (result.cloud) {
        setBackupStatus({ target: backupTarget, kind: 'success', message: 'Day closed and encrypted Google Drive backup confirmed.' });
      } else {
        setBackupStatus({ target: backupTarget, kind: 'failed', message: `Day closed locally; Google Drive backup failed: ${result.error || 'No successful Drive confirmation'}` });
      }
    })();
  }, [backupTarget, state, today, connectivity]);

  const cards = [
    { label: 'Opening float', value: topTotals.opening, icon: Wallet, tone: 'violet' },
    { label: 'Gross sales', value: topTotals.grossSales, icon: TrendingUp, tone: 'emerald' },
    { label: 'Sales returns / refunds', value: topTotals.refunds, icon: RotateCcw, tone: 'rose' },
    { label: 'Net sales', value: topTotals.netSales, icon: Receipt, tone: 'blue' },
    { label: 'Cash received', value: topTotals.cash, icon: Banknote, tone: 'sky' },
    { label: 'Card received', value: topTotals.card, icon: CreditCard, tone: 'blue' },
    { label: 'Bank received', value: topTotals.bank, icon: Landmark, tone: 'slate' },
    { label: 'Mobile received', value: topTotals.mobile, icon: Smartphone, tone: 'violet' },
    { label: 'Credit sale balance due', value: topTotals.creditSales, icon: HandCoins, tone: 'amber' },
    { label: 'Credit settled today', value: topTotals.creditSettledTotal, icon: CheckCircle2, tone: 'emerald' },
    { label: 'Expenses today', value: topTotals.expenses, icon: Receipt, tone: 'rose' },
    { label: 'Expected cash in hand', value: topTotals.expected, icon: Landmark, tone: 'violet' },
  ];

  const dayCloseSummary = useMemo(() => {
    let expected = 0;
    let counted = 0;
    let allCounted = true;
    for (const session of openSessions) {
      expected += rowCache.get(session.cashierId)?.expected || 0;
      const raw = dayCounts[session.cashierId] ?? '';
      if (raw.trim() === '') {
        allCounted = false;
        continue;
      }
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) allCounted = false;
      else counted += value;
    }
    expected = Math.round(expected * 100) / 100;
    counted = Math.round(counted * 100) / 100;
    return { expected, counted, variance: Math.round((counted - expected) * 100) / 100, allCounted };
  }, [openSessions, dayCounts, rowCache]);

  const currentSession = state.sessions.find(session => session.cashierId === user?.id && session.date === today);
  const currentClosed = !!currentSession?.closed;

  return (
    <div className="space-y-5 print:space-y-3">
      <PageHeading
        chip="Day End"
        title="Cashier Balance Report"
        sub={`Today · ${today} · ${user?.role === 'admin' ? 'All cashier drawers' : 'Your cashier drawer'}`}
        actions={
          <div className="flex flex-wrap gap-2 print:hidden">
            <button type="button" className="btn btn-soft" onClick={() => { window.print(); }}><Printer size={15} /> Print report</button>
            <button type="button" className="btn btn-soft" onClick={() => navigate('/day-close-report')} hidden={user?.role !== 'admin'}><FileText size={15} /> Close history</button>
            <button
              type="button"
              className="btn btn-soft"
              onClick={() => {
                const id = user?.role === 'admin' ? (user.id || cashiers[0]?.id) : user?.id;
                if (!id) return;
                const session = state.sessions.find(item => item.cashierId === id && item.date === today);
                setOpenFloatId(id);
                setOpeningInput(String(session?.opening ?? state.settings.openingFloat ?? 0));
              }}
              disabled={currentClosed && user?.role !== 'admin'}
            >
              <Unlock size={15} /> Set opening cash
            </button>
            {user?.role === 'admin' && (
              <button type="button" className="btn btn-primary" onClick={openDayClose} disabled={!openSessions.length}>
                <Lock size={15} /> Close full day
              </button>
            )}
          </div>
        }
      />

      {currentClosed && user?.role !== 'admin' && (
        <div className="card p-4 border border-emerald-500/25 bg-emerald-500/[0.05]">
          <div className="flex items-start gap-3">
            <ShieldCheck className="text-emerald-600 mt-0.5" size={20} />
            <div>
              <div className="font-bold text-ink">Session closed — sign off complete</div>
              <p className="text-sm text-sub mt-1">Your drawer is locked for today. Sign out when finished; sales require an open cashier session.</p>
            </div>
          </div>
        </div>
      )}

      {backupStatus && backupStatus.target === backupTarget && (
        <div className={`card p-3 flex items-start gap-2 text-sm ${backupStatus.kind === 'success' ? 'border border-emerald-500/25' : backupStatus.kind === 'failed' ? 'border border-rose-500/25' : backupStatus.kind === 'offline' || backupStatus.kind === 'skipped' ? 'border border-amber-500/25' : 'border border-sky-500/25'}`}>
          {backupStatus.kind === 'backing-up' ? <Loader2 className="animate-spin text-sky-600" size={17} /> : backupStatus.kind === 'success' ? <Cloud className="text-emerald-600" size={17} /> : backupStatus.kind === 'offline' || backupStatus.kind === 'skipped' ? <CloudOff className="text-amber-600" size={17} /> : <AlertTriangle className="text-rose-600" size={17} />}
          <span className="text-sub">{backupStatus.message}</span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
        {cards.map(card => (
          <div key={card.label} className="card p-4 flex gap-3 items-start">
            <span className="w-9 h-9 rounded-xl bg-violet-500/10 text-violet-600 flex items-center justify-center shrink-0"><card.icon size={16} /></span>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-sub">{card.label}</div>
              <div className={`text-lg font-bold num truncate mt-0.5 ${card.tone === 'amber' ? 'text-amber-600' : card.tone === 'emerald' ? 'text-emerald-600' : 'text-ink'}`}>{fmtRs(card.value)}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="card p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold text-ink">Payment methods & adjustments</h2>
          <Badge tone="amber">Credit is not cash</Badge>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
          {(['cash', 'card', 'bank', 'mobile'] as const).map(method => (
            <div key={method} className="rounded-xl bg-raised p-3">
              <div className="text-[10px] uppercase text-faint">Credit settled · {method}</div>
              <div className="font-bold num text-emerald-600">{fmtRs(topTotals.creditSettled[method])}</div>
            </div>
          ))}
          <div className="rounded-xl bg-raised p-3"><div className="text-[10px] uppercase text-faint">Discounts given</div><div className="font-bold num">{fmtRs(topTotals.discounts)}</div></div>
          <div className="rounded-xl bg-raised p-3"><div className="text-[10px] uppercase text-faint">Bill count</div><div className="font-bold num">{topTotals.bills}</div></div>
          <div className="rounded-xl bg-raised p-3"><div className="text-[10px] uppercase text-faint">Average ticket</div><div className="font-bold num">{fmtRs(topTotals.averageTicket)}</div></div>
          <div className="rounded-xl bg-raised p-3"><div className="text-[10px] uppercase text-faint">Total expenses</div><div className="font-bold num">{fmtRs(topTotals.expenses)}</div></div>
        </div>
        <p className="text-xs text-sub" title="Expected cash = opening float + cash received from today's sales + cash credit settlements − cash refunds/returns − cash expenses.">
          <b>Expected cash formula:</b> Opening float + Cash sales received + Cash credit settled − Cash refunds/returns − Cash expenses. Card, bank, mobile, and credit balances are not drawer cash.
        </p>
      </div>

      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-line font-semibold text-ink">Cashier drawers</div>
        <div className="divide-y divide-line">
          {cashiers.map(cashier => {
            const row = rowFor(cashier.id);
            const variance = row.session?.closed
              ? Number(row.session.variance ?? ((row.session.closing ?? 0) - (row.session.expected ?? row.expected)))
              : null;
            return (
              <div key={cashier.id} className="p-4">
                <div className="flex flex-wrap items-center gap-3 justify-between">
                  <div className="flex items-center gap-3">
                    <Avatar name={cashier.name} />
                    <div><div className="font-semibold text-ink">{cashier.name}</div><div className="text-xs text-sub">{cashier.email}</div></div>
                    {row.session?.closed ? <Badge tone="emerald">Closed</Badge> : <Badge tone="amber">Open</Badge>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="btn btn-soft !py-1.5 !px-3 text-xs" onClick={() => { setOpenFloatId(cashier.id); setOpeningInput(String(row.opening)); }} disabled={!!row.session?.closed}>
                      Opening {fmtRs(row.opening)}
                    </button>
                    {!row.session?.closed && row.session && (
                      <button type="button" className="btn btn-primary !py-1.5 !px-3 text-xs" onClick={() => { setSettling(cashier.id); setCounted(String(row.expected)); setNote(''); setSignOffError(''); }}>
                        <Lock size={14} /> Cashier Sign Off
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 text-sm">
                  <div className="rounded-lg bg-raised px-3 py-2"><div className="text-[10px] uppercase text-faint">Cash sales</div><div className="font-semibold num">{fmtRs(row.cash)}</div></div>
                  <div className="rounded-lg bg-raised px-3 py-2"><div className="text-[10px] uppercase text-faint">Credit settled cash</div><div className="font-semibold num text-emerald-600">{fmtRs(row.creditSettled.cash)}</div></div>
                  <div className="rounded-lg bg-raised px-3 py-2"><div className="text-[10px] uppercase text-faint">Credit due issued</div><div className="font-semibold num text-amber-600">{fmtRs(row.creditSales)}</div></div>
                  <div className="rounded-lg bg-raised px-3 py-2"><div className="text-[10px] uppercase text-faint">Cash refunds</div><div className="font-semibold num">{fmtRs(row.cashRefunds)}</div></div>
                  <div className="rounded-lg bg-raised px-3 py-2"><div className="text-[10px] uppercase text-faint">Cash expenses</div><div className="font-semibold num">{fmtRs(row.cashExpenses)}</div></div>
                  <div className="rounded-lg bg-raised px-3 py-2"><div className="text-[10px] uppercase text-faint">Expected cash</div><div className="font-semibold num text-violet-600">{fmtRs(row.expected)}</div></div>
                </div>
                {row.session?.closed && (
                  <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-sub">
                    <span>Counted: <b className="text-ink num">{fmtRs(row.session.closing ?? 0)}</b></span>
                    <span>Variance: <b className={`num ${variance === 0 ? 'text-emerald-600' : variance != null && variance > 0 ? 'text-amber-600' : 'text-rose-600'}`}>{fmtRs(variance ?? 0)}</b></span>
                    {variance != null && <Badge tone={varianceTone(variance)}>{varianceLabel(variance)}</Badge>}
                    {row.session.closedBy && <span>Signed off by {row.session.closedBy}</span>}
                    {row.session.note && <span>Note: {row.session.note}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <Modal open={!!openFloatId} onClose={() => setOpenFloatId(null)} title="Open / set opening float">
        <div className="space-y-3">
          <p className="text-sm text-sub">Enter the physical starting cash before sales. The opening float cannot be changed after sales or cash expenses have been recorded.</p>
          <Field label="Opening amount (Rs.)">
            <input className="input num" type="number" min={0} step={0.01} value={openingInput} onChange={event => setOpeningInput(event.target.value)} autoFocus />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-soft" onClick={() => setOpenFloatId(null)}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={startDay} disabled={openingInput.trim() === '' || !Number.isFinite(Number(openingInput)) || Number(openingInput) < 0}><CheckCircle2 size={15} /> Save opening float</button>
          </div>
        </div>
      </Modal>

      <Modal open={!!settling} onClose={() => setSettling(null)} title="CASHIER SIGN OFF" sub={`Today · ${today}`}>
        <div className="space-y-3">
          {selectedRow && (
            <div className="rounded-xl bg-raised p-3">
              <div className="text-[10px] uppercase tracking-wide text-faint">Expected cash in hand</div>
              <div className="text-2xl font-extrabold num text-ink mt-1">{fmtRs(selectedRow.expected)}</div>
              <p className="text-[11px] text-sub mt-1">Opening + cash sales + cash credit settlements − cash refunds − cash expenses.</p>
            </div>
          )}
          <Field label="Counted cash in hand (Rs.)">
            <input className="input num" type="number" min={0} step={0.01} value={counted} onChange={event => setCounted(event.target.value)} autoFocus placeholder="Count physical notes and coins" />
          </Field>
          {liveVariance !== null && (
            <div className="grid grid-cols-2 gap-2 rounded-xl border border-line p-3 text-sm">
              <div><div className="text-[10px] uppercase text-faint">Variance</div><div className={`font-bold num mt-1 ${liveVariance === 0 ? 'text-emerald-600' : liveVariance > 0 ? 'text-amber-600' : 'text-rose-600'}`}>{fmtRs(liveVariance)}</div></div>
              <div><div className="text-[10px] uppercase text-faint">Status</div><div className="mt-1"><Badge tone={varianceTone(liveVariance)}>{varianceLabel(liveVariance)}</Badge></div></div>
            </div>
          )}
          <Field label={liveVariance !== null && liveVariance !== 0 ? 'Variance explanation (required)' : 'Note (optional)'}>
            <input className="input" value={note} maxLength={240} onChange={event => setNote(event.target.value)} placeholder={liveVariance !== null && liveVariance !== 0 ? 'Explain shortage or overage' : 'Optional note'} />
          </Field>
          {signOffError && <div className="rounded-lg border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2 text-sm text-rose-600">{signOffError}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-soft" onClick={() => setSettling(null)}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={settle} disabled={counted.trim() === '' || !Number.isFinite(Number(counted)) || Number(counted) < 0 || (liveVariance !== null && liveVariance !== 0 && !note.trim())}><Lock size={15} /> Confirm Sign Off</button>
          </div>
        </div>
      </Modal>

      <Modal open={dayCloseOpen} onClose={() => setDayCloseOpen(false)} title="Admin · Close full day" sub={`Today · ${today} · ${openSessions.length} open drawer(s)`} wide>
        <div className="space-y-4">
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3 text-sm text-sub">Every open drawer must be counted. Held bills and pending reverse approvals block day close. The app stays open after sign-off; the encrypted Drive backup runs best-effort.</div>
          <div className="space-y-2">
            {openSessions.map(session => {
              const row = rowFor(session.cashierId);
              const raw = dayCounts[session.cashierId] ?? '';
              const value = raw.trim() === '' ? NaN : Number(raw);
              const variance = Number.isFinite(value) ? Math.round((value - row.expected) * 100) / 100 : null;
              return (
                <div key={session.id} className="rounded-xl border border-line bg-raised p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <div><div className="font-bold text-ink">{session.cashierName}</div><div className="text-[11px] text-sub">Opening {fmtRs(session.opening)} · Cash received {fmtRs(row.cash)} · Credit settled cash {fmtRs(row.creditSettled.cash)} · Expected {fmtRs(row.expected)}</div></div>
                    <div className={`text-sm font-extrabold num ${variance === 0 ? 'text-emerald-600' : variance != null && variance > 0 ? 'text-amber-600' : 'text-rose-600'}`}>{variance == null ? 'Variance —' : `Variance ${fmtRs(variance)}`}</div>
                  </div>
                  <Field label="Counted cash in drawer (Rs.)">
                    <input className="input num" type="number" min={0} step={0.01} value={raw} onChange={event => setDayCounts(values => ({ ...values, [session.cashierId]: event.target.value }))} />
                  </Field>
                </div>
              );
            })}
          </div>
          <div className="grid grid-cols-3 gap-2 rounded-xl border border-line p-3">
            <div><div className="text-[9px] uppercase tracking-wide text-faint">Total expected</div><div className="font-bold num text-ink mt-1">{fmtRs(dayCloseSummary.expected)}</div></div>
            <div><div className="text-[9px] uppercase tracking-wide text-faint">Total counted</div><div className="font-bold num text-ink mt-1">{dayCloseSummary.allCounted ? fmtRs(dayCloseSummary.counted) : '—'}</div></div>
            <div><div className="text-[9px] uppercase tracking-wide text-faint">Total variance</div><div className={`font-bold num mt-1 ${!dayCloseSummary.allCounted ? 'text-sub' : dayCloseSummary.variance === 0 ? 'text-emerald-600' : dayCloseSummary.variance > 0 ? 'text-amber-600' : 'text-rose-600'}`}>{dayCloseSummary.allCounted ? fmtRs(dayCloseSummary.variance) : '—'}</div></div>
          </div>
          {dayCloseError && <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2 text-sm font-semibold text-rose-600">{dayCloseError}</div>}
          <Field label="Full-day note (required if any variance)">
            <input className="input" value={dayCloseNote} maxLength={240} onChange={event => setDayCloseNote(event.target.value)} placeholder="Optional unless there is a variance" />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-soft" onClick={() => setDayCloseOpen(false)}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={submitDayClose} disabled={!openSessions.length}><Lock size={15} /> Sign Off Full Day</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
