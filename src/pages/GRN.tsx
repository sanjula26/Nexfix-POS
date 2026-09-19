import { useRef, useState } from 'react';
import { ClipboardCheck, Plus, Pencil, Printer, Zap, Trash2, X, Search, PackageCheck } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, EmptyState, Field, Modal, PageHeading } from '../components/ui';
import { fmtDate, fmtRs } from '../lib/utils';
import type { Purchase, PurchaseItem } from '../lib/types';

interface Row { productId: string; qty: number; cost: number; sellingPrice: number; updateSellingPrice: boolean; }
const emptyRow = (): Row => ({ productId: '', qty: 1, cost: 0, sellingPrice: 0, updateSellingPrice: false });

function grnPrintHtml(grn: Purchase, shopName: string) {
  const rows = grn.items.map(i => `<tr><td>${i.name}</td><td class="num">${i.qty}</td><td class="num">${fmtRs(i.cost)}</td><td class="num">${fmtRs(i.qty * i.cost)}</td></tr>`).join('');
  return `<!doctype html><html><head><title>${grn.poNo}</title><style>@page{size:A4;margin:14mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#111;margin:0;font-size:12px}.head{display:flex;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:14px;margin-bottom:18px}.head h1{margin:0;font-size:24px}.meta{text-align:right}.meta h2{margin:0 0 6px;font-size:20px}p{margin:5px 0;color:#555}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border-bottom:1px solid #ddd;padding:9px;text-align:left}th{background:#f3f4f6}.num{text-align:right}.total{margin-left:auto;width:280px;text-align:right;font-size:18px;font-weight:700;border-top:2px solid #111;padding-top:9px;margin-top:18px}.notes{margin-top:24px;white-space:pre-line}@media print{button{display:none}}</style></head><body><div class="head"><div><h1>${shopName}</h1><p>Goods Received Note</p></div><div class="meta"><h2>${grn.poNo}</h2><div>${fmtDate(grn.date)}</div><div>Status: <b>${grn.status === 'received' ? 'PROCESSED' : 'DRAFT'}</b></div></div></div><p><b>Supplier:</b> ${grn.supplierName}</p>${grn.supplierInvoiceNo ? `<p><b>Supplier Invoice:</b> ${grn.supplierInvoiceNo}</p>` : ''}<table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Cost</th><th class="num">Total</th></tr></thead><tbody>${rows}</tbody></table><div class="total">Total: ${fmtRs(grn.total)}</div>${grn.notes ? `<div class="notes"><b>Notes</b><p>${grn.notes}</p></div>` : ''}</body></html>`;
}

export default function GRN() {
  const { state, user, saveGRNDraft, updateGRNDraft, processGRN, deletePurchase, can } = usePOS();
  const [printPreview, setPrintPreview] = useState<{ grn: Purchase; html: string } | null>(null);
  const [printReady, setPrintReady] = useState(false);
  const printFrame = useRef<HTMLIFrameElement | null>(null);
  const [view, setView] = useState<'list' | 'form'>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [supplierId, setSupplierId] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [search, setSearch] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [priceChanges, setPriceChanges] = useState<Array<{ name: string; old: number; next: number }>>([]);
  const drafts = state.purchases.filter(p => p.status === 'pending');
  const processed = state.purchases.filter(p => p.status === 'received');
  const q = search.trim().toLowerCase();
  const list = state.purchases.filter(p => !q || p.poNo.toLowerCase().includes(q) || p.supplierName.toLowerCase().includes(q) || (p.supplierInvoiceNo || '').toLowerCase().includes(q)).sort((a, b) => +new Date(b.date) - +new Date(a.date));

  const setRow = (index: number, patch: Partial<Row>) => setRows(prev => prev.map((r, i) => {
    if (i !== index) return r;
    const next = { ...r, ...patch };
    if (patch.productId) {
      const p = state.products.find(x => x.id === patch.productId);
      if (p) { next.cost = p.cost; next.sellingPrice = p.price; }
    }
    return next;
  }));

  const startNew = () => { setEditingId(null); setSupplierId(''); setInvoiceNo(''); setNotes(''); setRows([emptyRow()]); setView('form'); };
  const edit = (p: Purchase) => { setEditingId(p.id); setSupplierId(p.supplierId); setInvoiceNo(p.supplierInvoiceNo || ''); setNotes(p.notes || ''); setRows(p.items.map(i => ({ productId: i.productId, qty: i.qty, cost: i.cost, sellingPrice: i.sellingPrice ?? state.products.find(x => x.id === i.productId)?.price ?? 0, updateSellingPrice: !!i.updateSellingPrice }))); setView('form'); };

  const buildItems = (): PurchaseItem[] => rows.filter(r => r.productId && r.qty > 0).map(r => ({ productId: r.productId, name: state.products.find(p => p.id === r.productId)?.name || '', qty: Math.floor(r.qty), cost: Math.max(0, r.cost), sellingPrice: Math.max(0, r.sellingPrice), updateSellingPrice: r.updateSellingPrice }));

  const saveDraft = () => {
    const supplier = state.suppliers.find(s => s.id === supplierId);
    const items = buildItems();
    if (!supplier || !items.length) return;
    const payload = { supplierId: supplier.id, supplierName: supplier.name, supplierInvoiceNo: invoiceNo.trim() || undefined, notes: notes.trim() || undefined, items, total: items.reduce((sum, i) => sum + i.qty * i.cost, 0) };
    if (editingId) updateGRNDraft(editingId, payload); else saveGRNDraft(payload);
    setView('list');
  };

  const askProcess = () => {
    const supplier = state.suppliers.find(s => s.id === supplierId);
    const items = buildItems();
    if (!supplier || !items.length) return;
    const conflicts = items.map(i => { const p = state.products.find(x => x.id === i.productId); return p && i.updateSellingPrice && i.sellingPrice !== p.price ? { name: p.name, old: p.price, next: i.sellingPrice || p.price } : null; }).filter(Boolean) as Array<{ name: string; old: number; next: number }>;
    setPriceChanges(conflicts);
    if (editingId) { updateGRNDraft(editingId, { supplierId: supplier.id, supplierName: supplier.name, supplierInvoiceNo: invoiceNo.trim() || undefined, notes: notes.trim() || undefined, items, total: items.reduce((sum, i) => sum + i.qty * i.cost, 0) }); setConfirmId(editingId); return; }
    const created = saveGRNDraft({ supplierId: supplier.id, supplierName: supplier.name, supplierInvoiceNo: invoiceNo.trim() || undefined, notes: notes.trim() || undefined, items, total: items.reduce((sum, i) => sum + i.qty * i.cost, 0) });
    if (created) setConfirmId(created.id);
  };

  const process = () => { if (confirmId) processGRN(confirmId, user?.name || 'Unknown'); setConfirmId(null); setPriceChanges([]); setView('list'); };

  return <div>
    <PageHeading chip="Procurement" chipTone="blue" title="Goods Received Notes" sub={`${processed.length} processed · ${drafts.length} drafts`} actions={<button className="btn btn-primary" onClick={startNew}><Plus size={15} /> New GRN</button>} />
    <div className="card p-4 mb-5"><div className="grid grid-cols-1 md:grid-cols-3 gap-3"><div className="rounded-xl bg-raised border border-line p-3"><div className="text-[10px] uppercase font-bold tracking-wider text-faint">Processed GRNs</div><div className="num text-xl font-extrabold mt-1">{processed.length}</div></div><div className="rounded-xl bg-raised border border-line p-3"><div className="text-[10px] uppercase font-bold tracking-wider text-faint">Draft GRNs</div><div className="num text-xl font-extrabold mt-1">{drafts.length}</div></div><div className="rounded-xl bg-raised border border-line p-3"><div className="text-[10px] uppercase font-bold tracking-wider text-faint">Received value</div><div className="num text-xl font-extrabold mt-1">{fmtRs(processed.reduce((s, p) => s + p.total, 0))}</div></div></div></div>
    {view === 'form' ? <div className="card p-5"><div className="flex items-center justify-between mb-5"><div><h2 className="font-bold text-ink">{editingId ? 'Edit GRN draft' : 'New GRN'}</h2><p className="text-xs text-sub mt-1">Stock is updated only when the GRN is processed.</p></div><button className="btn btn-soft" onClick={() => setView('list')}><X size={14} /> Close</button></div><div className="grid md:grid-cols-2 gap-4"><Field label="Supplier"><select className="input" value={supplierId} onChange={e => setSupplierId(e.target.value)}><option value="">Select supplier...</option>{state.suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field><Field label="Supplier invoice number"><input className="input" value={invoiceNo} onChange={e => setInvoiceNo(e.target.value)} placeholder="Optional" /></Field><Field label="Notes"><input className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional receiving note" /></Field></div><div className="mt-5"><div className="flex items-center justify-between mb-2"><span className="text-xs font-bold uppercase tracking-wider text-sub">Items</span><button className="btn btn-soft !text-xs" onClick={() => setRows(r => [...r, emptyRow()])}><Plus size={13} /> Add line</button></div><div className="space-y-2">{rows.map((r, i) => <div key={i} className="grid grid-cols-[1fr_75px_110px_120px_36px] gap-2 items-center"><select className="input" value={r.productId} onChange={e => setRow(i, { productId: e.target.value })}><option value="">Select product...</option>{state.products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><input className="input num" type="number" min="1" value={r.qty || ''} onChange={e => setRow(i, { qty: Number(e.target.value) || 0 })} placeholder="Qty" /><input className="input num" type="number" min="0" step="0.01" value={r.cost || ''} onChange={e => setRow(i, { cost: Number(e.target.value) || 0 })} placeholder="Cost" /><label className="flex items-center gap-2 text-xs text-sub"><input type="checkbox" checked={r.updateSellingPrice} onChange={e => setRow(i, { updateSellingPrice: e.target.checked })} /> Set sell price <span className="num">{r.sellingPrice.toLocaleString()}</span></label><button className="icon-btn !w-8 !h-8" disabled={rows.length === 1} onClick={() => setRows(rs => rs.filter((_, idx) => idx !== i))}><X size={14} /></button></div>)}</div></div><div className="flex items-center justify-between rounded-xl bg-violet-500/[0.06] border border-violet-500/15 px-4 py-3 mt-5"><span className="font-semibold text-sub">GRN Total</span><span className="num text-lg font-extrabold text-violet-500">{fmtRs(rows.reduce((s, r) => s + Math.max(0, r.qty) * Math.max(0, r.cost), 0))}</span></div><div className="flex gap-2.5 mt-5"><button className="btn btn-primary flex-1" onClick={saveDraft} disabled={!supplierId || !rows.some(r => r.productId && r.qty > 0)}><ClipboardCheck size={15} /> Save draft</button><button className="btn btn-outline-emerald flex-1" onClick={askProcess} disabled={!supplierId || !rows.some(r => r.productId && r.qty > 0)}><Zap size={15} /> Save & process</button></div></div> : <div className="card overflow-hidden"><div className="p-4 border-b border-line"><div className="relative max-w-md"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" /><input className="input pl-9" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search GRN, supplier or invoice..." /></div></div>{list.length === 0 ? <EmptyState icon={<ClipboardCheck size={26} />} title="No GRNs found" sub="Create a GRN draft to record incoming stock." /> : <div className="overflow-x-auto"><table className="w-full min-w-[900px]"><thead><tr><th className="th">GRN / PO</th><th className="th">Date</th><th className="th">Supplier</th><th className="th">Invoice</th><th className="th">Items</th><th className="th">Status</th><th className="th !text-right">Total</th><th className="th !text-right">Actions</th></tr></thead><tbody>{list.map(p => <tr key={p.id} className="hover:bg-raised/40"><td className="td font-bold text-violet-500">{p.poNo}</td><td className="td text-xs text-sub">{fmtDate(p.date)}</td><td className="td font-semibold">{p.supplierName}</td><td className="td text-xs text-sub">{p.supplierInvoiceNo || '—'}</td><td className="td text-xs text-sub">{p.items.map(i => `${i.name} ×${i.qty}`).join(', ')}</td><td className="td"><Badge tone={p.status === 'received' ? 'emerald' : 'amber'}>{p.status === 'received' ? <PackageCheck size={11} /> : <ClipboardCheck size={11} />}{p.status === 'received' ? 'PROCESSED' : 'DRAFT'}</Badge></td><td className="td num font-bold text-right">{fmtRs(p.total)}</td><td className="td"><div className="flex justify-end gap-1">{p.status === 'pending' && <button className="icon-btn !w-8 !h-8" title="Edit" onClick={() => edit(p)}><Pencil size={14} /></button>}<button className="icon-btn !w-8 !h-8" title="Print" onClick={() => setPrintReady(false); setPrintPreview({ grn: p, html: grnPrintHtml(p, state.settings.shopName) })}><Printer size={14} /></button>{p.status === 'pending' && <button className="btn btn-outline-emerald !py-1.5 !px-2.5 !text-xs" onClick={() => { setPriceChanges([]); setConfirmId(p.id); }}><Zap size={13} /> Process</button>}{p.status === 'pending' && can('act:deleteRecords') && <button className="icon-btn !w-8 !h-8 hover:!text-rose-500" onClick={() => setDeleteId(p.id)}><Trash2 size={14} /></button>}</div></td></tr>)}</tbody></table></div>}</div>}
    <Modal open={!!confirmId} onClose={() => setConfirmId(null)} title="Process GRN?" sub="Stock will be added once, and the GRN becomes immutable."><p className="text-sm text-sub">This action updates inventory and records the receipt in the inventory ledger. It cannot be repeated after processing.</p>{priceChanges.length > 0 && <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3"><p className="text-xs font-bold text-amber-600 mb-2">Selling price changes</p>{priceChanges.map(c => <p key={c.name} className="text-xs text-sub">{c.name}: {fmtRs(c.old)} → {fmtRs(c.next)}</p>)}</div>}<div className="flex gap-2 mt-5"><button className="btn btn-outline-emerald flex-1" onClick={process}><Zap size={14} /> Process GRN</button><button className="btn btn-soft flex-1" onClick={() => setConfirmId(null)}>Cancel</button></div></Modal>
    <Modal open={!!deleteId} onClose={() => setDeleteId(null)} title="Delete GRN draft?"><p className="text-sm text-sub">Only a draft can be deleted. Processed GRNs remain as permanent stock history.</p><div className="flex gap-2 mt-5"><button className="btn btn-danger-soft flex-1" onClick={() => { if (deleteId) deletePurchase(deleteId); setDeleteId(null); }}>Delete draft</button><button className="btn btn-soft flex-1" onClick={() => setDeleteId(null)}>Cancel</button></div></Modal>
    <Modal open={!!printPreview} onClose={() => { setPrintPreview(null); setPrintReady(false); }} title={printPreview ? 'GRN ' + printPreview.grn.poNo : 'GRN print preview'} sub="Preview the A4 goods received note before printing or saving as PDF" wide>
      {printPreview && <div className="space-y-3">
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-primary" onClick={() => printFrame.current?.contentWindow?.print()} disabled={!printReady}><Printer size={15} /> Print</button>
          <button type="button" className="btn btn-soft" onClick={() => printFrame.current?.contentWindow?.print()} disabled={!printReady}><Printer size={15} /> Download PDF</button>
          <button type="button" className="btn btn-soft" onClick={() => { setPrintPreview(null); setPrintReady(false); }}><X size={15} /> Close</button>
        </div>
        <div className="rounded-xl border border-line bg-slate-100 p-2"><iframe ref={printFrame} title="GRN print preview" srcDoc={printPreview.html} onLoad={() => setPrintReady(true)} className="w-full h-[70vh] rounded-lg bg-white border border-line" /></div>
        <p className="text-xs text-faint text-center">Use the browser print dialog and choose “Save as PDF” to download a PDF copy.</p>
      </div>}
    </Modal>
  </div>;
}