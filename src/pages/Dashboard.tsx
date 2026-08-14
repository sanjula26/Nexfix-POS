import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toPng } from 'html-to-image';
import {
  Hand, DollarSign, TrendingUp, Package, Users, Calendar, ShoppingCart, ImageDown,
  AlertTriangle, ArrowRight, Boxes, Activity, CheckCircle2, Loader2, Wallet,
} from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, Avatar } from '../components/ui';
import { fmtRs, fmtNum, fmtDateTime, inRange, periodRange, startOfDay, salePayments, salePaymentLabel } from '../lib/utils';

export default function Dashboard() {
  const { state, user, can } = usePOS();
  const navigate = useNavigate();
  const snapRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);

  const active = useMemo(() => state.products.filter(p => p.active), [state.products]);
  const completed = useMemo(() => state.sales.filter(s => s.status !== 'refunded'), [state.sales]);

  const sum = (range: [Date, Date]) => {
    const rows = completed.filter(s => inRange(s.date, range));
    const revenue = rows.reduce((a, s) => a + s.total, 0);
    const profit = rows.reduce((a, s) => a + s.profit, 0);
    return { bills: rows.length, revenue, profit };
  };
  const expSum = (range: [Date, Date]) => state.expenses.filter(e => inRange(e.date, range)).reduce((a, e) => a + e.amount, 0);

  const today = sum(periodRange('today'));
  const week = sum(periodRange('week'));
  const month = sum(periodRange('month'));
  const todayExp = expSum(periodRange('today'));
  const monthExp = expSum(periodRange('month'));

  const units = active.reduce((a, p) => a + p.stock, 0);
  const stockValue = active.reduce((a, p) => a + p.stock * p.cost, 0);
  const lowStock = active.filter(p => p.stock <= p.reorderLevel).sort((a, b) => a.stock - b.stock);
  const recent = [...completed].sort((a, b) => +new Date(b.date) - +new Date(a.date)).slice(0, 6);
  const openRepairs = (state.repairs || []).filter(r => r.status !== 'delivered' && r.status !== 'cancelled');
  const expiringUnits = (state.units || []).filter(u => {
    if (u.status !== 'in_stock' || !u.expiryDate) return false;
    const t = new Date(u.expiryDate).getTime();
    return t < Date.now() + 30 * 86400000;
  });
  const readyRepairs = openRepairs.filter(r => r.status === 'ready').length;

  const dateLabel = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

  const savePng = async () => {
    if (!snapRef.current || saving) return;
    setSaving(true);
    try {
      const url = await toPng(snapRef.current, { backgroundColor: '#f5f6fb', pixelRatio: 2 });
      const a = document.createElement('a');
      a.href = url;
      a.download = `nexfix-dashboard-${startOfDay(new Date()).toISOString().slice(0, 10)}.png`;
      a.click();
    } finally { setSaving(false); }
  };

  const kpis = [
    {
      label: "Today's Sales", live: true, value: fmtRs(today.revenue), sub: `${today.bills} bills processed`,
      icon: DollarSign, tint: 'from-emerald-400 to-teal-500', bg: 'from-emerald-50 to-teal-50/40 dark:from-emerald-500/10 dark:to-teal-500/5',
    },
    {
      label: "Today's Profit", value: can('act:viewCost') ? fmtRs(today.profit) : 'Rs. ••••••', sub: 'After cost of goods',
      icon: TrendingUp, tint: 'from-violet-500 to-purple-600', bg: 'from-violet-50 to-purple-50/40 dark:from-violet-500/10 dark:to-purple-500/5',
    },
    {
      label: 'Total Products', value: fmtNum(active.length), sub: `${fmtNum(units)} units in stock`,
      icon: Package, tint: 'from-sky-400 to-blue-600', bg: 'from-sky-50 to-blue-50/40 dark:from-sky-500/10 dark:to-blue-500/5',
    },
    {
      label: 'Customers', value: fmtNum(state.customers.length), sub: 'Registered customers',
      icon: Users, tint: 'from-amber-400 to-orange-500', bg: 'from-amber-50 to-orange-50/40 dark:from-amber-500/10 dark:to-orange-500/5',
    },
  ];

  const periods = [
    { name: 'Today', dot: 'bg-violet-500', ...sum(periodRange('today')), exp: expSum(periodRange('today')) },
    { name: 'This Week', dot: 'bg-sky-500', ...sum(periodRange('week')), exp: null },
    { name: 'This Month', dot: 'bg-emerald-500', ...sum(periodRange('month')), exp: expSum(periodRange('month')) },
  ];

  void todayExp; void monthExp; void Wallet;

  return (
    <div ref={snapRef} className="space-y-6">
      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Badge tone="violet" className="uppercase mb-2"><Activity size={11} /> Dashboard</Badge>
          <h1 className="font-display text-[28px] sm:text-[32px] font-extrabold text-ink tracking-tight flex items-center gap-2.5">
            Welcome back
            <span className="inline-flex w-9 h-9 rounded-xl bg-amber-400/15 items-center justify-center">
              <Hand size={20} className="text-amber-500" />
            </span>
          </h1>
          <p className="text-sm text-sub mt-1 flex items-center gap-1.5">
            <Calendar size={13} className="text-faint" /> {dateLabel}
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <button className="btn btn-outline-emerald bg-surface" onClick={savePng} disabled={saving}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <ImageDown size={15} />} Save PNG
          </button>
          <button className="btn btn-primary" onClick={() => navigate('/pos')}>
            <ShoppingCart size={15} /> Start New Sale <ArrowRight size={15} />
          </button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {kpis.map(k => (
          <div key={k.label} className={`card relative overflow-hidden p-5 bg-gradient-to-br ${k.bg} !border-transparent dark:!border-line`}>
            <div className="flex items-start justify-between">
              <div>
                <div className="kpi-label text-sub flex items-center gap-2">
                  {k.label}
                  {k.live && <span className="badge bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 !py-0.5 !px-2 !text-[9px]"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 blink" /> LIVE</span>}
                </div>
                <div className="num text-[26px] font-extrabold text-ink mt-2 tracking-tight">{k.value}</div>
                <div className="text-xs text-sub mt-1">{k.sub}</div>
              </div>
              <span className={`w-11 h-11 rounded-xl bg-gradient-to-br ${k.tint} text-white flex items-center justify-center shadow-lg shrink-0`}>
                <k.icon size={19} strokeWidth={2.2} />
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Phase 3 quick alerts */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <button type="button" className="card p-4 text-left hover:border-violet-500/40 transition-colors" onClick={() => navigate('/repairs')}>
          <div className="text-[11px] font-bold uppercase tracking-wider text-faint">Open repairs</div>
          <div className="num text-2xl font-extrabold text-ink mt-1">{openRepairs.length}</div>
          <div className="text-xs text-sub mt-0.5">{readyRepairs} ready for pickup</div>
        </button>
        <button type="button" className="card p-4 text-left hover:border-amber-500/40 transition-colors" onClick={() => navigate('/units')}>
          <div className="text-[11px] font-bold uppercase tracking-wider text-faint">Expiring units (30d)</div>
          <div className={`num text-2xl font-extrabold mt-1 ${expiringUnits.length ? 'text-amber-500' : 'text-ink'}`}>{expiringUnits.length}</div>
          <div className="text-xs text-sub mt-0.5">IMEI / serial with shelf life</div>
        </button>
        <button type="button" className="card p-4 text-left hover:border-rose-500/40 transition-colors" onClick={() => navigate('/inventory?low=1')}>
          <div className="text-[11px] font-bold uppercase tracking-wider text-faint">Low stock SKUs</div>
          <div className={`num text-2xl font-extrabold mt-1 ${lowStock.length ? 'text-rose-500' : 'text-ink'}`}>{lowStock.length}</div>
          <div className="text-xs text-sub mt-0.5">Below reorder level</div>
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        {/* period summary */}
        <div className="card xl:col-span-2 overflow-hidden">
          <div className="flex items-center justify-between px-6 pt-5 pb-3">
            <div>
              <h3 className="font-bold text-ink flex items-center gap-2"><Activity size={15} className="text-violet-500" /> Period Summary</h3>
              <p className="text-xs text-faint mt-0.5">All amounts in LKR (Rs.)</p>
            </div>
            <span className="text-[10px] font-bold tracking-[0.14em] text-faint">REAL-TIME</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px]">
              <thead>
                <tr>
                  <th className="th">Period</th><th className="th">Bills</th><th className="th">Revenue</th>
                  {can('act:viewCost') && <th className="th">Profit</th>}
                  <th className="th">Expenses</th><th className="th !text-right">Net</th>
                </tr>
              </thead>
              <tbody>
                {periods.map(p => (
                  <tr key={p.name} className="hover:bg-raised/40 transition-colors">
                    <td className="td font-semibold"><span className={`inline-block w-2 h-2 rounded-full ${p.dot} mr-2.5`} />{p.name}</td>
                    <td className="td num text-sub">{p.bills}</td>
                    <td className="td num font-semibold">{fmtRs(p.revenue)}</td>
                    {can('act:viewCost') && <td className="td num font-semibold text-emerald-600 dark:text-emerald-400">{fmtRs(p.profit)}</td>}
                    <td className="td num font-semibold text-rose-500">{p.exp === null ? '—' : fmtRs(p.exp)}</td>
                    <td className="td num font-bold text-right">{fmtRs(can('act:viewCost') ? p.profit - (p.exp ?? 0) : p.revenue - (p.exp ?? 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-6 pt-4">
            <div className="rounded-2xl bg-violet-500/[0.07] dark:bg-violet-500/10 border border-violet-500/10 p-5">
              <div className="kpi-label text-violet-500">Stock Value</div>
              <div className="num text-[22px] font-extrabold text-ink mt-1.5">{can('act:viewCost') ? fmtRs(stockValue) : 'Rs. ••••••'}</div>
            </div>
            <div className="rounded-2xl bg-sky-500/[0.07] dark:bg-sky-500/10 border border-sky-500/10 p-5">
              <div className="kpi-label text-sky-500">Total Units</div>
              <div className="num text-[22px] font-extrabold text-ink mt-1.5">{fmtNum(units)}</div>
            </div>
          </div>
        </div>

        {/* low stock */}
        <div className="card overflow-hidden flex flex-col">
          <div className="flex items-center justify-between px-6 pt-5 pb-3">
            <h3 className="font-bold text-ink flex items-center gap-2">
              <AlertTriangle size={15} className="text-amber-500" /> Low Stock
            </h3>
            <button className="text-xs font-bold text-violet-500 hover:text-violet-600" onClick={() => navigate('/inventory?low=1')}>View all</button>
          </div>
          {lowStock.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center py-10 text-center px-6">
              <span className="w-14 h-14 rounded-2xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center mb-4"><Boxes size={24} /></span>
              <p className="font-semibold text-ink">All products well stocked</p>
              <p className="text-xs text-faint mt-1 flex items-center gap-1">Nothing to worry about <CheckCircle2 size={12} className="text-emerald-500" /></p>
            </div>
          ) : (
            <div className="divide-y divide-line overflow-y-auto max-h-[380px]">
              {lowStock.slice(0, 8).map(p => (
                <div key={p.id} className="flex items-center gap-3 px-6 py-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-ink truncate">{p.name}</div>
                    <div className="text-[11px] text-faint">{p.sku}</div>
                  </div>
                  <Badge tone={p.stock === 0 ? 'rose' : 'amber'}>
                    {p.stock === 0 ? 'OUT' : `${p.stock} left`}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* recent sales */}
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <div>
            <h3 className="font-bold text-ink flex items-center gap-2"><ShoppingCart size={15} className="text-violet-500" /> Recent Sales</h3>
            <p className="text-xs text-faint mt-0.5">Latest transactions across the shop</p>
          </div>
          <button className="text-xs font-bold text-violet-500 hover:text-violet-600 flex items-center gap-1" onClick={() => navigate('/sales')}>
            View all <ArrowRight size={13} />
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr>
                <th className="th">Bill #</th><th className="th">Date</th><th className="th">Cashier</th>
                <th className="th">Customer</th><th className="th">Payment</th><th className="th !text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {recent.map(s => (
                <tr key={s.id} className="hover:bg-raised/40 transition-colors cursor-pointer" onClick={() => navigate('/sales')}>
                  <td className="td font-bold text-violet-600 dark:text-violet-400">{s.billNo}</td>
                  <td className="td text-sub text-[13px]">{fmtDateTime(s.date)}</td>
                  <td className="td">
                    <span className="inline-flex items-center gap-2"><Avatar name={s.cashierName} size={24} /><span className="text-[13px] font-medium">{s.cashierName}</span></span>
                  </td>
                  <td className="td text-[13px] text-sub">{s.customerName}</td>
                  <td className="td"><Badge tone={s.payments && s.payments.length > 1 ? 'violet' : s.payment === 'cash' ? 'emerald' : s.payment === 'card' ? 'blue' : s.payment === 'credit' ? 'amber' : 'violet'}>{salePaymentLabel(s)}</Badge></td>
                  <td className="td num font-bold text-right">{fmtRs(s.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
