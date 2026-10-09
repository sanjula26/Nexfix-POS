import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Copy, Printer, MessageCircle, Search, FileText, ArrowLeft, Clock3 } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, EmptyState, PageHeading } from '../components/ui';
import { fmtDate, fmtDateTime, fmtRs, waLink } from '../lib/utils';
import { getOpenCreditInvoiceBalance } from '../lib/customerCredit';

const roundMoney = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const ageBucket = (days: number) => days <= 30 ? '0–30 days' : days <= 60 ? '31–60 days' : days <= 90 ? '61–90 days' : '90+ days';

export default function CreditStatements() {
  const { state } = usePOS();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const payments = state.customerCreditPayments || [];
  const customer = state.customers.find(c => c.id === (params.get('customer') || ''));
  const customers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return state.customers.filter(c => c.creditBalance > 0.009)
      .filter(c => !q || c.name.toLowerCase().includes(q) || c.phone.replace(/\s/g, '').includes(q.replace(/\s/g, '')))
      .sort((a, b) => b.creditBalance - a.creditBalance);
  }, [state.customers, search]);
  const invoices = useMemo(() => {
    if (!customer) return [];
    let remaining = Math.max(0, Number(customer.creditBalance) || 0);
    return state.sales.filter(s => s.customerId === customer.id && s.status === 'completed')
      .map(s => ({ sale: s, rawDue: getOpenCreditInvoiceBalance(s, payments) }))
      .filter(x => x.rawDue > 0.009)
      .sort((a, b) => a.sale.date.localeCompare(b.sale.date) || a.sale.billNo.localeCompare(b.sale.billNo))
      .map(({ sale, rawDue }) => {
        const due = roundMoney(Math.min(rawDue, remaining));
        remaining = roundMoney(Math.max(0, remaining - due));
        return { sale, due, paid: roundMoney(Math.max(0, sale.total - due)) };
      }).filter(row => row.due > 0.009);
  }, [customer, state.sales, payments]);
  const settlements = useMemo(() => customer ? payments.filter(p => p.customerId === customer.id).sort((a, b) => b.date.localeCompare(a.date)) : [], [customer, payments]);
  const oldestDays = invoices.length ? Math.max(0, Math.floor((Date.now() - new Date(invoices[0].sale.date).getTime()) / 86400000)) : 0;
  const statementText = () => {
    if (!customer) return '';
    return [
      state.settings.shopName || 'NexFix POS', 'CUSTOMER CREDIT STATEMENT',
      `Customer: ${customer.name}`, `Phone: ${customer.phone || '—'}`, `Date: ${fmtDate(new Date().toISOString())}`, '',
      'OPEN CREDIT BILLS',
      ...(invoices.length ? invoices.map(({ sale, paid, due }) => `${sale.billNo} | ${fmtDate(sale.date)} | Total ${fmtRs(sale.total)} | Paid ${fmtRs(paid)} | Due ${fmtRs(due)}`) : ['No open credit bills recorded.']),
      '', 'SETTLEMENTS',
      ...(settlements.length ? settlements.map(p => `${fmtDate(p.date)} | ${(p.methods || [{ method: p.method, amount: p.amount }]).map(m => `${m.method.toUpperCase()} ${fmtRs(m.amount)}`).join(' + ')} | Total ${fmtRs(p.amount)}`) : ['No settlements recorded.']),
      '', `Current outstanding balance: ${fmtRs(customer.creditBalance)}`,
      `Oldest open due: ${invoices.length ? `${oldestDays} days (${ageBucket(oldestDays)})` : 'None'}`,
    ].join('\n');
  };
  const copyStatement = async () => {
    try { await navigator.clipboard.writeText(statementText()); setNotice('Statement copied. Paste it into WhatsApp or another message.'); }
    catch { setNotice('Clipboard is unavailable here. Use Print or WhatsApp Share.'); }
  };
  const shareWhatsApp = () => {
    if (!customer?.phone) { setNotice('This customer has no phone number saved.'); return; }
    window.open(waLink(customer.phone, statementText()), '_blank', 'noopener,noreferrer');
  };
  return <div className="space-y-5">
    <PageHeading chip="Receivables" chipTone="amber" title="Customer Credit Statements" sub="Read-only credit bills, settlements, outstanding balance and age of oldest open due." actions={<div className="flex flex-wrap gap-2">
      <button className="btn btn-soft" onClick={() => { setParams({}); setNotice(''); }}><ArrowLeft size={15}/> Customers</button>
      {customer && <><button className="btn btn-soft" onClick={() => window.print()}><Printer size={15}/> Print</button><button className="btn btn-soft" onClick={() => void copyStatement()}><Copy size={15}/> Copy</button><button className="btn btn-primary" onClick={shareWhatsApp}><MessageCircle size={15}/> WhatsApp</button></>}
    </div>} />
    {notice && <div role="status" className="rounded-xl border border-line bg-raised px-4 py-3 text-sm">{notice}</div>}
    {!customer ? <div className="card overflow-hidden">
      <div className="p-4 border-b border-line flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between"><div><h2 className="font-bold">Customers with outstanding credit</h2><p className="text-xs text-sub mt-1">Balances come from the existing customer ledger; this page does not post payments.</p></div><div className="relative w-full sm:max-w-sm"><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint"/><input className="input pl-9" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name or phone"/></div></div>
      {customers.length ? <div className="overflow-x-auto"><table className="table w-full"><thead><tr><th className="th">Customer</th><th className="th">Phone</th><th className="th">Balance</th><th className="th">Oldest due</th><th className="th">Age</th><th className="th"/></tr></thead><tbody>{customers.map(c => {
        const open = state.sales.filter(s => s.customerId === c.id && s.status === 'completed').map(s => ({sale:s,due:getOpenCreditInvoiceBalance(s,payments)})).filter(x=>x.due>0.009).sort((a,b)=>a.sale.date.localeCompare(b.sale.date));
        const days = open.length ? Math.max(0, Math.floor((Date.now()-new Date(open[0].sale.date).getTime())/86400000)) : 0;
        return <tr key={c.id}><td className="td font-semibold">{c.name}</td><td className="td">{c.phone || '—'}</td><td className="td font-bold num text-amber-600">{fmtRs(c.creditBalance)}</td><td className="td">{open.length ? fmtDate(open[0].sale.date) : '—'}</td><td className="td"><Badge tone={days>90?'rose':days>60?'amber':'slate'}>{open.length?ageBucket(days):'No open invoice'}</Badge></td><td className="td text-right"><button className="btn btn-soft !py-1.5" onClick={()=>{setParams({customer:c.id});setNotice('');}}>View statement <FileText size={14}/></button></td></tr>;
      })}</tbody></table></div> : <div className="p-5"><EmptyState icon={<FileText size={25}/>} title="No outstanding customer credit" sub={search?'Try another search.':'Customers with a positive credit balance appear here.'}/></div>}
    </div> : <>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <div className="card p-4"><div className="text-xs text-sub">Customer</div><div className="font-bold text-lg mt-1">{customer.name}</div><div className="text-sm text-sub">{customer.phone || 'No phone saved'}</div></div>
        <div className="card p-4"><div className="text-xs text-sub">Current outstanding</div><div className="text-2xl font-extrabold num text-amber-600 mt-1">{fmtRs(customer.creditBalance)}</div></div>
        <div className="card p-4"><div className="text-xs text-sub">Open credit bills</div><div className="text-2xl font-extrabold num mt-1">{invoices.length}</div><div className="text-xs text-sub">Oldest: {invoices.length?fmtDate(invoices[0].sale.date):'—'}</div></div>
        <div className="card p-4"><div className="text-xs text-sub flex items-center gap-1"><Clock3 size={13}/> Oldest due age</div><div className="text-xl font-extrabold mt-1">{invoices.length?`${oldestDays} days`:'—'}</div><Badge tone={oldestDays>90?'rose':oldestDays>60?'amber':'slate'}>{invoices.length?ageBucket(oldestDays):'No open due'}</Badge></div>
      </div>
      <section className="card overflow-hidden"><div className="p-4 border-b border-line"><h2 className="font-bold">Open credit sales</h2><p className="text-xs text-sub mt-1">Due amounts use recorded allocations and are capped to the customer ledger balance.</p></div>
        {invoices.length ? <div className="overflow-x-auto"><table className="table w-full"><thead><tr><th className="th">Bill no.</th><th className="th">Date</th><th className="th text-right">Total</th><th className="th text-right">Paid</th><th className="th text-right">Due</th></tr></thead><tbody>{invoices.map(({sale,paid,due})=><tr key={sale.id}><td className="td font-semibold">{sale.billNo}</td><td className="td">{fmtDate(sale.date)}</td><td className="td text-right num">{fmtRs(sale.total)}</td><td className="td text-right num">{fmtRs(paid)}</td><td className="td text-right font-bold num text-amber-600">{fmtRs(due)}</td></tr>)}</tbody><tfoot><tr><td className="td font-bold" colSpan={4}>Open invoice total</td><td className="td text-right font-extrabold num">{fmtRs(invoices.reduce((sum,row)=>sum+row.due,0))}</td></tr></tfoot></table></div> : <div className="p-4"><EmptyState icon={<FileText size={22}/>} title="No open credit invoices" sub="Older or unallocated records may still be reflected in the authoritative customer balance."/></div>}
      </section>
      <section className="card overflow-hidden"><div className="p-4 border-b border-line"><h2 className="font-bold">Credit settlements</h2><p className="text-xs text-sub mt-1">Collection date, method, amount and allocation when available.</p></div>
        {settlements.length ? <div className="overflow-x-auto"><table className="table w-full"><thead><tr><th className="th">Date</th><th className="th">Method</th><th className="th">Applied to</th><th className="th">Recorded by</th><th className="th text-right">Amount</th></tr></thead><tbody>{settlements.map(p=><tr key={p.id}><td className="td">{fmtDateTime(p.date)}</td><td className="td">{(p.methods||[{method:p.method,amount:p.amount}]).map(m=>`${m.method.toUpperCase()} ${fmtRs(m.amount)}`).join(' + ')}</td><td className="td">{p.allocations?.length?p.allocations.map(a=>a.billNo).join(', '):'FIFO / legacy unallocated'}</td><td className="td">{p.by||'—'}</td><td className="td text-right font-bold num text-emerald-600">{fmtRs(p.amount)}</td></tr>)}</tbody></table></div> : <div className="p-4"><EmptyState icon={<FileText size={22}/>} title="No settlements recorded"/></div>}
      </section>
      <div className="card p-4 flex flex-wrap items-center justify-between gap-3"><div><div className="text-xs text-sub">Statement balance (authoritative ledger)</div><div className="text-2xl font-extrabold num text-amber-600">{fmtRs(customer.creditBalance)}</div></div><div className="text-xs text-sub max-w-xl">Read-only statement. Balances change only through existing sale and settlement workflows.</div></div>
    </>}
  </div>;
}
