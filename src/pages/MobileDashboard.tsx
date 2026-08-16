import { useMemo } from 'react';
import { usePOS } from '../lib/store';

const money = (n: number) => new Intl.NumberFormat('en-LK', { style: 'currency', currency: 'LKR', maximumFractionDigits: 0 }).format(n);

export default function MobileDashboard() {
  const { sales, products, expenses } = usePOS();
  const today = new Date().toISOString().slice(0, 10);
  const todaySales = useMemo(() => sales.filter(s => s.date.slice(0, 10) === today && s.status === 'completed'), [sales, today]);
  const revenue = todaySales.reduce((sum, s) => sum + s.total, 0);
  const profit = todaySales.reduce((sum, s) => sum + s.profit, 0);
  const expensesToday = expenses.filter(e => e.date.slice(0, 10) === today).reduce((sum, e) => sum + e.amount, 0);
  const lowStock = products.filter(p => p.active && p.stock <= p.reorderLevel).length;

  const machines = useMemo(() => {
    const map = new Map<string, { name: string; bills: number; revenue: number; profit: number }>();
    for (const sale of todaySales) {
      const id = sale.machineId || 'legacy';
      const current = map.get(id) || { name: sale.machineName || 'Unassigned', bills: 0, revenue: 0, profit: 0 };
      current.bills += 1; current.revenue += sale.total; current.profit += sale.profit;
      map.set(id, current);
    }
    return [...map.values()].sort((a, b) => b.revenue - a.revenue);
  }, [todaySales]);

  return <main className="min-h-screen bg-slate-50 p-4 sm:p-6">
    <div className="mx-auto max-w-5xl space-y-4">
      <header><h1 className="text-2xl font-bold text-slate-900">Mobile Dashboard</h1><p className="text-sm text-slate-500">Today at a glance</p></header>
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[['Sales', money(revenue)], ['Profit', money(profit)], ['Expenses', money(expensesToday)], ['Low stock', String(lowStock)]].map(([label, value]) => <article key={label} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-lg font-bold text-slate-900">{value}</p></article>)}
      </section>
      <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"><h2 className="font-semibold text-slate-900">Machine performance</h2><div className="mt-3 space-y-2">{machines.length ? machines.map((m) => <div key={m.name} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 p-3"><div><p className="font-medium">{m.name}</p><p className="text-xs text-slate-500">{m.bills} bills</p></div><div className="text-right"><p className="font-semibold">{money(m.revenue)}</p><p className="text-xs text-slate-500">Profit {money(m.profit)}</p></div></div>) : <p className="text-sm text-slate-500">No sales today.</p>}</div></section>
      <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"><h2 className="font-semibold text-slate-900">Recent bills</h2><div className="mt-3 space-y-2">{todaySales.slice(-8).reverse().map(s => <div key={s.id} className="flex justify-between border-b border-slate-100 py-2 text-sm"><span>{s.billNo}</span><span className="font-medium">{money(s.total)}</span></div>)}{!todaySales.length && <p className="text-sm text-slate-500">No bills today.</p>}</div></section>
    </div>
  </main>;
}
