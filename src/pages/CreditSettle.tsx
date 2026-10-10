import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Banknote, CreditCard, Landmark, Smartphone, UserRound, ReceiptText, CheckCircle2, AlertTriangle, Printer, MessageCircle } from 'lucide-react';
import { usePOS } from '../lib/store';
import { EmptyState, Field, PageHeading, SearchInput } from '../components/ui';
import { dkey, fmtDate, fmtDateTime, fmtRs, normalizeWhatsAppPhone, openWhatsAppLink } from '../lib/utils';
import { getDefaultBranchId, hasMultipleCachedBranches } from '../lib/branchStock';
import { getCloudShopId } from '../lib/cloudSync';
import { getOpenCreditInvoiceBalance } from '../lib/customerCredit';
import type { PaymentMethod, PaymentLeg } from '../lib/types';

const METHODS: Array<{ value: Exclude<PaymentMethod, 'credit'>; label: string; icon: typeof Banknote }> = [
  { value: 'cash', label: 'Cash', icon: Banknote },
  { value: 'card', label: 'Card', icon: CreditCard },
  { value: 'bank', label: 'Bank / Online', icon: Landmark },
  { value: 'mobile', label: 'Mobile', icon: Smartphone },
];


function buildSettlementWhatsAppText(saved: { payment: import('../lib/customerCredit').CustomerCreditPayment; customerName: string; customerPhone: string; previousOutstanding?: number; remainingBalance?: number; cashierName: string }, settings: { shopName?: string; phone?: string; address?: string; email?: string }): string {
  const money = (value: number) => `Rs. ${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const payment = saved.payment;
  const lines = [`*${settings.shopName || 'Shop'}*`];
  if (settings.phone) lines.push(`Phone: ${settings.phone}`);
  if (settings.address) lines.push(settings.address);
  lines.push('', '*CREDIT PAYMENT RECEIPT / ණය ගෙවීම*', `Receipt: ${payment.id.slice(0, 12)}`, `Date: ${fmtDateTime(payment.date)}`, `Customer: ${saved.customerName}`, `Mobile: ${saved.customerPhone || '—'}`, `Cashier: ${saved.cashierName}`, '--------------------------------');
  if (saved.previousOutstanding !== undefined) lines.push(`Previous outstanding: ${money(saved.previousOutstanding)}`);
  for (const leg of payment.methods || [{ method: payment.method, amount: payment.amount }]) lines.push(`Paid now (${leg.method.toUpperCase()}): ${money(leg.amount)}`);
  for (const allocation of payment.allocations || []) lines.push(`Bill ${allocation.billNo}: ${money(allocation.amount)} allocated`);
  if (saved.remainingBalance !== undefined) {
    lines.push('--------------------------------', `*REMAINING BALANCE: ${money(saved.remainingBalance)}*`);
    if (saved.remainingBalance <= 0.009) lines.push('*STATUS: PAID IN FULL — BALANCE CLEARED*');
  } else lines.push('', '_Remaining balance unavailable for this older settlement record._');
  lines.push('', 'Thank you for your payment!');
  if (settings.phone) lines.push(`Contact: ${settings.phone}`);
  return lines.join('\n');
}

export default function CreditSettle() {
  const { state, user, can, saveCustomerCreditPayment } = usePOS();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'balance'>('balance');
  const [view, setView] = useState<'customers' | 'invoices'>('customers');
  const [customerId, setCustomerId] = useState(searchParams.get('customer') || '');
  const [saleId, setSaleId] = useState(searchParams.get('sale') || '');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<Exclude<PaymentMethod, 'credit'>>('cash');
  const [splitOn, setSplitOn] = useState(false);
  const [cashPart, setCashPart] = useState('');
  const [cardPart, setCardPart] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<{ payment: import('../lib/customerCredit').CustomerCreditPayment; customerName: string; customerPhone: string; previousOutstanding?: number; remainingBalance?: number; cashierName: string } | null>(null);
  const [historyPrintOnly, setHistoryPrintOnly] = useState(false);
  const [whatsappPhone, setWhatsappPhone] = useState('');
  const [whatsappError, setWhatsappError] = useState('');

  const payments = state.customerCreditPayments || [];
  const customer = state.customers.find(c => c.id === customerId);
  const invoices = useMemo(() => {
    const open = state.sales
      .filter(s => s.customerId && s.status === 'completed')
      .map(s => ({ sale: s, rawDue: getOpenCreditInvoiceBalance(s, payments) }))
      .filter(x => x.rawDue > 0.009)
      .sort((a, b) => +new Date(a.sale.date) - +new Date(b.sale.date));
    const remainingByCustomer = new Map(state.customers.map(c => [c.id, Math.max(0, Number(c.creditBalance) || 0)]));
    return open.map(row => {
      const customerId = row.sale.customerId!;
      const remaining = remainingByCustomer.get(customerId) || 0;
      const due = Math.min(row.rawDue, remaining);
      remainingByCustomer.set(customerId, Math.max(0, Math.round((remaining - due) * 100) / 100));
      return { sale: row.sale, due };
    }).filter(row => row.due > 0.009);
  }, [state.sales, state.customers, payments]);
  const selectedInvoice = invoices.find(x => x.sale.id === saleId);
  const outstanding = customer
    ? (selectedInvoice && selectedInvoice.sale.customerId === customer.id ? selectedInvoice.due : Math.max(0, customer.creditBalance))
    : 0;
  const q = search.trim().toLowerCase();
  const customerRows = state.customers
    .filter(c => filter === 'all' || c.creditBalance > 0.009)
    .filter(c => !q || c.name.toLowerCase().includes(q) || c.phone.replace(/\\s/g, '').includes(q.replace(/\\s/g, '')))
    .sort((a, b) => b.creditBalance - a.creditBalance);
  const invoiceRows = invoices.filter(({ sale }) => {
    if (filter === 'balance' && !(sale.customerId && (state.customers.find(c => c.id === sale.customerId)?.creditBalance || 0) > 0)) return false;
    return !q || sale.billNo.toLowerCase().includes(q) || sale.customerName.toLowerCase().includes(q) ||
      (state.customers.find(c => c.id === sale.customerId)?.phone || '').replace(/\\s/g, '').includes(q.replace(/\\s/g, ''));
  });
  const totalReceivables = state.customers.reduce((sum, c) => sum + Math.max(0, c.creditBalance || 0), 0);
  const totalCollectedToday = payments.filter(p => fmtDate(p.date) === fmtDate(new Date().toISOString())).reduce((sum, p) => sum + p.amount, 0);
  const [recentSearch, setRecentSearch] = useState('');
  const [recentFrom, setRecentFrom] = useState('');
  const [recentTo, setRecentTo] = useState('');
  const [visibleRecentCount, setVisibleRecentCount] = useState(5);
  const [whatsappRowId, setWhatsappRowId] = useState('');
  const [rowWhatsappPhone, setRowWhatsappPhone] = useState('');
  const recentQuery = recentSearch.trim().toLocaleLowerCase();
  const filteredRecent = payments
    .filter(p => !customerId || p.customerId === customerId)
    .filter(p => {
      const paymentDay = new Date(p.date);
      if (!Number.isFinite(paymentDay.getTime())) return false;
      const day = [paymentDay.getFullYear(), String(paymentDay.getMonth() + 1).padStart(2, '0'), String(paymentDay.getDate()).padStart(2, '0')].join('-');
      if (recentFrom && day < recentFrom) return false;
      if (recentTo && day > recentTo) return false;
      if (!recentQuery) return true;
      const c = state.customers.find(x => x.id === p.customerId);
      const searchable = [c?.name, c?.phone, c?.address, ...(p.allocations || []).map(a => a.billNo)]
        .filter(Boolean).join(' ').toLocaleLowerCase();
      return searchable.includes(recentQuery);
    })
    .sort((a, b) => {
      const diff = new Date(b.date).getTime() - new Date(a.date).getTime();
      return diff || String(b.id).localeCompare(String(a.id));
    });
  const recent = filteredRecent.slice(0, visibleRecentCount);
  const canCollect = !!user && (user.role === 'admin' || (can('page:customers') && can('page:pos')));
  const today = dkey(new Date());
  const selectedBranchId = state.settings.branchId || 'local-main';
  const defaultBranchId = getDefaultBranchId(getCloudShopId()) || 'local-main';
  const effectiveBranch = (branchId?: string) => !branchId || branchId === 'local-main' ? defaultBranchId : branchId;
  const todaySession = state.sessions.find(session =>
    session.cashierId === user?.id && session.date === today &&
    effectiveBranch(session.branchId) === effectiveBranch(selectedBranchId),
  );
  const sessionBlockReason = hasMultipleCachedBranches(getCloudShopId()) && selectedBranchId === 'local-main'
    ? 'Select this POS branch in Settings before collecting credit payments.'
    : !todaySession
      ? "Open a cashier drawer session for today first. Go to Cashier Balance Report and open today's session."
      : todaySession.closed
        ? "Today's cashier drawer is already closed. Credit payments cannot be collected in a closed session."
        : todaySession.openingConfirmed === false
          ? "Confirm today's opening float in Cashier Balance Report before collecting credit."
          : '';

  const selectCustomer = (id: string) => {
    setCustomerId(id);
    setSaleId('');
    setLastSaved(null);
    setError('');
    const next = new URLSearchParams(searchParams);
    next.set('customer', id);
    next.delete('sale');
    setSearchParams(next, { replace: true });
  };
  const selectInvoice = (id: string, nextCustomerId: string) => {
    setCustomerId(nextCustomerId);
    setSaleId(id);
    setLastSaved(null);
    setError('');
    const next = new URLSearchParams(searchParams);
    next.set('customer', nextCustomerId);
    next.set('sale', id);
    setSearchParams(next, { replace: true });
  };

  const save = () => {
    if (saving) return;
    setError('');
    if (!canCollect) return setError('You do not have permission to collect credit payments. Ask an administrator to enable Customers and POS access.');
    if (sessionBlockReason) return setError(sessionBlockReason);
    if (!customer) return setError('Select a customer first.');
    const value = Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(value) || value <= 0) return setError('Enter an amount greater than zero.');
    if (value > outstanding + 0.009) {
      return setError(selectedInvoice
        ? `Amount exceeds selected invoice due (${fmtRs(outstanding)}).`
        : `Amount exceeds customer outstanding (${fmtRs(outstanding)}).`);
    }
    let methods: PaymentLeg[] | undefined;
    if (splitOn) {
      const cash = Math.round(Number(cashPart) * 100) / 100;
      const card = Math.round(Number(cardPart) * 100) / 100;
      if (cash < 0 || card < 0 || !Number.isFinite(cash) || !Number.isFinite(card) || (cash <= 0 && card <= 0)) {
        return setError('Enter a valid Cash and/or Card split. Each entered amount must be positive.');
      }
      if (Math.abs(cash + card - value) > 0.009) return setError(`Cash + Card (${fmtRs(cash + card)}) must equal the amount to collect (${fmtRs(value)}).`);
      methods = [{ method: 'cash' as const, amount: cash }, { method: 'card' as const, amount: card }].filter(x => x.amount > 0);
    }
    setSaving(true);
    const result = saveCustomerCreditPayment({
      customerId: customer.id, amount: value, method, methods,
      note: note.trim() || undefined, saleId: selectedInvoice?.sale.id,
    });
    if (!result.ok) {
      setError(result.error);
      setSaving(false);
      return;
    }
    const payment = result.payment;
    const remainingBalance = payment.balanceAfter ?? Math.max(0, Math.round((customer.creditBalance - payment.amount) * 100) / 100);
    setHistoryPrintOnly(false);
    setLastSaved({ payment, customerName: customer.name, customerPhone: customer.phone || '', previousOutstanding: payment.balanceBefore ?? Math.max(0, customer.creditBalance), remainingBalance, cashierName: user?.name || payment.by || 'Cashier' });
    setWhatsappPhone(customer.phone || '');
    setWhatsappError('');
    setAmount(''); setCashPart(''); setCardPart(''); setNote('');
    if (selectedInvoice && value >= selectedInvoice.due - 0.009) {
      setSaleId('');
      const next = new URLSearchParams(searchParams);
      next.delete('sale');
      setSearchParams(next, { replace: true });
    }
    setSaving(false);
  };

  return (
    <div className="space-y-5">
      <PageHeading chip="Receivables" chipTone="amber" title="Credit Settle" sub="Collect full or partial customer credit repayments." actions={<Link to="/credit-statements" className="btn btn-soft"><ReceiptText size={15}/> Credit statements</Link>} />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="card p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-sub">Total outstanding</div><div className="text-2xl font-extrabold num mt-1 text-amber-600">{fmtRs(totalReceivables)}</div><div className="text-xs text-sub mt-1">{state.customers.filter(c => c.creditBalance > 0.009).length} customers with balance</div></div>
        <div className="card p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-sub">Collected today</div><div className="text-2xl font-extrabold num mt-1">{fmtRs(totalCollectedToday)}</div><div className="text-xs text-sub mt-1">Recorded repayments</div></div>
        <div className="card p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-sub">Open credit invoices</div><div className="text-2xl font-extrabold num mt-1">{invoices.length}</div><div className="text-xs text-sub mt-1">Unpaid invoice balances after allocations</div></div>
      </div>

      {!canCollect && <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 flex gap-2"><AlertTriangle size={17} /> Your role can view receivables, but needs Customers and POS permissions to collect payments.</div>}
      {user && sessionBlockReason && <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 flex gap-2"><AlertTriangle size={17} /><div><div className="font-semibold">Cashier drawer required</div><div>{sessionBlockReason}</div><div className="mt-1 text-xs">Credit collections are recorded in today's drawer and included in day-end cash/card totals.</div></div></div>}
      {lastSaved && <>
        {!historyPrintOnly && <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 space-y-3">
          <div className="flex items-start gap-2"><CheckCircle2 size={19} className="text-emerald-600 mt-0.5" /><div className="min-w-0 flex-1"><div className="font-bold text-emerald-700">Settlement receipt ready</div><div className="text-sm text-sub">{lastSaved.customerName} · {fmtRs(lastSaved.payment.amount)} paid</div>{lastSaved.remainingBalance !== undefined && <><div className="text-sm font-semibold mt-1">Remaining balance: {fmtRs(lastSaved.remainingBalance)}</div>{lastSaved.remainingBalance <= 0.009 && <div className="text-xs font-extrabold text-emerald-700 mt-1">PAID IN FULL · BALANCE CLEARED</div>}</>}{lastSaved.remainingBalance === undefined && <div className="text-xs text-sub mt-1">Historical balance was not recorded; remaining balance is unavailable.</div>}</div></div>
          <div className="flex flex-wrap gap-2"><button type="button" className="btn btn-primary" onClick={() => window.print()}><Printer size={15}/> Print settlement receipt</button><button type="button" className="btn !text-white" style={{background:'linear-gradient(135deg,#25d366,#128c7e)'}} onClick={() => { const phone = normalizeWhatsAppPhone(whatsappPhone); if (phone.length < 9 || phone.length > 15) { setWhatsappError('Enter a valid WhatsApp number including country code if needed.'); return; } setWhatsappError(''); openWhatsAppLink(phone, buildSettlementWhatsAppText(lastSaved, state.settings)); }}><MessageCircle size={15}/> WhatsApp settlement</button><button type="button" className="btn btn-soft" onClick={() => { setLastSaved(null); setHistoryPrintOnly(false); }}>Dismiss</button></div>
          <div><label className="block text-xs font-semibold text-sub mb-1">Customer WhatsApp number (editable)</label><input className="input w-full" type="tel" inputMode="tel" value={whatsappPhone} onChange={e => {setWhatsappPhone(e.target.value); setWhatsappError('');}} placeholder="e.g. 0771234567 or +94771234567" />{whatsappError && <div className="text-xs text-rose-500 mt-1">{whatsappError}</div>}<div className="text-[11px] text-sub mt-1">WhatsApp opens with a prefilled message. Review and send it in WhatsApp.</div></div>
        </div>}
        <div className="print-area" style={{fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}}><div style={{width:'72mm',maxWidth:'72mm',padding:'4mm',background:'#fff',color:'#000',fontSize:'11px',lineHeight:1.45}}>
          <div style={{textAlign:'center',fontWeight:800,fontSize:'15px'}}>{state.settings.shopName || 'Shop'}</div>{state.settings.phone && <div style={{textAlign:'center'}}>Tel: {state.settings.phone}</div>}{state.settings.address && <div style={{textAlign:'center',fontSize:'10px'}}>{state.settings.address}</div>}
          <div style={{borderTop:'1px dashed #000',margin:'10px 0'}}/><div style={{textAlign:'center',fontWeight:800}}>CREDIT PAYMENT RECEIPT</div><div style={{textAlign:'center',fontWeight:700}}>ණය ගෙවීම</div>
          <div style={{marginTop:'8px'}}>Receipt: {lastSaved.payment.id.slice(0,12)}</div><div>Date: {fmtDateTime(lastSaved.payment.date)}</div><div>Customer: {lastSaved.customerName}</div><div>Mobile: {lastSaved.customerPhone || whatsappPhone || '—'}</div><div>Cashier: {lastSaved.cashierName}</div>
          <div style={{borderTop:'1px dashed #000',margin:'8px 0'}}/>{lastSaved.previousOutstanding !== undefined && <div>Previous outstanding: {fmtRs(lastSaved.previousOutstanding)}</div>}
          {(lastSaved.payment.methods || [{method:lastSaved.payment.method,amount:lastSaved.payment.amount}]).map((leg,i)=><div key={i}>Paid ({leg.method.toUpperCase()}): {fmtRs(leg.amount)}</div>)}
          {lastSaved.payment.allocations?.map((allocation,i)=><div key={i}>Bill {allocation.billNo}: {fmtRs(allocation.amount)} allocated</div>)}
          {lastSaved.remainingBalance !== undefined ? <><div style={{borderTop:'1px dashed #000',margin:'8px 0'}}/><div style={{fontWeight:900,fontSize:'13px'}}>REMAINING BALANCE</div><div style={{fontWeight:900,fontSize:'16px'}}>{fmtRs(lastSaved.remainingBalance)}</div>{lastSaved.remainingBalance <= 0.009 && <div style={{fontWeight:900,textAlign:'center',marginTop:'5px'}}>PAID IN FULL · BALANCE CLEARED</div>}</> : <div style={{marginTop:'8px',fontSize:'10px'}}>Remaining balance unavailable for this older settlement record.</div>}
          <div style={{borderTop:'1px dashed #000',margin:'8px 0'}}/><div style={{textAlign:'center'}}>Thank you! Please contact us if you need assistance.</div>{state.settings.phone && <div style={{textAlign:'center'}}>Contact: {state.settings.phone}</div>}
        </div></div>
      </>}

      <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_0.9fr] gap-5 items-start">
        <div className="space-y-4">
          <div className="card overflow-hidden">
            <div className="p-4 border-b border-line space-y-3">
              <div className="flex flex-wrap gap-2">
                <button className={`btn ${view === 'customers' ? 'btn-primary' : 'btn-soft'}`} onClick={() => setView('customers')}><UserRound size={15} /> Customers</button>
                <button className={`btn ${view === 'invoices' ? 'btn-primary' : 'btn-soft'}`} onClick={() => setView('invoices')}><ReceiptText size={15} /> Open invoices</button>
                <div className="flex-1" />
                <select className="input !w-auto" value={filter} onChange={e => setFilter(e.target.value as 'all' | 'balance')}><option value="balance">With balance</option><option value="all">All customers</option></select>
              </div>
              <SearchInput value={search} onChange={setSearch} placeholder={view === 'invoices' ? 'Search customer, mobile, bill no…' : 'Search customer name or mobile…'} />
            </div>
            {view === 'customers' ? customerRows.length ? (
              <div className="overflow-x-auto"><table className="w-full min-w-[520px]"><thead><tr><th className="th">Customer</th><th className="th">Mobile</th><th className="th text-right">Outstanding</th></tr></thead><tbody>
                {customerRows.map(c => <tr key={c.id} onClick={() => selectCustomer(c.id)} className={`cursor-pointer hover:bg-raised/50 ${customerId === c.id ? 'bg-violet-500/10' : ''}`}><td className="td font-semibold">{c.name}</td><td className="td text-sm text-sub">{c.phone}</td><td className="td text-right num font-bold text-amber-600">{fmtRs(c.creditBalance)}</td></tr>)}
              </tbody></table></div>
            ) : <EmptyState icon={<UserRound size={24} />} title="No customers with credit" sub="Customers with an outstanding balance appear here." /> : invoiceRows.length ? (
              <div className="overflow-x-auto"><table className="w-full min-w-[610px]"><thead><tr><th className="th">Invoice</th><th className="th">Customer</th><th className="th">Date</th><th className="th text-right">Due</th></tr></thead><tbody>
                {invoiceRows.map(({ sale, due }) => <tr key={sale.id} onClick={() => sale.customerId && selectInvoice(sale.id, sale.customerId)} className={`cursor-pointer hover:bg-raised/50 ${saleId === sale.id ? 'bg-violet-500/10' : ''}`}><td className="td font-semibold">{sale.billNo}</td><td className="td">{sale.customerName}<div className="text-[11px] text-sub">{state.customers.find(c => c.id === sale.customerId)?.phone || ''}</div></td><td className="td text-xs text-sub">{fmtDate(sale.date)}</td><td className="td text-right num font-bold text-amber-600">{fmtRs(due)}</td></tr>)}
              </tbody></table></div>
            ) : <EmptyState icon={<ReceiptText size={24} />} title="No open credit invoices" sub="Unpaid completed invoices appear here." />}
          </div>
        </div>

        <div className="space-y-4">
          <div className="card p-5 space-y-4">
            <div><div className="text-xs font-bold uppercase tracking-wider text-sub">Collect payment</div><h2 className="text-lg font-extrabold mt-1">{customer?.name || 'Select a customer'}</h2><div className="text-sm text-sub">{customer?.phone || 'Choose a customer or an open invoice from the list.'}</div></div>
            {customer && <div className="rounded-xl bg-raised border border-line p-3 flex items-center justify-between gap-3"><div><div className="text-xs text-sub">{selectedInvoice ? `Invoice ${selectedInvoice.sale.billNo} due` : 'Customer outstanding balance'}</div><div className="text-2xl font-extrabold num text-amber-600">{fmtRs(outstanding)}</div></div>{selectedInvoice && <button className="btn btn-soft !text-xs" onClick={() => { setSaleId(''); const next = new URLSearchParams(searchParams); next.delete('sale'); setSearchParams(next, { replace: true }); }}>Pay FIFO instead</button>}</div>}
            <Field label="Amount to collect (Rs.)"><input className="input num" inputMode="decimal" value={amount} onChange={e => { setAmount(e.target.value.replace(/[^0-9.]/g, '')); setError(''); }} placeholder="e.g. 20000" disabled={!customer || !canCollect || !!sessionBlockReason || saving} /></Field>
            {customer && <div className="flex flex-wrap gap-2 -mt-2">
              <button type="button" className="btn btn-soft !text-xs" disabled={!canCollect || !!sessionBlockReason || saving} onClick={() => { if (selectedInvoice) { setSaleId(''); const next = new URLSearchParams(searchParams); next.delete('sale'); setSearchParams(next, { replace: true }); } setAmount(String(Math.round(customer.creditBalance * 100) / 100)); setError(''); }}>Exact customer balance</button>
              {selectedInvoice && <button type="button" className="btn btn-soft !text-xs" disabled={!canCollect || !!sessionBlockReason || saving} onClick={() => { setAmount(String(selectedInvoice.due)); setError(''); }}>Exact invoice due</button>}
              <button type="button" className="btn btn-soft !text-xs" disabled={!canCollect || !!sessionBlockReason || saving} onClick={() => { setAmount(String(Math.round(outstanding * 50) / 100)); setError(''); }}>50%</button>
            </div>}
            <div><div className="text-sm font-semibold mb-2">Payment method</div><div className="grid grid-cols-2 gap-2">{METHODS.map(m => { const Icon = m.icon; return <button key={m.value} type="button" onClick={() => { setMethod(m.value); setSplitOn(false); }} disabled={!canCollect} className={`rounded-xl border p-3 text-left flex items-center gap-2 ${!splitOn && method === m.value ? 'border-violet-500 bg-violet-500/10 text-violet-600' : 'border-line hover:bg-raised'}`}><Icon size={17} /><span className="text-sm font-semibold">{m.label}</span></button>; })}</div></div>
            <label className="flex items-center gap-2 text-sm text-sub"><input type="checkbox" checked={splitOn} onChange={e => setSplitOn(e.target.checked)} disabled={!canCollect} /> Split Cash + Card</label>
            {splitOn && <div className="grid grid-cols-2 gap-3"><Field label="Cash (Rs.)"><input className="input num" inputMode="decimal" value={cashPart} onChange={e => setCashPart(e.target.value.replace(/[^0-9.]/g, ''))} /></Field><Field label="Card (Rs.)"><input className="input num" inputMode="decimal" value={cardPart} onChange={e => setCardPart(e.target.value.replace(/[^0-9.]/g, ''))} /></Field><div className="col-span-2 text-xs text-sub">Split total: {fmtRs((Number(cashPart) || 0) + (Number(cardPart) || 0))}</div></div>}
            <Field label="Note (optional)"><textarea className="input min-h-[76px]" value={note} onChange={e => setNote(e.target.value)} placeholder="Payment reference / note" /></Field>
            {error && <div className="text-sm text-rose-500 flex gap-2"><AlertTriangle size={16} />{error}</div>}
            <button className="btn btn-primary w-full justify-center" onClick={save} disabled={!customer || !canCollect || !!sessionBlockReason || saving || !amount || Number(amount) <= 0}><CheckCircle2 size={16} /> {saving ? 'Saving payment…' : 'Save credit payment'}</button>
            <p className="text-[11px] text-sub">Payments reduce the customer balance immediately and are recorded with date, user, method and invoice allocations. Settlements cannot be deleted in this version.</p>
          </div>
          <div className="card overflow-hidden">
            <div className="p-4 border-b border-line space-y-3">
              <div><div className="font-bold">Recent credit collections</div><div className="text-xs text-sub mt-1">{customer ? `History for ${customer.name}` : 'Latest repayments across all customers'}</div></div>
              <SearchInput value={recentSearch} onChange={value => { setRecentSearch(value); setVisibleRecentCount(5); }} placeholder="Search customer, mobile, address, bill no…" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className="text-xs text-sub">Date from<input className="input w-full mt-1" type="date" value={recentFrom} max={recentTo || undefined} onChange={e => { setRecentFrom(e.target.value); setVisibleRecentCount(5); }} /></label>
                <label className="text-xs text-sub">Date to<input className="input w-full mt-1" type="date" value={recentTo} min={recentFrom || undefined} onChange={e => { setRecentTo(e.target.value); setVisibleRecentCount(5); }} /></label>
              </div>
              {(recentSearch || recentFrom || recentTo) && <button type="button" className="btn btn-soft !text-xs" onClick={() => { setRecentSearch(''); setRecentFrom(''); setRecentTo(''); setVisibleRecentCount(5); }}>Clear search and dates</button>}
              <div className="text-xs text-sub">Showing {Math.min(visibleRecentCount, filteredRecent.length)} of {filteredRecent.length} matching payment{filteredRecent.length === 1 ? '' : 's'} · Newest first</div>
            </div>
            {recent.length ? <div className="divide-y divide-line">{recent.map(p => {
              const c = state.customers.find(x => x.id === p.customerId);
              const legs = p.methods || [{ method: p.method, amount: p.amount }];
              const receipt = { payment: p, customerName: c?.name || 'Unknown customer', customerPhone: c?.phone || '', previousOutstanding: p.balanceBefore, remainingBalance: p.balanceAfter, cashierName: p.by || 'Cashier' };
              return <div key={p.id} className="p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">{c?.name || 'Unknown customer'}</div>
                    <div className="text-[11px] text-sub">{fmtDateTime(p.date)} · {p.by}</div>
                    {c?.phone && <div className="text-[11px] text-sub">{c.phone}</div>}
                    {c?.address && <div className="text-[11px] text-sub">{c.address}</div>}
                    <div className="text-[11px] text-sub mt-1">{legs.map(x => `${x.method.toUpperCase()} ${fmtRs(x.amount)}`).join(' + ')}</div>
                    {p.allocations?.length ? <div className="text-[11px] text-sub">Applied to {p.allocations.map(x => x.billNo).join(', ')}</div> : null}
                    {p.note && <div className="text-xs text-sub mt-1">{p.note}</div>}
                    <div className="flex flex-wrap gap-2 mt-2">
                      <button type="button" className="btn btn-soft !text-xs" onClick={() => {
                        setHistoryPrintOnly(true);
                        setLastSaved(receipt);
                        setWhatsappPhone(c?.phone || '');
                        setWhatsappError('');
                        window.setTimeout(() => window.print(), 250);
                      }}><Printer size={13}/> Reprint</button>
                      <button type="button" className="btn btn-soft !text-xs" onClick={() => {
                        setWhatsappRowId(whatsappRowId === p.id ? '' : p.id);
                        setRowWhatsappPhone(c?.phone || '');
                      }}><MessageCircle size={13}/> Resend WhatsApp</button>
                    </div>
                    {whatsappRowId === p.id && <div className="mt-3 rounded-lg border border-line p-3 space-y-2">
                      <label className="block text-xs font-semibold text-sub">WhatsApp number (editable)<input className="input w-full mt-1" type="tel" inputMode="tel" value={rowWhatsappPhone} onChange={e => setRowWhatsappPhone(e.target.value)} placeholder="Include country code if needed" /></label>
                      <div className="flex flex-wrap gap-2"><button type="button" className="btn btn-primary !text-xs" onClick={() => {
                        const phone = normalizeWhatsAppPhone(rowWhatsappPhone);
                        if (phone.length < 9 || phone.length > 15) { window.alert('Enter a valid WhatsApp number including country code if needed.'); return; }
                        openWhatsAppLink(phone, buildSettlementWhatsAppText(receipt, state.settings));
                        setWhatsappRowId('');
                      }}><MessageCircle size={13}/> Open WhatsApp</button><button type="button" className="btn btn-soft !text-xs" onClick={() => setWhatsappRowId('')}>Cancel</button></div>
                    </div>}
                  </div>
                  <div className="font-bold num text-emerald-600 whitespace-nowrap">{fmtRs(p.amount)}</div>
                </div>
              </div>;
            })}</div> : <div className="p-4 text-sm text-sub">{filteredRecent.length ? 'No credit payments match these filters.' : 'No credit payments recorded for the selected filters.'}</div>}
            {filteredRecent.length > recent.length && <div className="p-3 border-t border-line"><button type="button" className="btn btn-soft w-full justify-center" onClick={() => setVisibleRecentCount(count => Math.min(count + 5, filteredRecent.length))}>See more ({filteredRecent.length - recent.length} older payment{filteredRecent.length - recent.length === 1 ? '' : 's'})</button></div>}
          </div>
        </div>
      </div>
    </div>
  );
}
