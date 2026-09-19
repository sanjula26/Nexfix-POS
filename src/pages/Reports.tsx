import { useMemo, useState } from 'react';
import {
  BarChart3, CalendarDays, Download, Banknote, TrendingUp, Trophy,
  ReceiptText, Wallet, CreditCard, Banknote as Bank, Smartphone, Landmark, HandCoins,
  ArrowRight, ArrowDownRight, ArrowUpRight, Minus, GitCompareArrows, CalendarX2,
} from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
  BarChart, Bar, PieChart, Pie, Cell, Legend,
} from 'recharts';
import { usePOS } from '../lib/store';
import { Badge, Avatar, EmptyState } from '../components/ui';
import DatePicker from '../components/DatePicker';
import { fmtRs, fmtNum, dkey, downloadFile, periodRange, inRange, PeriodKey } from '../lib/utils';

const PRIMARY: { key: PeriodKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'This Week' },
  { key: 'lastweek', label: 'Last Week' },
];
const MORE: { key: PeriodKey; label: string }[] = [
  { key: 'month', label: 'This Month' }, { key: 'lastmonth', label: 'Last Month' },
  { key: 'year', label: 'This Year' }, { key: 'lastyear', label: 'Last Year' },
  { key: 'custom', label: 'Custom' }, { key: 'all', label: 'All Time' },
];

const PAY_ICON: Record<string, React.ElementType> = { cash: Bank, card: CreditCard, bank: Landmark, mobile: Smartphone, credit: HandCoins };
const PIE_COLORS = ['#10b981', '#38bdf8', '#8b5cf6', '#f59e0b', '#f43f5e'];

type CompareMode = 'none' | 'previous' | 'custom' | 'lastmonth' | 'lastyear';

const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

export default function Reports() {
  const { state } = usePOS();
  const [period, setPeriod] = useState<PeriodKey>('week');
  const [custom, setCustom] = useState({ from: dkey(new Date(Date.now() - 6 * 86400000)), to: dkey(new Date()) });
  const [compareMode, setCompareMode] = useState<CompareMode>('previous');
  const [compareFrom, setCompareFrom] = useState('');
  const [compareTo, setCompareTo] = useState('');
  const [chartMetric, setChartMetric] = useState<'revenue' | 'profit'>('revenue');

  const [from, to] = useMemo(() => periodRange(period, custom), [period, custom]);
  const spanMs = to.getTime() - from.getTime();

  const shiftRange = (start: Date, end: Date, months = 0, years = 0): [Date, Date] => {
    const shift = (d: Date) => {
      const day = d.getDate();
      const target = new Date(d.getFullYear() + years, d.getMonth() + months, 1);
      const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
      target.setDate(Math.min(day, last));
      return target;
    };
    const s = shift(start);
    const e = shift(end);
    return [new Date(s.getFullYear(), s.getMonth(), s.getDate()), endOfDay(e)];
  };
  const compareRange = useMemo((): [Date, Date] | null => {
    if (period === 'all' || compareMode === 'none') return null;
    if (compareMode === 'previous') {
      const durationMs = to.getTime() - from.getTime() + 1;
      return [new Date(from.getTime() - durationMs), new Date(from.getTime() - 1)];
    }
    if (compareMode === 'lastmonth') return shiftRange(from, to, -1);
    if (compareMode === 'lastyear') return shiftRange(from, to, 0, -1);
    if (!compareFrom || !compareTo) return null;
    const cf = new Date(compareFrom + 'T00:00:00');
    const ct = new Date(compareTo + 'T23:59:59.999');
    return cf <= ct ? [cf, ct] : [ct, cf];
  }, [compareMode, compareFrom, compareTo, from, to, period]);

  const quickLabel = (k: PeriodKey) => [...PRIMARY, ...MORE].find(q => q.key === k)?.label || k;

  /* ---------- datasets ---------- */
  const salesA = useMemo(
    () => state.sales.filter(s => s.status !== 'refunded' && inRange(s.date, [from, to])),
    [state.sales, from, to],
  );
  const salesB = useMemo(
    () => (compareRange ? state.sales.filter(s => s.status !== 'refunded' && inRange(s.date, compareRange)) : []),
    [state.sales, compareRange],
  );
  const expensesA = state.expenses.filter(e => inRange(e.date, [from, to]));
  const expensesB = compareRange ? state.expenses.filter(e => inRange(e.date, compareRange)) : [];

  const kpi = (rows: typeof salesA) => ({
    revenue: rows.reduce((a, s) => a + s.total, 0),
    profit: rows.reduce((a, s) => a + s.profit, 0),
    bills: rows.length,
  });
  const A = kpi(salesA);
  const B = kpi(salesB);
  const expA = expensesA.reduce((a, e) => a + e.amount, 0);
  const expB = expensesB.reduce((a, e) => a + e.amount, 0);
  const netA = A.profit - expA;
  const netB = B.profit - expB;
  const comparing = compareRange !== null;
  const delta = (a: number, b: number) => (b === 0 ? (a === 0 ? 0 : null) : Math.round(((a - b) / Math.abs(b)) * 100));
  const diff = (a: number, b: number) => a - b;
  const durationDays = (r: [Date, Date]) => Math.max(1, Math.round((r[1].getTime() - r[0].getTime() + 1) / 86400000));
  const durationA = durationDays([from, to]);
  const durationB = compareRange ? durationDays(compareRange) : 0;

  /* daily series — compare column aligned by day offset */
  const daily = useMemo(() => {
    const days = Math.max(1, Math.min(62, Math.ceil(spanMs / 86400000)));
    const out: { d: string; revenue: number; profit: number; compareRevenue: number | null; compareProfit: number | null }[] = [];
    for (let i = 0; i < days; i++) {
      const day = new Date(from.getTime() + i * 86400000);
      if (day.getTime() > Date.now() + 43200000) break;
      const key = dkey(day);
      const rows = salesA.filter(s => dkey(s.date) === key);
      let cmpRevenue: number | null = null;
      let cmpProfit: number | null = null;
      if (compareRange) {
        const cday = new Date(compareRange[0].getTime() + i * 86400000);
        if (cday <= compareRange[1]) {
          const ckey = dkey(cday);
          const compareRows = salesB.filter(s => dkey(s.date) === ckey);
          cmpRevenue = compareRows.reduce((a, s) => a + s.total, 0);
          cmpProfit = compareRows.reduce((a, s) => a + s.profit, 0);
        }
      }
      out.push({
        d: day.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
        revenue: rows.reduce((a, s) => a + s.total, 0),
        profit: rows.reduce((a, s) => a + s.profit, 0),
        compareRevenue: cmpRevenue,
        compareProfit: cmpProfit,
      });
    }
    return out;
  }, [salesA, salesB, from, spanMs, compareRange]);

  const topProducts = useMemo(() => {
    const m = new Map<string, { name: string; qty: number; revenue: number }>();
    salesA.forEach(s => s.items.forEach(it => {
      const e = m.get(it.productId) || { name: it.name, qty: 0, revenue: 0 };
      e.qty += it.qty; e.revenue += it.qty * it.price - (it.discount || 0);
      m.set(it.productId, e);
    }));
    return [...m.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 6)
      .map(x => ({ ...x, name: x.name.length > 18 ? x.name.slice(0, 17) + '…' : x.name }));
  }, [salesA]);

  const paySplit = useMemo(() => {
    const m = new Map<string, number>();
    salesA.forEach(s => (s.payments && s.payments.length > 1 ? s.payments : [{ method: s.payment, amount: s.total }])
      .forEach(l => m.set(l.method, (m.get(l.method) || 0) + l.amount)));
    return [...m.entries()].map(([k, v]) => ({ name: k.toUpperCase(), value: Math.round(v) }));
  }, [salesA]);

  // PHASE1_MACHINE_REPORTS_V1
  const machineRows = useMemo(() => {
    const m = new Map<string, { id: string; name: string; bills: number; revenue: number; profit: number }>();
    salesA.forEach(s => {
      const id = s.machineId || 'LEGACY';
      const name = s.machineName || 'Legacy / Unassigned';
      const e = m.get(id) || { id, name, bills: 0, revenue: 0, profit: 0 };
      e.bills += 1; e.revenue += s.total; e.profit += s.profit;
      m.set(id, e);
    });
    return [...m.values()].sort((a, b) => b.revenue - a.revenue);
  }, [salesA]);

  const cashierRows = useMemo(() => {
    const m = new Map<string, { name: string; bills: number; revenue: number; profit: number }>();
    salesA.forEach(s => {
      const e = m.get(s.cashierId) || { name: s.cashierName, bills: 0, revenue: 0, profit: 0 };
      e.bills++; e.revenue += s.total; e.profit += s.profit;
      m.set(s.cashierId, e);
    });
    return [...m.values()].sort((a, b) => b.revenue - a.revenue);
  }, [salesA]);

  const csvCell = (value: unknown) => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const exportCsv = () => {
    const rows = [
      ['Bill No', 'Date', 'Customer', 'Cashier', 'Items', 'Payment', 'Status', 'Total', 'Profit'].map(csvCell).join(','),
      ...salesA.map(s => [
        s.billNo, new Date(s.date).toISOString(), s.customerName, s.cashierName,
        s.items.reduce((a, i) => a + i.qty, 0), s.payments && s.payments.length > 1 ? 'SPLIT' : s.payment,
        s.status, s.total.toFixed(2), s.profit.toFixed(2),
      ].map(csvCell).join(',')),
    ];
    downloadFile(`nexfix-sales-${dkey(from)}_to_${dkey(to)}.csv`, rows.join('\n'), 'text/csv');
  };

  const tipStyle = {
    background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12,
    fontSize: 12, color: 'var(--ink)', boxShadow: '0 8px 24px rgba(23,19,60,.12)',
  } as const;
  const fmtTip = (v: unknown) => fmtRs(Number(v ?? 0), false);

  const cards = [
    { label: 'Revenue', a: A.revenue, b: B.revenue, icon: Banknote, tint: 'from-emerald-400 to-teal-500' },
    { label: 'Gross Profit', a: A.profit, b: B.profit, icon: TrendingUp, tint: 'from-violet-500 to-purple-600' },
    { label: 'Bills', a: A.bills, b: B.bills, icon: ReceiptText, tint: 'from-sky-400 to-blue-600', plain: true },
    { label: 'Expenses', a: expA, b: expB, icon: CreditCard, tint: 'from-rose-400 to-pink-500' },
    { label: 'Net', a: netA, b: netB, icon: Wallet, tint: 'from-amber-400 to-orange-500' },
    { label: 'Average bill', a: A.bills ? A.revenue / A.bills : 0, b: B.bills ? B.revenue / B.bills : 0, icon: ReceiptText, tint: 'from-cyan-400 to-sky-500' },
  ];

  const rangeText = `${dkey(from)} → ${dkey(to)}`;
  const compareText = compareRange ? `${dkey(compareRange[0])} → ${dkey(compareRange[1])}` : '';
  const compareLabel = compareMode === 'previous' ? 'Previous period' : compareMode === 'lastmonth' ? 'Same period last month' : compareMode === 'lastyear' ? 'Same period last year' : 'Custom range';
  const customRangeError = period === 'custom' && custom.from > custom.to;
  const customCompareError = compareMode === 'custom' && compareFrom && compareTo && compareFrom > compareTo;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <Badge tone="violet" className="uppercase mb-2"><BarChart3 size={11} /> Analytics</Badge>
          <h1 className="text-[26px] sm:text-3xl font-extrabold text-ink tracking-tight">Reports &amp; Analytics</h1>
          <p className="text-sm text-sub mt-1">Sales, profit, inventory insights with date picker</p>
        </div>
        <button className="btn btn-outline-emerald bg-surface" onClick={exportCsv}>
          <Download size={15} /> Export CSV
        </button>
      </div>

      {/* ============ machine performance ============ */}
      <div className={machineRows.length > 0 ? 'card p-5 mb-6' : 'card px-5 py-3 mb-6'}>
        {machineRows.length === 0 ? (
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="font-semibold text-ink">Machine Performance</span>
            <span className="text-xs text-faint">No machine sales in this period.</span>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-base font-extrabold text-ink">Machine Performance</h2>
                <p className="text-xs text-sub mt-1">Sales, income and gross profit by POS terminal</p>
              </div>
              <Badge tone="blue">{machineRows.length} machine{machineRows.length === 1 ? '' : 's'}</Badge>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-sm">
                <thead><tr className="text-left text-[10px] uppercase tracking-wider text-faint border-b border-line">
                  <th className="py-2 pr-3">Machine</th><th className="py-2 pr-3">Bills</th><th className="py-2 pr-3">Sales / Income</th><th className="py-2">Gross Profit</th>
                </tr></thead>
                <tbody>{machineRows.map(row => (
                  <tr key={row.id} className="border-b border-line last:border-0">
                    <td className="py-3 pr-3"><div className="font-bold text-ink">{row.name}</div><div className="text-[10px] text-faint num">{row.id}</div></td>
                    <td className="py-3 pr-3 num">{fmtNum(row.bills)}</td>
                    <td className="py-3 pr-3 num font-semibold">{fmtRs(row.revenue)}</td>
                    <td className="py-3 num font-semibold text-emerald-600">{fmtRs(row.profit)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* ============ date filter + compare panel ============ */}
      <div className="card p-5 mb-6">
        {/* primary quick tabs */}
        <span className="block text-[10px] font-extrabold tracking-[0.14em] text-faint uppercase mb-2.5 flex items-center gap-1.5">
          <CalendarDays size={12} /> Quick Period
        </span>
        <div className="inline-flex flex-wrap gap-1 bg-raised border border-line rounded-2xl p-1 mb-3">
          {PRIMARY.map(q => (
            <button
              key={q.key}
              onClick={() => setPeriod(q.key)}
              className={`px-4 sm:px-5 py-2 rounded-xl text-[13px] font-bold transition-all ${
                period === q.key ? 'bg-violet-600 text-white shadow-md shadow-violet-600/30' : 'text-sub hover:text-ink'
              }`}
            >
              {q.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {MORE.map(q => (
            <button
              key={q.key}
              onClick={() => setPeriod(q.key)}
              className={`px-3.5 py-1.5 rounded-xl text-[12px] font-semibold transition-all border ${
                period === q.key ? 'bg-violet-600 text-white border-violet-600 shadow-md shadow-violet-600/25' : 'bg-raised text-sub border-line hover:text-ink'
              }`}
            >
              {q.label}
            </button>
          ))}
        </div>

        {period === 'custom' && (
          <div className="flex flex-wrap items-end gap-3 mt-4">
            <div>
              <span className="block text-[10px] font-bold tracking-wider uppercase text-sub mb-1.5">From</span>
              <DatePicker value={custom.from} onChange={v => v && setCustom(c => ({ ...c, from: v }))} />
            </div>
            <ArrowRight size={15} className="text-faint mb-3" />
            <div>
              <span className="block text-[10px] font-bold tracking-wider uppercase text-sub mb-1.5">To</span>
              <DatePicker value={custom.to} onChange={v => v && setCustom(c => ({ ...c, to: v }))} />
            </div>
            {customRangeError && <p className="w-full text-[11px] text-rose-600">From date is after To date; the displayed range is normalized.</p>}
          </div>
        )}

        {/* compare with */}
        <div className="mt-5 pt-4 border-t border-line">
          <span className="block text-[10px] font-extrabold tracking-[0.14em] text-faint uppercase mb-2.5 flex items-center gap-1.5">
            <GitCompareArrows size={12} /> Compare With
          </span>
          {period === 'all' ? (
            <p className="text-[11.5px] text-faint">Comparison is disabled for All Time because it has no fixed duration.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {([
                  { k: 'none', label: 'Off' },
                  { k: 'previous', label: 'Previous period' },
                  { k: 'lastmonth', label: 'Same period last month' },
                  { k: 'lastyear', label: 'Same period last year' },
                  { k: 'custom', label: 'Custom range' },
                ] as { k: CompareMode; label: string }[]).map(o => (
                  <button key={o.k} onClick={() => setCompareMode(o.k)}
                    className={`px-3.5 py-1.5 rounded-xl text-[12px] font-semibold transition-all border ${compareMode === o.k ? 'bg-sky-500 text-white border-sky-500 shadow-md shadow-sky-500/25' : 'bg-raised text-sub border-line hover:text-ink'}`}>
                    {o.label}
                  </button>
                ))}
              </div>
              {compareMode === 'custom' && (
                <div className="flex flex-wrap items-end gap-3 mt-3.5">
                  <div><span className="block text-[10px] font-bold tracking-wider uppercase text-sub mb-1.5">Compare from</span><DatePicker value={compareFrom} onChange={setCompareFrom} label="mm/dd/yyyy" /></div>
                  <ArrowRight size={15} className="text-faint mb-3" />
                  <div><span className="block text-[10px] font-bold tracking-wider uppercase text-sub mb-1.5">Compare to</span><DatePicker value={compareTo} onChange={setCompareTo} label="mm/dd/yyyy" /></div>
                  {customCompareError && <p className="w-full text-[11px] text-rose-600">Compare From is after Compare To; the range is normalized.</p>}
                </div>
              )}
            </>
          )}

          {/* showing strip */}
          <div className="sticky top-0 z-20 -mx-5 px-5 py-3 mt-4 border-y border-line bg-surface/95 backdrop-blur text-[12px]">
            <div className="flex flex-wrap gap-x-6 gap-y-1.5">
              <span><b className="text-violet-600">A:</b> {quickLabel(period)} · <span className="num">{rangeText}</span> · {durationA} day{durationA === 1 ? '' : 's'}</span>
              {compareRange && <span><b className="text-sky-600">B:</b> {compareLabel} · <span className="num">{compareText}</span> · {durationB} day{durationB === 1 ? '' : 's'}</span>}
            </div>
          </div>
        </div>
      </div>

      {/* ============ empty / data ============ */}
      {salesA.length === 0 ? (
        <div className="card mb-6">
          <EmptyState
            icon={<CalendarX2 size={26} />}
            title="No data available for the selected period"
            sub="Try another quick filter, or pick a different range — sales will appear here as soon as they exist in this window."
          />
        </div>
      ) : null}

      {/* KPI cards with comparison deltas */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 mb-5">
        {cards.map(c => {
          const d = comparing && c.b !== null ? delta(c.a, c.b) : null;
          const absoluteDiff = comparing && c.b !== null ? diff(c.a, c.b) : null;
          return (
            <div key={c.label} className="card p-5">
              <div className="flex items-start justify-between">
                <div className="kpi-label text-sub">{c.label}</div>
                <span className={`w-9 h-9 rounded-xl bg-gradient-to-br ${c.tint} text-white flex items-center justify-center shadow-md`}>
                  <c.icon size={16} />
                </span>
              </div>
              <div className="num text-[22px] font-extrabold text-ink mt-2">
                {c.plain ? fmtNum(c.a) : fmtRs(c.a)}
              </div>
              {comparing && c.b !== null && (
                <div className="mt-1.5">
                  <div className="text-[9px] uppercase tracking-wider text-faint font-bold">Period B</div>
                  <div className="num text-[18px] font-extrabold text-sky-600">{c.plain ? fmtNum(c.b) : fmtRs(c.b)}</div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1">
                    <Badge tone={d === null ? 'slate' : d > 0 ? 'emerald' : d < 0 ? 'rose' : 'slate'} className="num !text-[10px]">{d === null ? 'N/A' : <>{d > 0 ? <ArrowUpRight size={10} /> : d < 0 ? <ArrowDownRight size={10} /> : <Minus size={10} />}{d > 0 ? '+' : ''}{d}%</>}</Badge>
                    <span className="text-[10.5px] text-faint num">Δ {c.plain ? fmtNum(absoluteDiff!) : fmtRs(absoluteDiff!, false)}</span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* side-by-side period summary */}
      {comparing && (
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-3 items-stretch mb-5">
          <PeriodCard
            dot="bg-violet-500" name={`${quickLabel(period)} · selected`} range={rangeText}
            revenue={A.revenue} profit={A.profit} bills={A.bills} tone="violet"
            empty={salesA.length === 0}
          />
          <div className="hidden md:flex flex-col items-center justify-center px-2">
            <span className="w-9 h-9 rounded-xl bg-raised border border-line flex items-center justify-center text-faint"><GitCompareArrows size={16} /></span>
            {(() => {
              const d = delta(A.revenue, B.revenue);
              return <Badge tone={d === null ? 'slate' : d >= 0 ? 'emerald' : 'rose'} className="num mt-2">
                {d === null ? 'N/A' : `${d >= 0 ? '+' : ''}${d}%`}
              </Badge>;
            })()}
          </div>
          <PeriodCard
            dot="bg-sky-500" name={compareMode === 'previous' ? 'Previous period' : 'Custom period'} range={compareText}
            revenue={B.revenue} profit={B.profit} bills={B.bills} tone="blue"
            empty={salesB.length === 0}
          />
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5 mb-5">
        {/* revenue trend */}
        <div className="card p-5 xl:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
            <h3 className="font-bold text-ink">Daily Comparison</h3>
            <div className="flex items-center gap-3 text-[10.5px] font-semibold text-sub">
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-violet-500" /> Revenue</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" /> Profit</span>
              {comparing && <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-sky-400" /> Compare dashed</span>}
            </div>
          </div>
          <div className="flex gap-2 mb-2"><button onClick={() => setChartMetric('revenue')} className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border ${chartMetric === 'revenue' ? 'bg-violet-600 text-white border-violet-600' : 'bg-raised text-sub border-line'}`}>Revenue</button><button onClick={() => setChartMetric('profit')} className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border ${chartMetric === 'profit' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-raised text-sub border-line'}`}>Profit</button></div><p className="text-xs text-faint mb-4">Daily performance across selected period</p>
          {salesA.length === 0 ? (
            <p className="text-sm text-faint text-center py-20">No data available for the selected period</p>
          ) : (
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={daily} margin={{ left: 4, right: 8, top: 4 }}>
                  <defs>
                    <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="pro" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 6" stroke="rgba(130,135,170,0.22)" vertical={false} />
                  <XAxis dataKey="d" tick={{ fontSize: 10, fill: '#9397b8' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 10, fill: '#9397b8' }} tickLine={false} axisLine={false} width={54}
                    tickFormatter={v => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
                  <Tooltip contentStyle={tipStyle} formatter={fmtTip} />
                  {comparing && (
                    <Area type="monotone" dataKey={chartMetric === 'revenue' ? 'compareRevenue' : 'compareProfit'} stroke="#38bdf8" strokeWidth={2} strokeDasharray="6 4" fill="transparent" name={`B ${chartMetric === 'revenue' ? 'Revenue' : 'Profit'}`} />
                  )}
                  <Area type="monotone" dataKey={chartMetric} stroke={chartMetric === 'revenue' ? '#8b5cf6' : '#10b981'} strokeWidth={2.4} fill={chartMetric === 'revenue' ? 'url(#rev)' : 'url(#pro)'} name={`A ${chartMetric === 'revenue' ? 'Revenue' : 'Profit'}`} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* payment split */}
        <div className="card p-5">
          <h3 className="font-bold text-ink mb-1">Payment Methods</h3>
          <p className="text-xs text-faint mb-2">Share of revenue · selected period</p>
          {paySplit.length === 0 ? (
            <p className="text-sm text-faint text-center py-16">No data available for the selected period</p>
          ) : (
            <>
              <div className="h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={paySplit} dataKey="value" nameKey="name" innerRadius={52} outerRadius={78} paddingAngle={3} strokeWidth={0}>
                      {paySplit.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={tipStyle} formatter={fmtTip} />
                    <Legend iconSize={8} formatter={(v: string) => <span style={{ fontSize: 11, color: '#9397b8' }}>{v}</span>} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="space-y-1.5 mt-2">
                {paySplit.map((p, i) => {
                  const Icon = PAY_ICON[p.name.toLowerCase()] || Bank;
                  return (
                    <div key={p.name} className="flex items-center justify-between text-[12px]">
                      <span className="flex items-center gap-2 text-sub font-medium">
                        <span className="w-2 h-2 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                        <Icon size={12} className="text-faint" /> {p.name}
                      </span>
                      <span className="num font-bold text-ink">{fmtRs(p.value, false)}</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {comparing && (
        <div className="card p-5 mb-5 overflow-x-auto">
          <h3 className="font-bold text-ink mb-3">Period Comparison</h3>
          <table className="w-full min-w-[680px] text-sm"><thead><tr className="text-left text-[10px] uppercase tracking-wider text-faint border-b border-line"><th className="py-2">Metric</th><th className="py-2">Period A</th><th className="py-2">Period B</th><th className="py-2">Diff</th><th className="py-2">%</th></tr></thead>
            <tbody>{[['Revenue',A.revenue,B.revenue],['Profit',A.profit,B.profit],['Bills',A.bills,B.bills],['Expenses',expA,expB],['Net',netA,netB],['Avg bill',A.bills?A.revenue/A.bills:0,B.bills?B.revenue/B.bills:0]].map(([label,a,b]) => <tr key={label as string} className="border-b border-line last:border-0"><td className="py-2.5 font-semibold">{label as string}</td><td className="py-2.5 num">{label === 'Bills' ? fmtNum(a as number) : fmtRs(a as number,false)}</td><td className="py-2.5 num">{label === 'Bills' ? fmtNum(b as number) : fmtRs(b as number,false)}</td><td className="py-2.5 num">{fmtRs(diff(a as number,b as number),false)}</td><td className="py-2.5 num">{delta(a as number,b as number) === null ? 'N/A' : delta(a as number,b as number)+'%'}</td></tr>)}</tbody>
          </table>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        {/* top products */}
        <div className="card p-5 xl:col-span-2">
          <h3 className="font-bold text-ink mb-1 flex items-center gap-2"><Trophy size={15} className="text-amber-500" /> Top Selling Products</h3>
          <p className="text-xs text-faint mb-4">By revenue in selected period</p>
          {topProducts.length === 0 ? (
            <p className="text-sm text-faint text-center py-12">No data available for the selected period</p>
          ) : (
            <div className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topProducts} layout="vertical" margin={{ left: 4, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 6" stroke="rgba(130,135,170,0.22)" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10, fill: '#9397b8' }} tickLine={false} axisLine={false}
                    tickFormatter={v => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
                  <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11, fill: '#9397b8' }} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tipStyle} formatter={fmtTip} />
                  <Bar dataKey="revenue" fill="#8b5cf6" radius={[0, 8, 8, 0]} barSize={18} name="Revenue" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* cashier performance */}
        <div className="card overflow-hidden">
          <div className="px-5 pt-5 pb-3">
            <h3 className="font-bold text-ink">Cashier Performance</h3>
            <p className="text-xs text-faint mt-0.5">Selected period</p>
          </div>
          <table className="w-full">
            <thead>
              <tr><th className="th">Cashier</th><th className="th">Bills</th><th className="th !text-right">Revenue</th></tr>
            </thead>
            <tbody>
              {cashierRows.map((c, i) => (
                <tr key={c.name} className="hover:bg-raised/40">
                  <td className="td">
                    <span className="inline-flex items-center gap-2">
                      <Avatar name={c.name} size={26} />
                      <span className="text-[13px] font-semibold">{c.name}</span>
                      {i === 0 && <Badge tone="amber">TOP</Badge>}
                    </span>
                  </td>
                  <td className="td num">{c.bills}</td>
                  <td className="td num font-bold text-right">{fmtRs(c.revenue, false)}</td>
                </tr>
              ))}
              {cashierRows.length === 0 && (
                <tr><td className="td text-center text-faint" colSpan={3}>No sales in period</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function PeriodCard({ dot, name, range, revenue, profit, bills, tone, empty }: {
  dot: string; name: string; range: string; revenue: number; profit: number; bills: number;
  tone: 'violet' | 'blue'; empty: boolean;
}) {
  return (
    <div className={`card p-5 border-l-4 ${tone === 'violet' ? '!border-l-violet-500' : '!border-l-sky-500'}`}>
      <div className="flex items-center gap-2 mb-3">
        <span className={`w-2 h-2 rounded-full ${dot}`} />
        <span className="text-[13px] font-bold text-ink">{name}</span>
        <span className="text-[11px] text-faint num ml-auto">{range}</span>
      </div>
      {empty ? (
        <p className="text-[13px] text-faint py-3 text-center">No data available for this period</p>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {[
            ['Revenue', fmtRs(revenue, false)],
            ['Profit', fmtRs(profit, false)],
            ['Bills', fmtNum(bills)],
          ].map(([l, v]) => (
            <div key={l as string}>
              <div className="text-[9.5px] font-extrabold tracking-wider uppercase text-faint">{l}</div>
              <div className="num text-[15px] font-extrabold text-ink mt-0.5">{v}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
