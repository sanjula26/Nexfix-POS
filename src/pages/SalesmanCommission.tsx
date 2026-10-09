import { useMemo, useState } from 'react';
import { Download, Users, CalendarDays } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, EmptyState, PageHeading } from '../components/ui';
import { dkey, downloadFile, fmtRs, fmtDate } from '../lib/utils';

type SalesmanSale = { id:string; billNo:string; date:string; status:string; salesmanId?:string; cashierId?:string; subtotal:number; discount:number; items?:Array<{ discount?:number }>; total:number; amountPaid:number; profit?:number; payment:string };
const num = (n: unknown) => Number.isFinite(Number(n)) ? Number(n) : 0;
const discountForSale = (sale: SalesmanSale) => num(sale.discount) + (sale.items || []).reduce((sum, item) => sum + num(item.discount), 0);
const csv = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export default function SalesmanCommission() {
  const { state, user } = usePOS();
  const [from, setFrom] = useState(dkey(new Date(Date.now()-29*86400000)));
  const [to, setTo] = useState(dkey(new Date()));
  const [salesman, setSalesman] = useState('all');
  const staff = useMemo(() => state.users.filter(u => u.active).slice().sort((a,b)=>a.name.localeCompare(b.name)), [state.users]);
  const rows = useMemo(() => (state.sales as SalesmanSale[])
    .filter(s => s.status === 'completed' || s.status === 'exchanged')
    .filter(s => dkey(s.date) >= from && dkey(s.date) <= to)
    .filter(s => salesman === 'all' ? Boolean(s.salesmanId || s.cashierId) : (s.salesmanId || s.cashierId) === salesman)
    .sort((a,b)=>b.date.localeCompare(a.date)), [state.sales, from, to, salesman]);
  const total = useMemo(() => rows.reduce((a,s)=>({
    bills:a.bills+1, gross:a.gross+num(s.subtotal), discounts:a.discounts+discountForSale(s),
    net:a.net+num(s.total), profit:a.profit+num(s.profit),
    credit:a.credit+Math.max(0,num(s.total)-num(s.amountPaid)), collected:a.collected+Math.min(Math.max(0,num(s.total)),num(s.amountPaid)),
  }), {bills:0,gross:0,discounts:0,net:0,profit:0,credit:0,collected:0}), [rows]);
  const selectedUser = staff.find(u=>u.id===salesman);
  const commissionPct = num(selectedUser?.commissionPct);
  const commission = rows.reduce((sum,s)=>sum+num(s.total)*num(staff.find(u=>u.id===(s.salesmanId || s.cashierId))?.commissionPct)/100,0);
  const exportCsv = () => {
    const data = [
      ['Bill no','Date','Salesman','Gross','Discount','Net','Profit','Credit due','Collected','Commission %','Commission'],
      ...rows.map(s=>[s.billNo,fmtDate(s.date),staff.find(u=>u.id===(s.salesmanId || s.cashierId))?.name||'Unassigned',num(s.subtotal),discountForSale(s),num(s.total),num(s.profit),Math.max(0,num(s.total)-num(s.amountPaid)),Math.min(Math.max(0,num(s.total)),num(s.amountPaid)),num(staff.find(u=>u.id===(s.salesmanId || s.cashierId))?.commissionPct),num(s.total)*num(staff.find(u=>u.id===(s.salesmanId || s.cashierId))?.commissionPct)/100])
    ];
    downloadFile(`nexfix-salesman-commission-${from}-to-${to}.csv`,data.map(row=>row.map(csv).join(',')).join('\n'),'text/csv;charset=utf-8');
  };
  return <div className="space-y-5">
    <PageHeading chip="Reports" chipTone="blue" title="Salesman Performance & Commission" sub="Read-only sales analytics grouped by the salesman recorded on each bill." actions={<button className="btn btn-primary" onClick={exportCsv} disabled={!rows.length}><Download size={15}/> Export CSV</button>}/>
    {user?.role !== 'admin' && <div className="rounded-xl border border-amber-400/40 bg-amber-400/10 p-3 text-sm">Report access follows the existing Reports permission. Commission rates are read from user settings and are not payroll calculations.</div>}
    <div className="card p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
      <label className="text-sm font-semibold">From date<input type="date" className="input mt-1" value={from} max={to} onChange={e=>setFrom(e.target.value)}/></label>
      <label className="text-sm font-semibold">To date<input type="date" className="input mt-1" value={to} min={from} onChange={e=>setTo(e.target.value)}/></label>
      <label className="text-sm font-semibold">Salesman<select className="input mt-1" value={salesman} onChange={e=>setSalesman(e.target.value)}><option value="all">All assigned salesmen</option>{staff.map(s=><option key={s.id} value={s.id}>{s.name} ({s.role})</option>)}</select></label>
    </div>
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {[['Bills',String(total.bills)],['Gross sales',fmtRs(total.gross)],['Discounts',fmtRs(total.discounts)],['Net sales',fmtRs(total.net)],['Profit (if recorded)',fmtRs(total.profit)],['Credit due created',fmtRs(total.credit)],['Paid at sale',fmtRs(total.collected)],['Estimated commission',fmtRs(commission)]].map(([label,value])=><div className="card p-4" key={label}><div className="text-xs text-sub">{label}</div><div className="text-xl font-extrabold num mt-1">{value}</div></div>)}
    </div>
    <div className="card overflow-hidden">
      <div className="p-4 border-b border-line flex items-center justify-between gap-3"><div><h2 className="font-bold">Sales bills</h2><p className="text-xs text-sub mt-1">{from} to {to} · {rows.length} bill(s)</p></div>{salesman!=='all' && <Badge tone="violet">{commissionPct}% commission rate</Badge>}</div>
      {rows.length ? <div className="overflow-x-auto"><table className="table w-full"><thead><tr><th className="th">Bill / Date</th><th className="th">Salesman</th><th className="th text-right">Gross</th><th className="th text-right">Discount</th><th className="th text-right">Net</th><th className="th text-right">Profit</th><th className="th text-right">Credit due</th><th className="th text-right">Paid</th><th className="th text-right">Commission</th></tr></thead><tbody>{rows.map(s=>{const staffer=staff.find(u=>u.id===(s.salesmanId || s.cashierId));const pct=num(staffer?.commissionPct);return <tr key={s.id}><td className="td"><div className="font-semibold">{s.billNo}</div><div className="text-xs text-sub">{fmtDate(s.date)}</div></td><td className="td">{staffer?.name||<span className="text-faint">Unassigned</span>}</td><td className="td text-right num">{fmtRs(num(s.subtotal))}</td><td className="td text-right num">{fmtRs(discountForSale(s))}</td><td className="td text-right font-semibold num">{fmtRs(num(s.total))}</td><td className="td text-right num">{fmtRs(num(s.profit))}</td><td className="td text-right num">{fmtRs(Math.max(0,num(s.total)-num(s.amountPaid)))}</td><td className="td text-right num">{fmtRs(Math.min(Math.max(0,num(s.total)),num(s.amountPaid)))}</td><td className="td text-right num">{pct?fmtRs(num(s.total)*pct/100):'—'}</td></tr>})}</tbody></table></div> : <div className="p-6"><EmptyState icon={<Users size={25}/>} title="No salesman bills in this range" sub="Check the date range or select another salesman. Bills without a recorded salesman ID are not assigned to a salesman."/></div>}
    </div>
    <p className="text-xs text-sub">Commission is an estimate calculated as bill net total × the selected user’s commission percentage. A 0% or missing rate shows no per-bill commission. This report does not change sales or staff settings.</p>
  </div>;
}
