import { useMemo, useState } from 'react';
import { FileText, Plus, Trash2, ShoppingCart, Printer } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, Modal, Field, PageHeading, EmptyState, SearchInput } from '../components/ui';
import { fmtDate, fmtRs, uid } from '../lib/utils';
import type { Quotation, QuotationItem, QuoteStatus } from '../lib/types';

const STATUS_TONE: Record<QuoteStatus, 'slate' | 'blue' | 'emerald' | 'rose' | 'amber' | 'violet'> = {
  draft: 'slate', sent: 'blue', accepted: 'emerald', rejected: 'rose', expired: 'amber', converted: 'violet',
};

function loadQuotes(): Quotation[] {
  try {
    const raw = localStorage.getItem('nexfix_pos_v2');
    if (!raw) return [];
    return (JSON.parse(raw).quotations as Quotation[]) || [];
  } catch { return []; }
}

function persistQuotes(list: Quotation[], countersPatch?: Record<string, number>) {
  try {
    const raw = localStorage.getItem('nexfix_pos_v2');
    if (!raw) return;
    const data = JSON.parse(raw);
    data.quotations = list;
    if (countersPatch) data.counters = { ...data.counters, ...countersPatch };
    localStorage.setItem('nexfix_pos_v2', JSON.stringify(data));
  } catch { /* ignore */ }
}

function esc(value: string) {
  return value.replace(/[&<>\"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] || ch));
}

export default function Quotations() {
  const { user, logAudit, state } = usePOS();
  const [q, setQ] = useState('');
  const [quotes, setQuotes] = useState<Quotation[]>(() => loadQuotes());
  const [editing, setEditing] = useState<Quotation | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [msg, setMsg] = useState('');

  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    return quotes.filter(x => !query || x.quoteNo.toLowerCase().includes(query) || x.customerName.toLowerCase().includes(query) || (x.customerPhone || '').includes(query));
  }, [quotes, q]);

  const openNew = () => {
    setEditing({ id: uid(), quoteNo: 'Q-TEMP', customerName: '', customerPhone: '', status: 'draft', items: [{ name: '', qty: 1, price: 0 }], subtotal: 0, discount: 0, tax: 0, total: 0, createdAt: new Date().toISOString(), by: user?.name || 'Staff' });
    setIsNew(true);
  };

  const recalc = (items: QuotationItem[], discount = 0, tax = 0) => {
    const subtotal = items.reduce((s, it) => s + it.price * it.qty - (it.discount || 0), 0);
    return { subtotal: Math.max(0, subtotal), total: Math.max(0, subtotal - discount + tax) };
  };

  const updateItem = (idx: number, patch: Partial<QuotationItem>) => {
    if (!editing) return;
    const items = editing.items.map((it, i) => i === idx ? { ...it, ...patch } : it);
    const { subtotal, total } = recalc(items, editing.discount, editing.tax);
    setEditing({ ...editing, items, subtotal, total });
  };

  const save = () => {
    if (!editing || !editing.customerName.trim()) return setMsg('Customer name is required');
    if (!editing.items.some(it => it.name.trim() && it.qty > 0)) return setMsg('Add at least one quotation item');
    const seq = ((state.counters as { quote?: number }).quote || quotes.length || 0) + 1;
    const quoteNo = isNew ? `QT-${String(seq).padStart(4, '0')}` : editing.quoteNo;
    const saved: Quotation = { ...editing, quoteNo, customerName: editing.customerName.trim(), customerPhone: editing.customerPhone?.trim(), items: editing.items.filter(it => it.name.trim() && it.qty > 0) };
    const next = isNew ? [saved, ...quotes] : quotes.map(x => x.id === saved.id ? saved : x);
    setQuotes(next); persistQuotes(next, isNew ? { quote: seq } : undefined);
    logAudit(isNew ? 'CREATE' : 'UPDATE', 'Quotation', `${saved.quoteNo} · ${saved.customerName}`);
    setEditing(null); setIsNew(false); setMsg('');
  };

  const convertToSale = (quote: Quotation) => {
    const lines = quote.items.filter(it => it.name.trim()).map(it => {
      const product = state.products.find(p => p.name.toLowerCase() === it.name.toLowerCase() || p.id === it.productId);
      return { productId: product?.id || '', name: it.name, qty: it.qty, price: it.price };
    });
    try { sessionStorage.setItem('nexfix_quote_convert', JSON.stringify({ quoteId: quote.id, quoteNo: quote.quoteNo, customerName: quote.customerName, customerPhone: quote.customerPhone, lines })); } catch { /* ignore */ }
    const next = quotes.map(x => x.id === quote.id ? { ...x, status: 'converted' as const } : x);
    setQuotes(next); persistQuotes(next); logAudit('CONVERT', 'Quotation', `${quote.quoteNo} → POS`); window.location.hash = '#/pos';
  };

  const printQuote = (quote: Quotation) => {
    const s = state.settings;
    const currency = s.invoiceCurrency || 'Rs.';
    const title = s.invoiceTitle || 'QUOTATION';
    const subtitle = s.invoiceSubtitle || s.tagline || '';
    const terms = (s.invoiceTerms || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const rowsHtml = quote.items.map((it, i) => `<tr><td>${i + 1}</td><td>${esc(it.name)}</td><td class="num">${it.qty}</td><td class="num">${currency} ${fmtRs(it.price)}</td><td class="num">${currency} ${fmtRs(it.price * it.qty - (it.discount || 0))}</td></tr>`).join('');
    const win = window.open('', '_blank', 'noopener,noreferrer,width=900,height=900');
    if (!win) { setMsg('Allow pop-ups to print the quotation'); return; }
    win.document.write(`<!doctype html><html><head><title>${esc(quote.quoteNo)} - ${esc(title)}</title><style>@page{size:A4;margin:14mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#111;margin:0;font-size:12px}.head{display:flex;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:16px;margin-bottom:18px}.brand h1{margin:0;font-size:25px}.brand p{margin:5px 0 0;color:#555}.meta{text-align:right}.meta h2{margin:0 0 7px;font-size:21px}.customer{margin:14px 0 20px;display:flex;justify-content:space-between}.box{border:1px solid #ddd;border-radius:6px;padding:10px;min-width:45%}table{width:100%;border-collapse:collapse}th{background:#f3f4f6;text-align:left}th,td{padding:8px;border-bottom:1px solid #ddd}.num{text-align:right}.totals{margin-left:auto;width:300px;margin-top:18px}.totals div{display:flex;justify-content:space-between;padding:4px 0}.grand{font-size:16px;font-weight:700;border-top:2px solid #111;margin-top:5px;padding-top:8px}.terms{margin-top:24px}.terms li{margin:4px 0}.foot{margin-top:35px;padding-top:12px;border-top:1px solid #ddd;text-align:center;color:#666;white-space:pre-line}@media print{button{display:none}}</style></head><body><div class="head"><div class="brand"><h1>${esc(s.shopName || 'Nexfix POS')}</h1><p>${esc(subtitle)}</p><p>${esc(s.address || '')}<br>${esc(s.phone || '')}${s.email ? ` · ${esc(s.email)}` : ''}</p></div><div class="meta"><h2>${esc(title)}</h2><div><b>No:</b> ${esc(quote.quoteNo)}</div><div><b>Date:</b> ${esc(fmtDate(quote.createdAt))}</div>${quote.validUntil ? `<div><b>Valid until:</b> ${esc(fmtDate(quote.validUntil))}</div>` : ''}</div></div><div class="customer"><div class="box"><b>Quotation For</b><br>${esc(quote.customerName)}${quote.customerPhone ? `<br>${esc(quote.customerPhone)}` : ''}</div><div class="box"><b>Status</b><br>${esc(quote.status.toUpperCase())}</div></div><table><thead><tr><th>#</th><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead><tbody>${rowsHtml}</tbody></table><div class="totals"><div><span>Subtotal</span><b>${currency} ${fmtRs(quote.subtotal)}</b></div>${quote.discount ? `<div><span>Discount</span><b>- ${currency} ${fmtRs(quote.discount)}</b></div>` : ''}${s.invoiceShowTax !== false ? `<div><span>${esc(s.invoiceTaxLabel || 'Tax')}</span><b>${currency} ${fmtRs(quote.tax)}</b></div>` : ''}<div class="grand"><span>Total</span><span>${currency} ${fmtRs(quote.total)}</span></div></div>${quote.notes ? `<div class="terms"><b>Notes</b><p style="white-space:pre-line">${esc(quote.notes)}</p></div>` : ''}${terms.length ? `<div class="terms"><b>Terms & Conditions</b><ul>${terms.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}<div class="foot">${esc(s.invoiceFooter || s.receiptFooter || 'Thank you!')}</div><script>window.onload=()=>{window.print();setTimeout(()=>window.close(),500)}</script></body></html>`);
    win.document.close();
  };

  return <div className="space-y-4">
    <PageHeading chip="Sales" title="Quotations" sub="Create, customize, edit, print and convert customer quotations" actions={<button type="button" onClick={openNew} className="btn btn-primary"><Plus size={16} /> New Quote</button>} />
    <SearchInput value={q} onChange={setQ} placeholder="Search quote no, customer…" />
    {rows.length === 0 ? <EmptyState icon={<FileText size={28} />} title="No quotations yet" sub="Create an estimate before converting it to a sale." /> : <div className="card overflow-hidden"><table className="w-full text-sm"><thead className="bg-raised/60 text-left text-[11px] uppercase tracking-wider text-sub"><tr><th className="px-4 py-3">Quote #</th><th className="px-4 py-3">Customer</th><th className="px-4 py-3">Total</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Date</th><th className="px-4 py-3" /></tr></thead><tbody>{rows.map(r => <tr key={r.id} className="border-t border-line hover:bg-raised/40 cursor-pointer" onClick={() => { setEditing(r); setIsNew(false); }}><td className="px-4 py-3 font-semibold text-ink">{r.quoteNo}</td><td className="px-4 py-3">{r.customerName}</td><td className="px-4 py-3 num font-medium">{fmtRs(r.total)}</td><td className="px-4 py-3"><Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge></td><td className="px-4 py-3 text-sub">{fmtDate(r.createdAt)}</td><td className="px-4 py-3 text-right" onClick={e => e.stopPropagation()}><button type="button" className="btn btn-soft !py-1.5 !px-3 text-xs" onClick={() => printQuote(r)}><Printer size={14} /> Print</button>{r.status !== 'converted' && r.status !== 'rejected' && <button type="button" className="btn btn-soft !py-1.5 !px-3 text-xs ml-2" onClick={() => convertToSale(r)}><ShoppingCart size={14} /> To Sale</button>}</td></tr>)}</tbody></table></div>}
    <Modal open={!!editing} onClose={() => { setEditing(null); setMsg(''); }} title={isNew ? 'New Quotation' : editing?.quoteNo || 'Quote'} sub={editing?.customerName} wide>
      {editing && <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3"><Field label="Customer name"><input className="input" value={editing.customerName} onChange={e => setEditing({ ...editing, customerName: e.target.value })} /></Field><Field label="Phone"><input className="input" value={editing.customerPhone || ''} onChange={e => setEditing({ ...editing, customerPhone: e.target.value })} /></Field><Field label="Valid until"><input type="date" className="input" value={editing.validUntil ? editing.validUntil.slice(0, 10) : ''} onChange={e => setEditing({ ...editing, validUntil: e.target.value ? new Date(`${e.target.value}T23:59:59`).toISOString() : undefined })} /></Field></div>
        <div className="space-y-2"><div className="flex items-center justify-between"><span className="text-[11px] font-bold uppercase tracking-wider text-sub">Line items</span><button type="button" className="text-sm text-violet-600 font-medium" onClick={() => setEditing({ ...editing, items: [...editing.items, { name: '', qty: 1, price: 0 }] })}>+ Add line</button></div>{editing.items.map((it, idx) => <div key={idx} className="flex flex-wrap gap-2 items-center"><input placeholder="Item / service" className="input flex-1 min-w-[140px]" value={it.name} onChange={e => updateItem(idx, { name: e.target.value })} /><input type="number" min="0" className="input w-20" value={it.qty} onChange={e => updateItem(idx, { qty: Number(e.target.value) || 0 })} /><input type="number" min="0" className="input w-28" value={it.price} onChange={e => updateItem(idx, { price: Number(e.target.value) || 0 })} /><input type="number" min="0" className="input w-28" placeholder="Line discount" value={it.discount || ''} onChange={e => updateItem(idx, { discount: Number(e.target.value) || 0 })} /><button type="button" className="icon-btn text-rose-500" onClick={() => { const items = editing.items.filter((_, i) => i !== idx); const { subtotal, total } = recalc(items, editing.discount, editing.tax); setEditing({ ...editing, items, subtotal, total }); }}><Trash2 size={14} /></button></div>)}</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3"><Field label="Overall discount"><input type="number" min="0" className="input num" value={editing.discount || ''} onChange={e => { const discount = Number(e.target.value) || 0; const { subtotal, total } = recalc(editing.items, discount, editing.tax); setEditing({ ...editing, discount, subtotal, total }); }} /></Field><Field label="Tax amount"><input type="number" min="0" className="input num" value={editing.tax || ''} onChange={e => { const tax = Number(e.target.value) || 0; const { subtotal, total } = recalc(editing.items, editing.discount, tax); setEditing({ ...editing, tax, subtotal, total }); }} /></Field><Field label="Status"><select className="input" value={editing.status} onChange={e => setEditing({ ...editing, status: e.target.value as QuoteStatus })}><option value="draft">Draft</option><option value="sent">Sent</option><option value="accepted">Accepted</option><option value="rejected">Rejected</option><option value="expired">Expired</option></select></Field></div>
        <Field label="Quotation notes"><textarea className="input min-h-[75px] resize-y" value={editing.notes || ''} onChange={e => setEditing({ ...editing, notes: e.target.value })} placeholder="Special notes for this customer / quotation" /></Field>
        <div className="rounded-xl bg-raised border border-line p-4 text-xs text-sub">Print design uses this shop's <b>name, tagline, address, phone, email, currency, quotation title/subtitle, tax label, terms and footer</b> from Settings. Each quotation can additionally have its own customer, validity date, notes, items, discounts, tax and status.</div>
        <div className="flex flex-wrap justify-between items-center gap-3 pt-3 border-t border-line"><span className="text-lg font-bold num">Total: {fmtRs(editing.total)}</span><div className="flex gap-2"><button type="button" className="btn btn-soft" onClick={() => printQuote(editing)}><Printer size={15} /> Print / PDF</button>{!isNew && editing.status !== 'converted' && editing.status !== 'rejected' && <button type="button" className="btn btn-soft" onClick={() => convertToSale(editing)}><ShoppingCart size={15} /> Convert to Sale</button>}<button type="button" className="btn btn-primary" onClick={save}>Save</button></div></div>
        {msg && <p className="text-sm text-rose-500">{msg}</p>}
      </div>}
    </Modal>
  </div>;
}
