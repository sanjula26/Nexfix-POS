import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePOS } from '../lib/store';
import { getMachineIdentity } from '../lib/machine';

const money = (n: number) => new Intl.NumberFormat('en-LK', { style: 'currency', currency: 'LKR', maximumFractionDigits: 0 }).format(n);
const localDateKey = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

type Period = 1 | 7 | 30;

export default function MobileDashboard() {
  const { state, can } = usePOS();
  const { sales, products, expenses } = state;
  const [period, setPeriod] = useState<Period>(1);
  const [machineFilter, setMachineFilter] = useState('all');
  const today = localDateKey();
  const rangeStart = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (period - 1));
    return localDateKey(start);
  }, [period]);
  const inRange = (value: string) => {
    const day = value.slice(0, 10);
    return day >= rangeStart && day <= today;
  };
  const rangeSales = useMemo(() => sales.filter(s => inRange(s.date) && s.status === 'completed'), [sales, rangeStart, today]);
  const machineOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const sale of rangeSales) {
      const id = sale.machineId || 'legacy';
      if (!map.has(id)) map.set(id, sale.machineName || 'Unassigned');
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rangeSales]);
  const filteredSales = useMemo(() => machineFilter === 'all' ? rangeSales : rangeSales.filter(s => (s.machineId || 'legacy') === machineFilter), [rangeSales, machineFilter]);
  const revenue = filteredSales.reduce((sum, s) => sum + s.total, 0);
  const profit = filteredSales.reduce((sum, s) => sum + s.profit, 0);
  const expensesInRange = expenses.filter(e => inRange(e.date)).reduce((sum, e) => sum + e.amount, 0);
  const lowStock = products.filter(p => p.active && p.stock <= p.reorderLevel).length;
  const machine = getMachineIdentity();
  const canViewProfit = can('act:viewCost');

  const machines = useMemo(() => {
    const map = new Map<string, { id: string; name: string; bills: number; revenue: number; profit: number }>();
    for (const sale of filteredSales) {
      const id = sale.machineId || 'legacy';
      const current = map.get(id) || { id, name: sale.machineName || 'Unassigned', bills: 0, revenue: 0, profit: 0 };
      current.bills += 1;
      current.revenue += sale.total;
      current.profit += sale.profit;
      map.set(id, current);
    }
    return [...map.values()].sort((a, b) => b.revenue - a.revenue);
  }, [filteredSales]);

  // If a selected machine disappears after changing the period, reset to All Machines.
  const effectiveMachineFilter = machineFilter === 'all' || machineOptions.some(([id]) => id === machineFilter) ? machineFilter : 'all';
  const displaySales = effectiveMachineFilter === machineFilter ? filteredSales : rangeSales;
  const displayRevenue = displaySales.reduce((sum, s) => sum + s.total, 0);
  const displayProfit = displaySales.reduce((sum, s) => sum + s.profit, 0);

  return <main className="min-h-screen bg-slate-50 p-4 pb-8 sm:p-6">
    <div className="mx-auto max-w-5xl space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div><h1 className="text-2xl font-bold text-slate-900">Mobile Dashboard</h1><p className="text-sm text-slate-500">Business performance</p></div>
        <Link to="/" className="shrink-0 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">Desktop</Link>
      </header>
      <div className="rounded-xl bg-violet-50 px-3 py-2 text-xs text-violet-800 ring-1 ring-violet-100">Terminal: <span className="font-semibold">{machine.name}</span><span className="ml-1 text-violet-600">({machine.id})</span></div>
      <section className="grid gap-3 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200 sm:grid-cols-2">
        <label className="block text-xs font-medium text-slate-500">Performance period<select value={period} onChange={e => setPeriod(Number(e.target.value) as Period)} className="mt-1 w-full rounded-xl border-0 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-800 ring-1 ring-slate-200 focus:ring-2 focus:ring-violet-500"><option value={1}>Today</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option></select></label>
        <label className="block text-xs font-medium text-slate-500">Machine<select value={effectiveMachineFilter} onChange={e => setMachineFilter(e.target.value)} className="mt-1 w-full rounded-xl border-0 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-800 ring-1 ring-slate-200 focus:ring-2 focus:ring-violet-500"><option value="all">All Machines</option>{machineOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
      </section>
      <nav aria-label="Quick actions" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {can('page:pos') && <Link to="/pos" className="rounded-xl bg-violet-600 px-3 py-3 text-center text-sm font-semibold text-white shadow-sm active:scale-[0.98]">New Sale</Link>}
        {can('page:sales') && <Link to="/sales" className="rounded-xl bg-white px-3 py-3 text-center text-sm font-semibold text-slate-800 ring-1 ring-slate-200 active:scale-[0.98]">Sales</Link>}
        {can('page:reports') && <Link to="/reports" className="rounded-xl bg-white px-3 py-3 text-center text-sm font-semibold text-slate-800 ring-1 ring-slate-200 active:scale-[0.98]">Reports</Link>}
        {can('page:inventory') && <Link to="/inventory" className="rounded-xl bg-white px-3 py-3 text-center text-sm font-semibold text-slate-800 ring-1 ring-slate-200 active:scale-[0.98]">Inventory</Link>}
      </nav>
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[['Sales', money(displayRevenue)], ...(canViewProfit ? [['Profit', money(displayProfit)] as const] : []), ['Expenses', money(expensesInRange)], ['Low stock', String(lowStock)]].map(([label, value]) => <article key={label} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-lg font-bold text-slate-900">{value}</p></article>)}
      </section>
      <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"><h2 className="font-semibold text-slate-900">Machine performance</h2><div className="mt-3 space-y-2">{machines.length ? machines.map((m) => <div key={m.id} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 p-3"><div><p className="font-medium">{m.name}</p><p className="text-xs text-slate-500">{m.bills} bills</p></div><div className="text-right"><p className="font-semibold">{money(m.revenue)}</p>{canViewProfit && <p className="text-xs text-slate-500">Profit {money(m.profit)}</p>}</div></div>) : <p className="text-sm text-slate-500">No sales in this period.</p>}</div></section>
      <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"><h2 className="font-semibold text-slate-900">Recent bills</h2><div className="mt-3 space-y-2">{displaySales.slice(-8).reverse().map(s => <div key={s.id} className="flex justify-between border-b border-slate-100 py-2 text-sm"><span>{s.billNo}</span><span className="font-medium">{money(s.total)}</span></div>)}{!displaySales.length && <p className="text-sm text-slate-500">No bills in this period.</p>}</div></section>
    </div>
  </main>;
}
