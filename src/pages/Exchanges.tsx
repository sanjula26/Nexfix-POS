import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeftRight, ScanSearch, RotateCcw, Repeat2, ShieldAlert, CheckCircle2, CalendarClock } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, Modal, EmptyState, PageHeading } from '../components/ui';
import { fmtRs, fmtDateTime, fmtDate } from '../lib/utils';
import type { Sale } from '../lib/types';
import { ensureCloudShop, processSaleReturnAtomic } from '../lib/cloudSync';
import { supabase, supabaseConfigured } from '../lib/supabase';

export default function Exchanges() {
  const { state, processExchange, can } = usePOS();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [bill, setBill] = useState<Sale | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [returnQty, setReturnQty] = useState<Record<number, number>>({});
  const [reason, setReason] = useState('Defective item');
  const [mode, setMode] = useState<'refund' | 'replace'>('replace');
  const [searched, setSearched] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');

  const search = () => {
    setSearched(true);
    const q = query.trim().toLowerCase();
    const found = state.sales.find(s => s.billNo.toLowerCase() === q || s.billNo.toLowerCase().endsWith(q) && q.length >= 4);
    setBill(found || null); setSelected([]); setReturnQty({}); setConfirm(false); setError('');
  };

  useEffect(() => {
    const b = params.get('bill');
    if (b) {
      setQuery(b);
      const found = state.sales.find(s => s.billNo.toLowerCase() === b.toLowerCase());
      if (found) { setBill(found); setSearched(true); }
      setParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const withinPolicy = bill ? Date.now() - new Date(bill.date).getTime() <= state.settings.exchangeDays * 86400000 : false;
  const toggle = (i: number) => {
    setSelected(s => (s.includes(i) ? s.filter(x => x !== i) : [...s, i]));
    if (!selected.includes(i) && bill) setReturnQty(q => ({ ...q, [i]: bill.items[i].qty }));
  };
  const selectedSum = useMemo(() => (bill ? selected.reduce((a, i) => {
    const qty = Math.max(0, Math.min(bill.items[i].qty, returnQty[i] || 0));
    const discount = bill.items[i].qty > 0 ? (bill.items[i].discount || 0) * (qty / bill.items[i].qty) : 0;
    return a + Math.max(0, bill.items[i].price * qty - discount);
  }, 0) : 0), [bill, selected, returnQty]);

  const resolveCloudLines = async (shopId: string, sale: Sale, selectedItems: Array<{ itemIdx: number; qty: number }>) => {
    if (!supabase) throw new Error('Cloud is not configured');
    const { data, error: queryError } = await supabase.from('sale_items').select('id,product_id,qty,price,discount,unit_ids').eq('sale_id', sale.id);
    if (queryError) throw new Error(queryError.message);
    if (!data || data.length === 0) throw new Error('This bill is not present in the cloud sale ledger');

    const requestedUnitIds = selectedItems.flatMap(({ itemIdx }) => sale.items[itemIdx].unitIds || []);
    let soldUnitIds = new Set<string>();
    if (requestedUnitIds.length) {
      const { data: units, error: unitError } = await supabase
        .from('inventory_units').select('id').eq('shop_id', shopId).eq('sale_id', sale.id).eq('status', 'sold').in('id', requestedUnitIds);
      if (unitError) throw new Error(unitError.message);
      soldUnitIds = new Set((units || []).map(u => u.id));
    }

    const used = new Set<string>();
    return selectedItems.map(({ itemIdx, qty }) => {
      const local = sale.items[itemIdx];
      const localUnits = new Set(local.unitIds || []);
      const candidates = data.filter(row => {
        if (used.has(row.id) || row.product_id !== local.productId || Number(row.qty) < qty) return false;
        if (localUnits.size === 0) return true;
        const cloudUnits = new Set((row.unit_ids || []) as string[]);
        return [...localUnits].some(id => soldUnitIds.has(id) && cloudUnits.has(id));
      });
      const row = candidates[0];
      if (!row) throw new Error(`Cloud sale item could not be matched for ${local.name}`);
      used.add(row.id);
      const unitIds = local.unitIds?.filter(id => soldUnitIds.has(id)).slice(0, qty);
      if (localUnits.size > 0 && unitIds?.length !== qty) throw new Error(`Tracked unit availability changed for ${local.name}. Please search the bill again.`);
      return { sale_item_id: row.id, qty, ...(unitIds?.length ? { unit_ids: unitIds } : {}) };
    });
  };

  const doProcess = async () => {
    if (!bill || selected.length === 0 || processing) return;
    const selectedItems = selected.map(itemIdx => ({ itemIdx, qty: Math.floor(returnQty[itemIdx] || 0) })).filter(x => x.qty > 0);
    if (!selectedItems.length) return;
    setProcessing(true); setError('');
    try {
      const online = typeof navigator === 'undefined' || navigator.onLine;
      if (online && supabaseConfigured && supabase) {
        const shop = await ensureCloudShop('Nexfix Shop');
        if (!shop.ok || !shop.shopId) throw new Error(shop.error || 'Cloud shop is unavailable');
        const cloudLines = await resolveCloudLines(shop.shopId, bill, selectedItems);
        const cloud = await processSaleReturnAtomic({
          shopId: shop.shopId, returnId: crypto.randomUUID(), saleId: bill.id, reason, mode,
          paymentMethod: mode === 'refund' ? 'cash' : undefined, lines: cloudLines,
        });
        if (!cloud.ok) throw new Error(cloud.error || 'Cloud return was not committed');
      }
      processExchange(bill.id, selectedItems, reason, mode);
      setBill(null); setQuery(''); setSearched(false); setConfirm(false); setSelected([]); setReturnQty({});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Return could not be completed');
    } finally { setProcessing(false); }
  };

  return (
    <div>
      <PageHeading chip="After-sales" chipTone="amber" title="Exchanges / Returns" sub={`${state.settings.exchangeDays}-day exchange policy · ${state.exchanges.length} exchanges processed`} />
      <div className="card p-6 mb-6">
        <h3 className="font-bold text-ink flex items-center gap-2 mb-4"><span className="w-8 h-8 rounded-lg bg-violet-500/10 text-violet-500 flex items-center justify-center"><ArrowLeftRight size={15} /></span>Process Exchange</h3>
        <div className="flex flex-col sm:flex-row gap-2.5"><div className="relative flex-1"><ScanSearch size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" /><input className="input pl-9 num" placeholder="Enter bill number (e.g. NFX-20260813-1042)" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()} /></div><button className="btn btn-primary" onClick={search} disabled={!query.trim()}><ScanSearch size={15} /> Search Bill</button></div>
        {searched && !bill && <div className="mt-5 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-4 py-3.5 text-sm text-rose-500 font-medium flex items-center gap-2"><ShieldAlert size={16} /> No bill found for “{query}”. Check the number and try again.</div>}
        {error && <div className="mt-5 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-4 py-3.5 text-sm text-rose-500 font-medium flex items-center gap-2"><ShieldAlert size={16} /> {error}</div>}
        {bill && <div className="mt-5 space-y-4">
          <div className="flex flex-wrap items-center gap-3"><Badge tone="violet" className="num">{bill.billNo}</Badge><span className="text-[13px] text-sub flex items-center gap-1.5"><CalendarClock size={13} className="text-faint" />{fmtDateTime(bill.date)}</span><span className="text-[13px] text-sub">{bill.customerName}</span>{bill.status !== 'completed' ? <Badge tone="rose">ALREADY {bill.status.toUpperCase()}</Badge> : withinPolicy ? <Badge tone="emerald"><CheckCircle2 size={11} /> WITHIN {state.settings.exchangeDays}-DAY POLICY</Badge> : <Badge tone="rose"><ShieldAlert size={11} /> POLICY EXPIRED</Badge>}</div>
          <div className="rounded-xl border border-line overflow-hidden"><table className="w-full"><thead><tr><th className="th w-10"></th><th className="th">Item</th><th className="th">Qty</th><th className="th">Price</th><th className="th !text-right">Amount</th></tr></thead><tbody>{bill.items.map((it, i) => <tr key={i} className={`cursor-pointer transition-colors ${selected.includes(i) ? 'bg-violet-500/[0.07]' : 'hover:bg-raised/40'}`} onClick={() => toggle(i)}><td className="td"><span className={`w-[18px] h-[18px] rounded-[5px] border flex items-center justify-center transition-all ${selected.includes(i) ? 'bg-violet-600 border-violet-600 text-white' : 'border-line bg-surface'}`}>{selected.includes(i) && <CheckCircle2 size={12} strokeWidth={3} />}</span></td><td className="td font-medium text-[13px]">{it.name}</td><td className="td num">{it.qty}</td><td className="td num">{fmtRs(it.price)}</td><td className="td num font-semibold text-right">{selected.includes(i) ? <input type="number" min={1} max={it.qty} className="input w-20 !py-1 text-right" value={returnQty[i] || ''} onClick={ev => ev.stopPropagation()} onChange={ev => setReturnQty(q => ({ ...q, [i]: Math.max(0, Math.min(it.qty, Number(ev.target.value) || 0)) }))} aria-label={`Return quantity for ${it.name}`} /> : it.qty}</td></tr>)}</tbody></table></div>
          <div className="grid sm:grid-cols-2 gap-4"><div><span className="block text-[11px] font-bold tracking-wider uppercase text-sub mb-1.5">Reason</span><select className="input" value={reason} onChange={e => setReason(e.target.value)}>{['Defective item', 'Wrong model / color', 'Customer changed mind', 'Not working as expected', 'Damaged on arrival'].map(r => <option key={r}>{r}</option>)}</select></div><div><span className="block text-[11px] font-bold tracking-wider uppercase text-sub mb-1.5">Resolution</span><div className="grid grid-cols-2 gap-2"><button className={`btn ${mode === 'replace' ? 'btn-primary' : 'btn-soft'}`} onClick={() => setMode('replace')}><Repeat2 size={14} /> Replace item</button><button className={`btn ${mode === 'refund' ? 'btn-primary' : 'btn-soft'}`} onClick={() => setMode('refund')} disabled={!can('act:refund')}><RotateCcw size={14} /> Refund cash</button></div></div></div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-raised border border-line px-4 py-3.5"><span className="text-sm text-sub">{selected.reduce((sum, i) => sum + (returnQty[i] || 0), 0)} unit(s) selected</span><div className="flex items-center gap-4">{mode === 'refund' ? <span className="text-sm">Refund: <b className="num text-rose-500">{fmtRs(selectedSum)}</b></span> : <span className="text-sm">Restock value: <b className="num text-emerald-500">{fmtRs(selectedSum)}</b></span>}<button className="btn btn-primary" disabled={selected.length === 0 || bill.status !== 'completed' || !withinPolicy || processing} onClick={() => setConfirm(true)}><ArrowLeftRight size={15} /> {processing ? 'Processing…' : `Process ${mode === 'refund' ? 'return' : 'exchange'}`}</button></div></div>
          {!withinPolicy && <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">This bill is older than {state.settings.exchangeDays} days — outside the exchange policy window.</p>}
        </div>}
      </div>
      <div className="card overflow-hidden"><div className="px-6 pt-5 pb-3"><h3 className="font-bold text-ink">Exchange History</h3></div>{state.exchanges.length === 0 ? <EmptyState icon={<ArrowLeftRight size={26} />} title="No exchanges yet." /> : <div className="overflow-x-auto"><table className="w-full min-w-[780px]"><thead><tr><th className="th">Exchange #</th><th className="th">Bill #</th><th className="th">Date</th><th className="th">Reason</th><th className="th">Items</th><th className="th">By</th><th className="th !text-right">Refund</th></tr></thead><tbody>{state.exchanges.map(x => <tr key={x.id} className="hover:bg-raised/40 transition-colors"><td className="td font-bold text-violet-500">{x.exNo}</td><td className="td text-[13px] text-sub num">{x.billNo}</td><td className="td text-[13px] text-sub">{fmtDate(x.date)}</td><td className="td text-[13px]">{x.reason}</td><td className="td text-[12px] text-sub max-w-[220px]">{x.items.map(i => `${i.name} ×${i.qty}`).join(', ')}</td><td className="td text-[13px] text-sub">{x.by}</td><td className="td num font-bold text-right">{x.refund > 0 ? <span className="text-rose-500">{fmtRs(x.refund)}</span> : <span className="text-faint">—</span>}</td></tr>)}</tbody></table></div>}</div>
      <Modal open={confirm} onClose={() => !processing && setConfirm(false)} title={mode === 'refund' ? 'Confirm return' : 'Confirm exchange'} sub={bill?.billNo}><p className="text-sm text-sub">{mode === 'refund' ? <>Return <b className="num text-ink">{fmtRs(selectedSum)}</b> cash to the customer and record the return atomically.</> : <>Restock the selected returned item(s) and record the return atomically. The replacement item must be processed as a separate sale so its stock and revenue are recorded.</>}</p><div className="flex gap-2.5 mt-5"><button className="btn btn-primary flex-1" onClick={doProcess} disabled={processing}><CheckCircle2 size={15} /> {processing ? 'Processing…' : 'Confirm'}</button><button className="btn btn-soft flex-1" onClick={() => setConfirm(false)} disabled={processing}>Cancel</button></div></Modal>
    </div>
  );
}
