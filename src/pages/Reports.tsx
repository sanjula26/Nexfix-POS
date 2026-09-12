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
import DatePicker, { toISO } from '../components/DatePicker';
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

type CompareMode = 'none' | 'previous' | 'custom';

const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

export default function Reports() {
  const { state } = usePOS();
  const [period, setPeriod] = useState<PeriodKey>('week');
  const [custom, setCustom] = useState({ from: dkey(new Date(Date.now() - 6 * 86400000)), to: dkey(new Date()) });
  const [compareMode, setCompareMode] = useState<CompareMode>('previous');
  const [compareFrom, setCompareFrom] = useState('');

  const [from, to] = useMemo(() => periodRange(period, custom), [period, custom]);
  const spanMs = to.getTime() - from.getTime();

  const compareRange = useMemo((): [Date, Date] | null => {
    if (compareMode === 'none') return null;
    if (compareMode === 'previous') return [new Date(from.getTime() - spanMs - 1), new Date(from.getTime() - 1)];
    if (!compareFrom) return null;
    const cf = new Date(compareFrom + 'T00:00:00');
    return [cf, endOfDay(new Date(cf.getTime() + spanMs - 1000 * 60))];
  }, [compareMode, compareFrom, from, spanMs]);

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
  const expenses = state.expenses.filter(e => inRange(e.date, [from, to]));

  const kpi = (rows: typeof salesA) => ({
    revenue: rows.reduce((a, s) => a + s.total, 0),
    profit: rows.reduce((a, s) => a + s.profit, 0),
    bills: rows.length,
  });
  const A = kpi(salesA);
  const B = kpi(salesB);
  const exp = expenses.reduce((a, e) => a + e.amount, 0);
  const netA = A.profit - exp;

  const comparing = compareRange !== null;
  const delta = (a: number, b: number) => (b === 0 ? (a > 0 ? 100 : 0) : Math.round(((a - b) / b) * 100));

  /* daily series — compare column aligned by day offset */
  const daily = useMemo(() => {
    const days = Math.max(1, Math.min(62, Math.ceil(spanMs / 86400000)));
    const out: { d: string; revenue: number; profit: number; compare: number | null }[] = [];
    for (let i = 0; i < days; i++) {
      const day = new Date(from.getTime() + i * 86400000);
      if (day.getTime() > Date.now() + 43200000) break;
      const key = dkey(day);
      const rows = salesA.filter(s => dkey(s.date) === key);
      let cmp: number | null = null;
      if (compareRange) {
        const cday = new Date(compareRange[0].getTime() + i * 86400000);
        if (cday <= compareRange[1]) {
          const ckey = dkey(cday);
          cmp = salesB.filter(s => dkey(s.date) === ckey).reduce((a, s) => a + s.total, 0);
        }
      }
      out.push({
        d: day.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
        revenue: rows.reduce((a, s) => a + s.total, 0),
        profit: rows.reduce((a, s) => a + s.profit, 0),
        compare: cmp,
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
    { label: 'Net (after expenses)', a: netA, b: null as number | null, icon: Wallet, tint: 'from-amber-400 to-orange-500' },
  ];

  const rangeText = `${dkey(from)} → ${dkey(to)}`;
  const compareText = compareRange ? `${dkey(compareRange[0])} → ${dkey(compareRange[1])}` : '';

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
      <div className="card p-5 mb-6">
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
          </div>
        )}

        {/* compare with */}
        <div className="mt-5 pt-4 border-t border-line">
          <span className="block text-[10px] font-extrabold tracking-[0.14em] text-faint uppercase mb-2 flex items-center gap-1.5">
            <GitCompareArrows size={12} /> Compare With
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {(['previous', 'none', 'custom'] as CompareMode[]).map(m => (
              <button key={m} onClick={() => setCompareMode(m)} className={`px-3 py-1.5 rounded-xl text-xs font-semibold border ${compareMode === m ? 'bg-sky-500 text-white border-sky-500' : 'bg-raised text-sub border-line'}`}>
                {m === 'previous' ? 'Previous Period' : m === 'none' ? 'No Compare' : 'Custom'}
              </button>
            ))}
            {compareMode === 'custom' && <DatePicker value={compareFrom} onChange={v => v && setCompareFrom(v)} />}
          </div>
          {comparing && <p className="text-[11px] text-sub mt-2">Current: {rangeText} · Compare: {compareText}</p>}
        </div>
      </div>

      {/* ============ KPI cards ============ */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-6">
        {cards.map(c => {
          const Icon = c.icon;
          const change = c.b == null ? null : delta(c.a, c.b);
          return <div key={c.label} className="card p-4">
            <div className="flex items-center justify-between gap-2"><span className="text-xs font-bold text-sub">{c.label}</span><Icon size={17} className="text-faint" /></div>
            <div className="text-xl font-extrabold text-ink num mt-2">{c.plain ? fmtNum(c.a) : fmtRs(c.a)}</div>
            {change !== null && <div className={`text-[11px] mt-1 font-bold ${change >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{change >= 0 ? <ArrowUpRight size={12} className="inline" /> : <ArrowDownRight size={12} className="inline" />} {Math.abs(change)}% vs previous</div>}
          </div>;
        })}
      </div>

      {/* ============ daily chart ============ */}
      <div className="card p-5 mb-6">
        <div className="flex items-center justify-between gap-3 mb-4"><div><h2 className="text-base font-extrabold text-ink">Daily Sales Trend</h2><p className="text-xs text-sub">Revenue and profit by day</p></div><Badge tone="violet">{rangeText}</Badge></div>
        {daily.length ? <div className="h-72"><ResponsiveContainer width="100%" height="100%"><AreaChart data={daily}><defs><linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.25}/><stop offset="95%" stopColor="#8b5cf6" stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="d"/><YAxis tickFormatter={v => fmtRs(Number(v), false)}/><Tooltip formatter={(v: unknown) => fmtTip(v)} contentStyle={tipStyle}/><Area type="monotone" dataKey="revenue" stroke="#8b5cf6" fill="url(#revenueFill)" name="Revenue"/><Area type="monotone" dataKey="profit" stroke="#10b981" fill="none" name="Profit"/>{comparing && <Area type="monotone" dataKey="compare" stroke="#38bdf8" fill="none" strokeDasharray="5 5" name="Compare"/>}</AreaChart></ResponsiveContainer></div> : <EmptyState icon={<CalendarX2 size={22}/>} title="No sales in this period" description="Choose another date range to view the sales trend."/>}
      </div>

      {/* ============ product + payment charts ============ */}
      <div className="grid xl:grid-cols-2 gap-6 mb-6">
        <div className="card p-5"><div className="flex items-center gap-2 mb-4"><Trophy size={17}/><div><h2 className="text-base font-extrabold text-ink">Top Products</h2><p className="text-xs text-sub">By sales revenue</p></div></div>{topProducts.length ? <div className="space-y-3">{topProducts.map((p, i) => <div key={p.name + i} className="flex items-center gap-3"><div className="w-7 h-7 rounded-lg bg-raised flex items-center justify-center text-xs font-extrabold">{i + 1}</div><div className="flex-1 min-w-0"><div className="text-sm font-bold truncate">{p.name}</div><div className="text-[11px] text-sub">{fmtNum(p.qty)} units</div></div><div className="text-sm font-extrabold num">{fmtRs(p.revenue)}</div></div>)}</div> : <EmptyState title="No product sales" description="No sold products for this period."/>}</div>
        <div className="card p-5"><h2 className="text-base font-extrabold text-ink">Payment Mix</h2><p className="text-xs text-sub mt-1">Collected sales by payment method</p>{paySplit.length ? <div className="h-64"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={paySplit} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={82} label>{paySplit.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]}/>)}</Pie><Tooltip formatter={(v: unknown) => fmtTip(v)} contentStyle={tipStyle}/><Legend/></PieChart></ResponsiveContainer></div> : <EmptyState title="No payment data" description="No sales for this period."/>}</div>
      </div>

      {/* ============ machine + cashier detail ============ */}
      <div className="grid xl:grid-cols-2 gap-6 mb-6">
        <div className="card p-5"><h2 className="text-base font-extrabold text-ink mb-4">Machine Performance Detail</h2><div className="overflow-x-auto"><table className="w-full min-w-[520px] text-sm"><thead><tr className="text-left text-[10px] uppercase text-faint border-b border-line"><th className="py-2">Machine</th><th className="py-2">Bills</th><th className="py-2">Revenue</th><th className="py-2">Profit</th></tr></thead><tbody>{machineRows.map(r => <tr key={r.id} className="border-b border-line last:border-0"><td className="py-3 font-bold">{r.name}</td><td className="py-3 num">{fmtNum(r.bills)}</td><td className="py-3 num">{fmtRs(r.revenue)}</td><td className="py-3 num text-emerald-600">{fmtRs(r.profit)}</td></tr>)}</tbody></table></div></div>
        <div className="card p-5"><h2 className="text-base font-extrabold text-ink mb-4">Cashier Performance</h2><div className="overflow-x-auto"><table className="w-full min-w-[520px] text-sm"><thead><tr className="text-left text-[10px] uppercase text-faint border-b border-line"><th className="py-2">Cashier</th><th className="py-2">Bills</th><th className="py-2">Revenue</th><th className="py-2">Profit</th></tr></thead><tbody>{cashierRows.map(r => <tr key={r.name} className="border-b border-line last:border-0"><td className="py-3 font-bold">{r.name}</td><td className="py-3 num">{fmtNum(r.bills)}</td><td className="py-3 num">{fmtRs(r.revenue)}</td><td className="py-3 num text-emerald-600">{fmtRs(r.profit)}</td></tr>)}</tbody></table></div></div>
      </div>

      {/* ============ sales detail ============ */}
      <div className="card p-5"><div className="flex items-center justify-between gap-3 mb-4"><div><h2 className="text-base font-extrabold text-ink">Sales Detail</h2><p className="text-xs text-sub">{fmtNum(salesA.length)} bills in selected period</p></div><Badge tone="emerald">{fmtRs(A.revenue)}</Badge></div><div className="overflow-x-auto"><table className="w-full min-w-[900px] text-sm"><thead><tr className="text-left text-[10px] uppercase tracking-wider text-faint border-b border-line"><th className="py-2">Bill No</th><th className="py-2">Date</th><th className="py-2">Customer</th><th className="py-2">Cashier</th><th className="py-2">Items</th><th className="py-2">Payment</th><th className="py-2">Status</th><th className="py-2 text-right">Total</th><th className="py-2 text-right">Profit</th></tr></thead><tbody>{salesA.map(s => <tr key={s.id} className="border-b border-line last:border-0"><td className="py-3 font-bold">{s.billNo}</td><td className="py-3 text-sub">{new Date(s.date).toLocaleString()}</td><td className="py-3">{s.customerName}</td><td className="py-3">{s.cashierName}</td><td className="py-3 num">{fmtNum(s.items.reduce((a, i) => a + i.qty, 0))}</td><td className="py-3">{s.payments && s.payments.length > 1 ? 'SPLIT' : s.payment}</td><td className="py-3">{s.status}</td><td className="py-3 text-right num font-semibold">{fmtRs(s.total)}</td><td className="py-3 text-right num text-emerald-600">{fmtRs(s.profit)}</td></tr>)}</tbody></table></div>{!salesA.length && <EmptyState title="No sales found" description="There are no sales matching the selected period."/>}</div>
    </div>
  );
}
