import { useRef, useState } from 'react';
import { ClipboardCheck, Plus, Pencil, Printer, Zap, Trash2, X, Search, PackageCheck } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, EmptyState, Field, Modal, PageHeading } from '../components/ui';
import { fmtDate, fmtRs } from '../lib/utils';
import type { Purchase, PurchaseItem } from '../lib/types';
import { validatePurchaseUnitIdentifiers } from '../lib/purchaseReconciliation';

interface Row { productId: string; qty: number; cost: number; sellingPrice: number; updateSellingPrice: boolean; unitText: string; }
const emptyRow = (): Row => ({ productId: '', qty: 1, cost: 0, sellingPrice: 0, updateSellingPrice: false, unitText: '' });

function grnPrintHtml(grn: Purchase, shopName: string) {
  const rows = grn.items.map(i => `<tr><td>${i.name}</td><td class="num">${i.qty}</td><td class="num">${fmtRs(i.cost)}</td><td class="num">${fmtRs(i.qty * i.cost)}</td></tr>`).join('');
  return `<!doctype html><html><head><title>${grn.poNo}</title><style>@page{size:A4;margin:14mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#111;margin:0;font-size:12px}.head{display:flex;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:14px;margin-bottom:18px}.head h1{margin:0;font-size:24px}.meta{text-align:right}.meta h2{margin:0 0 6px;font-size:20px}p{margin:5px 0;color:#555}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border-bottom:1px solid #ddd;padding:9px;text-align:left}th{background:#f3f4f6}.num{text-align:right}.total{margin-left:auto;width:280px;text-align:right;font-size:18px;font-weight:700;border-top:2px solid #111;padding-top:9px;margin-top:18px}.notes{margin-top:24px;white-space:pre-line}@media print{button{display:none}}</style></head><body><div class="head"><div><h1>${shopName}</h1><p>Goods Received Note</p></div><div class="meta"><h2>${grn.poNo}</h2><div>${fmtDate(grn.date)}</div><div>Status: <b>${grn.status === 'received' ? 'PROCESSED' : 'DRAFT'}</b></div></div></div><p><b>Supplier:</b> ${grn.supplierName}</p>${grn.supplierInvoiceNo ? `<p><b>Supplier Invoice:</b> ${grn.supplierInvoiceNo}</p>` : ''}<table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Cost</th><th class="num">Total</th></tr></thead><tbody>${rows}</tbody></table><div class="total">Total: ${fmtRs(grn.total)}</div>${grn.notes ? `<div class="notes"><b>Notes</b><p>${grn.notes}</p></div>` : ''}</body></html>`;
}

export default function GRN() {
  const { state, user, saveGRNDraft, updateGRNDraft, processGRN, deletePurchase, createPurchaseReturn, can } = usePOS();
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
  const [returnPurchase, setReturnPurchase] = useState<Purchase | null>(null);
  const [returnLines, setReturnLines] = useState<Array<{ itemIdx: number; maxQty: number; qty: number }>>([]);
  const [returnReason, setReturnReason] = useState('');
  const [formMode, setFormMode] = useState<'receive' | 'return'>('receive');
  const [returnGrnId, setReturnGrnId] = useState('');
  const [formError, setFormError] = useState('');
  const [actionRunning, setActionRunning] = useState(false);
  const drafts = state.purchases.filter(p => p.status === 'pending');
  const processed = state.purchases.filter(p => p.status === 'received');
  const q = search.trim().toLowerCase();
  const list = state.purchases.filter(p => !q || p.poNo.toLowerCase().includes(q) || p.supplierName.toLowerCase().includes(q) || (p.supplierInvoiceNo || '').toLowerCase().includes(q)).sort((a, b) => +new Date(b.date) - +new Date(a.date));

  const setRow = (index: number, patch: Partial<Row>) => setRows(prev => prev.map((r, i) => {
    if (i !== index) return r;
    const next = { ...r, ...patch };
    if (patch.productId) {
      const p = state.products.find(x => x.id === patch.productId);
      if (p) { next.cost = p.cost; next.sellingPrice = p.price; next.unitText = ''; }
    }
    return next;
  }));

  const startNew = () => { setFormError(''); setEditingId(null); setSupplierId(''); setInvoiceNo(''); setNotes(''); setRows([emptyRow()]); setFormMode('receive'); setReturnGrnId(''); setReturnPurchase(null); setReturnLines([]); setReturnReason(''); setView('form'); };
  const openReturn = (p: Purchase) => {
    const returnedByItem = new Map<number, number>();
    for (const ret of state.purchaseReturns || []) if (ret.purchaseId === p.id) for (const item of ret.items) returnedByItem.set(item.itemIdx, (returnedByItem.get(item.itemIdx) || 0) + item.qty);
    setReturnPurchase(p); setReturnReason('');
    setReturnLines(p.items.map((item, itemIdx) => {
      const already = returnedByItem.get(itemIdx) || 0;
      const product = state.products.find(x => x.id === item.productId);
      const stock = Math.max(0, product?.stock ?? 0);
      const tracked = !!(product?.trackImei || product?.trackSerial);
      const unitStock = tracked
        ? (state.units || []).filter(u => u.productId === item.productId && u.purchaseId === p.id && u.status === 'in_stock').length
        : Number.MAX_SAFE_INTEGER;
      const remaining = Math.max(0, item.qty - already);
      return { itemIdx, maxQty: Math.min(remaining, stock, unitStock), qty: 0 };
    }));
  };
  const edit = (p: Purchase) => { setFormError(''); setEditingId(p.id); setSupplierId(p.supplierId); setInvoiceNo(p.supplierInvoiceNo || ''); setNotes(p.notes || ''); setRows(p.items.map(i => ({ productId: i.productId, qty: i.qty, cost: i.cost, sellingPrice: i.sellingPrice ?? state.products.find(x => x.id === i.productId)?.price ?? 0, updateSellingPrice: !!i.updateSellingPrice, unitText: (i.unitIdentifiers || []).map(u => [u.imei, u.serial].filter(Boolean).join(',')).join('\\n') }))); setFormMode('receive'); setView('form'); };

  const buildItems = (): PurchaseItem[] => rows.filter(r => r.productId).map(r => {
    const product = state.products.find(p => p.id === r.productId);
    const qty = Math.floor(r.qty);
    const rawLines = r.unitText.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const unitIdentifiers = (product?.trackImei || product?.trackSerial)
      ? rawLines.map(line => {
          const parts = line.split(',').map(x => x.trim());
          if (product.trackImei && product.trackSerial) return { imei: parts[0] || '', serial: parts.slice(1).join(',').trim() };
          if (product.trackImei) return { imei: parts[0] || '' };
          return { serial: parts[0] || '' };
        })
      : undefined;
    return { productId: r.productId, name: product?.name || '', qty, cost: Math.max(0, r.cost), sellingPrice: Math.max(0, r.sellingPrice), updateSellingPrice: r.updateSellingPrice, ...(unitIdentifiers ? { unitIdentifiers } : {}) };
  });

  const validateForm = (items: PurchaseItem[]) => {
    if (!state.suppliers.some(s => s.id === supplierId)) return 'Select a supplier.';
    if (!items.length) return 'Add at least one valid product line.';
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.productId)) return 'Each product can appear only once per GRN.';
      seen.add(item.productId);
      const product = state.products.find(p => p.id === item.productId);
      if (product?.trackImei || product?.trackSerial) {
        const ids = item.unitIdentifiers || [];
        if (ids.length !== item.qty) return product.trackImei && product.trackSerial ? `${item.name}: enter one IMEI and Serial pair for every unit.` : product.trackImei ? `${item.name}: enter one IMEI for every unit.` : `${item.name}: enter one Serial number for every unit.`;
        if (ids.some(u => (product.trackImei && !u.imei?.trim()) || (product.trackSerial && !u.serial?.trim()))) return `${item.name}: every tracked unit must have the required identifier.`;
      }
    }
    const validationPurchase: Purchase = { id: 'validation', poNo: 'GRN-VALIDATION', date: new Date().toISOString(), supplierId, supplierName: state.suppliers.find(s => s.id === supplierId)?.name || '', items, total: items.reduce((sum, i) => sum + i.qty * i.cost, 0), status: 'pending' };
    const result = validatePurchaseUnitIdentifiers(validationPurchase, state.products, state.units || []);
    if (!result.ok) return result.error || 'IMEI/Serial validation failed.';
    return '';
  };

  const saveDraft = () => {
    if (actionRunning) return;
    const supplier = state.suppliers.find(s => s.id === supplierId);
    const items = buildItems();
    const error = validateForm(items);
    if (error) { setFormError(error); return; }
    if (!supplier) return;
    setActionRunning(true);
    setFormError('');
    try {
      const payload = { supplierId: supplier.id, supplierName: supplier.name, supplierInvoiceNo: invoiceNo.trim() || undefined, notes: notes.trim() || undefined, items, total: items.reduce((sum, i) => sum + i.qty * i.cost, 0) };
      const result = editingId ? updateGRNDraft(editingId, payload) : saveGRNDraft(payload);
      if (!result.ok) { setFormError(result.error || 'Unable to save this GRN draft.'); return; }
      setView('list');
    } finally {
      setActionRunning(false);
    }
  };

  const askProcess = () => {
    if (actionRunning) return;
    const supplier = state.suppliers.find(s => s.id === supplierId);
    const items = buildItems();
    const error = validateForm(items);
    if (error) { setFormError(error); return; }
    if (!supplier) return;
    setFormError('');
    const conflicts = items.map(i => { const p = state.products.find(x => x.id === i.productId); return p && i.updateSellingPrice && i.sellingPrice !== p.price ? { name: p.name, old: p.price, next: i.sellingPrice || p.price } : null; }).filter(Boolean) as Array<{ name: string; old: number; next: number }>;
    setPriceChanges(conflicts);
    setActionRunning(true);
    setFormError('');
    try {
      const payload = { supplierId: supplier.id, supplierName: supplier.name, supplierInvoiceNo: invoiceNo.trim() || undefined, notes: notes.trim() || undefined, items, total: items.reduce((sum, i) => sum + i.qty * i.cost, 0) };
      const result = editingId ? updateGRNDraft(editingId, payload) : saveGRNDraft(payload);
      if (!result.ok) { setFormError(result.error || 'Unable to save this GRN draft.'); return; }
      setConfirmId(editingId || result.purchase!.id);
    } finally {
      setActionRunning(false);
    }
  };

  const process = () => {
    if (!confirmId || actionRunning) return;
    const purchase = state.purchases.find(p => p.id === confirmId);
    if (!purchase || purchase.status !== 'pending') {
      setConfirmId(null); setPriceChanges([]);
      setFormError('This GRN is no longer available as a pending draft. Refresh the page and try again.');
      return;
    }
    const unitValidation = validatePurchaseUnitIdentifiers(purchase, state.products, state.units || []);
    if (!unitValidation.ok) {
      setConfirmId(null); setPriceChanges([]); setEditingId(purchase.id); setSupplierId(purchase.supplierId); setInvoiceNo(purchase.supplierInvoiceNo || ''); setNotes(purchase.notes || '');
      setRows(purchase.items.map(i => ({ productId: i.productId, qty: i.qty, cost: i.cost, sellingPrice: i.sellingPrice ?? state.products.find(x => x.id === i.productId)?.price ?? 0, updateSellingPrice: !!i.updateSellingPrice, unitText: (i.unitIdentifiers || []).map(u => [u.imei, u.serial].filter(Boolean).join(',')).join('\\n') })));
      setFormMode('receive'); setFormError(unitValidation.error || 'The GRN changed after the confirmation opened. Correct its IMEI/Serial data before processing.'); setView('form');
      return;
    }
    setActionRunning(true);
    try {
      const result = processGRN(confirmId, user?.name || 'Unknown');
      if (!result.ok) {
        setFormError(result.error || 'Unable to process this GRN. No stock was changed.');
        setConfirmId(null); setPriceChanges([]);
        setView('form');
        return;
      }
      setConfirmId(null); setPriceChanges([]);
      setFormError(''); setView('list');
    } finally {
      setActionRunning(false);
    }
  };

  return (
    <div>
      <PageHeading
        chip="Procurement"
        chipTone="blue"
        title="Goods Received Notes"
        sub={processed.length + ' processed · ' + drafts.length + ' drafts'}
        actions={<button className="btn btn-primary" onClick={startNew}><Plus size={15} /> New GRN</button>}
      />

      <div className="card p-4 mb-5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="rounded-xl bg-raised border border-line p-3">
            <div className="text-[10px] uppercase font-bold tracking-wider text-faint">Processed GRNs</div>
            <div className="num text-xl font-extrabold mt-1">{processed.length}</div>
          </div>
          <div className="rounded-xl bg-raised border border-line p-3">
            <div className="text-[10px] uppercase font-bold tracking-wider text-faint">Draft GRNs</div>
            <div className="num text-xl font-extrabold mt-1">{drafts.length}</div>
          </div>
          <div className="rounded-xl bg-raised border border-line p-3">
            <div className="text-[10px] uppercase font-bold tracking-wider text-faint">Received value</div>
            <div className="num text-xl font-extrabold mt-1">{fmtRs(processed.reduce((s, p) => s + p.total, 0))}</div>
          </div>
        </div>
      </div>

      {view === 'form' ? (
        <div className="card p-5">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="font-bold text-ink">{editingId ? 'Edit GRN draft' : formMode === 'return' ? 'New Supplier Return' : 'New GRN'}</h2>
              <p className="text-xs text-sub mt-1">
                {formMode === 'return' ? 'Return received items to the supplier and deduct stock automatically.' : 'Stock is updated only when the GRN is processed.'}
              </p>
            </div>
            <button className="btn btn-soft" onClick={() => setView('list')} disabled={actionRunning}><X size={14} /> Close</button>
          </div>

          {!editingId && (
            <div className="flex gap-2 p-1 rounded-xl bg-raised border border-line mb-5">
              <button className={`flex-1 btn ${formMode === 'receive' ? 'btn-primary' : 'btn-soft'}`} onClick={() => { setFormError(''); setFormMode('receive'); }} disabled={actionRunning}>
                <PackageCheck size={14} /> Receive Stock
              </button>
              <button className={`flex-1 btn ${formMode === 'return' ? 'bg-rose-600 text-white' : 'btn-soft'}`} onClick={() => { setFormError(''); setFormMode('return'); setReturnPurchase(null); setReturnLines([]); setReturnReason(''); setReturnGrnId(''); }} disabled={actionRunning}>
                <Trash2 size={14} /> Return to Supplier
              </button>
            </div>
          )}

          {formError && formMode === 'return' && (
            <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-4 py-3 text-sm text-rose-600 mb-4">{formError}</div>
          )}

          {formMode === 'return' ? (
            <div className="grid md:grid-cols-2 gap-4">
              <Field label="Processed GRN to return from">
                <select
                  className="input"
                  value={returnGrnId}
                  onChange={e => {
                    const id = e.target.value;
                    setReturnGrnId(id);
                    const p = processed.find(x => x.id === id);
                    if (p) openReturn(p);
                    else { setReturnPurchase(null); setReturnLines([]); }
                  }}
                  disabled={actionRunning}
                >
                  <option value="">Select processed GRN...</option>
                  {processed.map(p => <option key={p.id} value={p.id}>{p.poNo} · {p.supplierName} · {fmtDate(p.date)}</option>)}
                </select>
              </Field>
              <Field label="Return reason *">
                <select className="input" value={returnReason} onChange={e => setReturnReason(e.target.value)} disabled={actionRunning}>
                  <option value="">Select reason...</option>
                  <option>Defective / Damaged</option>
                  <option>Wrong item received</option>
                  <option>Excess quantity</option>
                  <option>Quality issue</option>
                  <option>Price dispute</option>
                  <option>Other</option>
                </select>
              </Field>

              {returnPurchase && (
                <div className="md:col-span-2 mt-5 space-y-2">
                  <div className="text-xs font-bold uppercase tracking-wider text-sub mb-2">Items to return</div>
                  {returnPurchase.items.map((item, itemIdx) => {
                    const line = returnLines.find(x => x.itemIdx === itemIdx) || { itemIdx, maxQty: 0, qty: 0 };
                    return (
                      <div key={itemIdx} className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3">
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold text-ink truncate">{item.name}</div>
                          <div className="text-xs text-sub">Received: {item.qty} · Available: {line.maxQty} · Cost: {fmtRs(item.cost)}</div>
                        </div>
                        <input
                          className="input num !w-24 text-center"
                          type="number"
                          min="0"
                          max={line.maxQty}
                          value={line.qty || ''}
                          placeholder="Qty"
                          onChange={e => {
                            const qty = Math.max(0, Math.min(line.maxQty, Math.floor(Number(e.target.value) || 0)));
                            setReturnLines(ls => ls.map(x => x.itemIdx === itemIdx ? { ...x, qty } : x));
                          }}
                          disabled={actionRunning}
                        />
                        <div className="num w-24 text-right font-bold text-rose-600">{line.qty ? fmtRs(line.qty * item.cost) : '—'}</div>
                      </div>
                    );
                  })}
                  <div className="flex items-center justify-between rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 mt-4">
                    <span className="font-semibold text-sub">Debit amount</span>
                    <span className="num text-lg font-extrabold text-rose-600">
                      {fmtRs(returnLines.reduce((sum, line) => sum + line.qty * (returnPurchase.items[line.itemIdx]?.cost || 0), 0))}
                    </span>
                  </div>
                  <div className="flex justify-end mt-4">
                    <button
                      className="btn bg-rose-600 hover:bg-rose-700 text-white"
                      disabled={actionRunning || !returnReason.trim() || !returnLines.some(x => x.qty > 0)}
                      onClick={() => {
                        if (actionRunning) return;
                        setActionRunning(true);
                        try {
                          const result = createPurchaseReturn({
                            purchaseId: returnPurchase.id,
                            lines: returnLines.filter(x => x.qty > 0).map(x => ({ itemIdx: x.itemIdx, qty: x.qty })),
                            reason: returnReason.trim(),
                          });
                          if (result) {
                            setReturnPurchase(null); setReturnLines([]); setReturnGrnId(''); setReturnReason(''); setFormError(''); setView('list');
                          } else {
                            setFormError('Unable to create the supplier return. Check the GRN status, available stock, return quantity, and purchase permissions.');
                          }
                        } finally {
                          setActionRunning(false);
                        }
                      }}
                    >
                      <Trash2 size={14} /> Create return & deduct stock
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="grid md:grid-cols-2 gap-4">
                <Field label="Supplier">
                  <select className="input" value={supplierId} onChange={e => setSupplierId(e.target.value)} disabled={actionRunning}>
                    <option value="">Select supplier...</option>
                    {state.suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </Field>
                <Field label="Supplier invoice number">
                  <input className="input" value={invoiceNo} onChange={e => setInvoiceNo(e.target.value)} placeholder="Optional" disabled={actionRunning} />
                </Field>
                <Field label="Notes">
                  <input className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional receiving note" disabled={actionRunning} />
                </Field>
              </div>

              <div className="mt-5">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-sub">Items</span>
                  <button className="btn btn-soft !text-xs" onClick={() => setRows(r => [...r, emptyRow()])} disabled={actionRunning}><Plus size={13} /> Add line</button>
                </div>
                <div className="space-y-2">
                  {rows.map((r, i) => (
                    <div key={i} className="grid grid-cols-[minmax(220px,1fr)_65px_100px_minmax(190px,1fr)_120px_36px] gap-2 items-center">
                      <ProductSearchSelect value={r.productId} products={state.products} onChange={id => setRow(i, { productId: id })} />
                      <input className="input num" type="number" min="1" value={r.qty || ''} onChange={e => setRow(i, { qty: Number(e.target.value) || 0 })} placeholder="Qty" disabled={actionRunning} />
                      <input className="input num" type="number" min="0" step="0.01" value={r.cost || ''} onChange={e => setRow(i, { cost: Number(e.target.value) || 0 })} placeholder="Cost" disabled={actionRunning} />
                      {(() => {
                        const p = state.products.find(x => x.id === r.productId);
                        return p?.trackImei || p?.trackSerial
                          ? <textarea className="input min-h-10 text-xs" rows={2} value={r.unitText} onChange={e => setRow(i, { unitText: e.target.value })} placeholder={p.trackImei && p.trackSerial ? 'IMEI,SERIAL — one unit per line' : p.trackImei ? 'IMEI — one per line' : 'SERIAL — one per line'} disabled={actionRunning} />
                          : <span className="text-xs text-faint px-2">Not tracked</span>;
                      })()}
                      <label className="flex items-center gap-2 text-xs text-sub">
                        <input type="checkbox" checked={r.updateSellingPrice} onChange={e => setRow(i, { updateSellingPrice: e.target.checked })} disabled={actionRunning} />
                        Set sell price <span className="num">{r.sellingPrice.toLocaleString()}</span>
                      </label>
                      <button className="icon-btn !w-8 !h-8" disabled={actionRunning || rows.length === 1} onClick={() => setRows(rs => rs.filter((_, idx) => idx !== i))}><X size={14} /></button>
                    </div>
                  ))}
                </div>
              </div>

              {formError && <div className="mt-4 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-4 py-3 text-sm text-rose-600">{formError}</div>}

              <div className="flex items-center justify-between rounded-xl bg-violet-500/[0.06] border border-violet-500/15 px-4 py-3 mt-5">
                <span className="font-semibold text-sub">GRN Total</span>
                <span className="num text-lg font-extrabold text-violet-500">{fmtRs(rows.reduce((s, r) => s + Math.max(0, r.qty) * Math.max(0, r.cost), 0))}</span>
              </div>

              <div className="flex gap-2.5 mt-5">
                <button className="btn btn-primary flex-1" onClick={saveDraft} disabled={actionRunning}>
                  <ClipboardCheck size={15} /> {actionRunning ? 'Saving...' : 'Save draft'}
                </button>
                <button className="btn btn-outline-emerald flex-1" onClick={askProcess} disabled={actionRunning}>
                  <Zap size={15} /> {actionRunning ? 'Saving...' : 'Save & process'}
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="p-4 border-b border-line">
            <div className="relative max-w-md">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
              <input className="input pl-9" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search GRN, supplier or invoice..." />
            </div>
          </div>
          {list.length === 0 ? (
            <EmptyState icon={<ClipboardCheck size={26} />} title="No GRNs found" sub="Create a GRN draft to record incoming stock." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px]">
                <thead><tr><th className="th">GRN / PO</th><th className="th">Date</th><th className="th">Supplier</th><th className="th">Invoice</th><th className="th">Items</th><th className="th">Status</th><th className="th !text-right">Total</th><th className="th !text-right">Actions</th></tr></thead>
                <tbody>
                  {list.map(p => (
                    <tr key={p.id} className="hover:bg-raised/40">
                      <td className="td font-bold text-violet-500">{p.poNo}</td>
                      <td className="td text-xs text-sub">{fmtDate(p.date)}</td>
                      <td className="td font-semibold">{p.supplierName}</td>
                      <td className="td text-xs text-sub">{p.supplierInvoiceNo || '—'}</td>
                      <td className="td text-xs text-sub">{p.items.map(i => i.name + ' ×' + i.qty).join(', ')}</td>
                      <td className="td"><Badge tone={p.status === 'received' ? 'emerald' : 'amber'}>{p.status === 'received' ? <PackageCheck size={11} /> : <ClipboardCheck size={11} />}{p.status === 'received' ? 'PROCESSED' : 'DRAFT'}</Badge></td>
                      <td className="td num font-bold text-right">{fmtRs(p.total)}</td>
                      <td className="td">
                        <div className="flex justify-end gap-1">
                          {p.status === 'pending' && <button className="icon-btn !w-8 !h-8" title="Edit" onClick={() => edit(p)} disabled={actionRunning}><Pencil size={14} /></button>}
                          <button className="icon-btn !w-8 !h-8" title="Print" onClick={() => { setPrintReady(false); setPrintPreview({ grn: p, html: grnPrintHtml(p, state.settings.shopName) }); }} disabled={actionRunning}><Printer size={14} /></button>
                          {p.status === 'pending' && (
                            <button
                              className="btn btn-outline-emerald !py-1.5 !px-2.5 !text-xs"
                              disabled={actionRunning}
                              onClick={() => {
                                const validation = validatePurchaseUnitIdentifiers(p, state.products, state.units || []);
                                if (!validation.ok) {
                                  setFormError(validation.error || 'This GRN has invalid IMEI/Serial values. Edit the draft and correct them before processing.');
                                  setEditingId(p.id); setSupplierId(p.supplierId); setInvoiceNo(p.supplierInvoiceNo || ''); setNotes(p.notes || '');
                                  setRows(p.items.map(i => ({ productId: i.productId, qty: i.qty, cost: i.cost, sellingPrice: i.sellingPrice ?? state.products.find(x => x.id === i.productId)?.price ?? 0, updateSellingPrice: !!i.updateSellingPrice, unitText: (i.unitIdentifiers || []).map(u => [u.imei, u.serial].filter(Boolean).join(',')).join('\\n') })));
                                  setFormMode('receive'); setView('form'); return;
                                }
                                setFormError(''); setFormMode('receive'); setPriceChanges([]); setConfirmId(p.id);
                              }}
                            >
                              <Zap size={13} /> Process
                            </button>
                          )}
                          {p.status === 'pending' && can('act:deleteRecords') && <button className="icon-btn !w-8 !h-8 hover:!text-rose-500" onClick={() => setDeleteId(p.id)} disabled={actionRunning}><Trash2 size={14} /></button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <Modal open={!!confirmId} onClose={() => !actionRunning && setConfirmId(null)} title="Process GRN?" sub="Stock will be added once, and the GRN becomes immutable.">
        <p className="text-sm text-sub">This action updates inventory and records the receipt in the inventory ledger. It cannot be repeated after processing.</p>
        {priceChanges.length > 0 && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3">
            <p className="text-xs font-bold text-amber-600 mb-2">Selling price changes</p>
            {priceChanges.map(c => <p key={c.name} className="text-xs text-sub">{c.name}: {fmtRs(c.old)} → {fmtRs(c.next)}</p>)}
          </div>
        )}
        <div className="flex gap-2 mt-5">
          <button className="btn btn-outline-emerald flex-1" onClick={process} disabled={actionRunning}>
            <Zap size={14} /> {actionRunning ? 'Processing...' : 'Process GRN'}
          </button>
          <button className="btn btn-soft flex-1" onClick={() => setConfirmId(null)} disabled={actionRunning}>Cancel</button>
        </div>
      </Modal>

      <Modal open={!!deleteId} onClose={() => !actionRunning && setDeleteId(null)} title="Delete GRN draft?">
        <p className="text-sm text-sub">Only a draft can be deleted. Processed GRNs remain as permanent stock history.</p>
        <div className="flex gap-2 mt-5">
          <button className="btn btn-danger-soft flex-1" onClick={() => { if (deleteId) deletePurchase(deleteId); setDeleteId(null); }} disabled={actionRunning}>Delete draft</button>
          <button className="btn btn-soft flex-1" onClick={() => setDeleteId(null)} disabled={actionRunning}>Cancel</button>
        </div>
      </Modal>

      <Modal open={!!printPreview} onClose={() => { if (!actionRunning) { setPrintPreview(null); setPrintReady(false); } }} title={printPreview ? 'GRN ' + printPreview.grn.poNo : 'GRN print preview'} sub="Preview the A4 goods received note before printing or saving as PDF" wide>
        {printPreview && (
          <div className="space-y-3">
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-primary" onClick={() => printFrame.current?.contentWindow?.print()} disabled={!printReady}><Printer size={15} /> Print</button>
              <button type="button" className="btn btn-soft" onClick={() => printFrame.current?.contentWindow?.print()} disabled={!printReady}><Printer size={15} /> Download PDF</button>
              <button type="button" className="btn btn-soft" onClick={() => { setPrintPreview(null); setPrintReady(false); }}>Close</button>
            </div>
            <div className="rounded-xl border border-line bg-slate-100 p-2"><iframe ref={printFrame} title="GRN print preview" srcDoc={printPreview.html} onLoad={() => setPrintReady(true)} className="w-full h-[70vh] rounded-lg bg-white border border-line" /></div>
            <p className="text-xs text-faint text-center">Use the browser print dialog and choose “Save as PDF” to download a PDF copy.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
}
function ProductSearchSelect({ value, products, onChange }: { value: string; products: Array<{ id: string; name: string; sku: string; barcode: string; brand: string }>; onChange: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const selected = products.find(p => p.id === value);
  const q = query.trim().toLowerCase();
  const matches = products.filter(p => !q || (p.name + ' ' + p.sku + ' ' + p.barcode + ' ' + p.brand).toLowerCase().includes(q)).slice(0, 30);
  return <div className="relative">
    <div className="relative"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint"/><input className="input pl-9" value={open ? query : (selected?.name || '')} placeholder="Search product, SKU or barcode..." onFocus={()=>{setOpen(true);setQuery('')}} onChange={e=>{setQuery(e.target.value);setOpen(true)}}/></div>
    {open && <><button type="button" aria-label="Close product search" className="fixed inset-0 z-20 cursor-default" onClick={()=>setOpen(false)}/><div className="absolute z-30 mt-1 w-full max-h-64 overflow-y-auto rounded-xl border border-line bg-surface shadow-xl">{matches.length===0?<div className="p-3 text-sm text-sub">No matching products</div>:matches.map(p=><button type="button" key={p.id} className={"w-full text-left px-3 py-2.5 hover:bg-raised border-b border-line last:border-0 "+(p.id===value?'bg-violet-50 dark:bg-violet-900/20':'')} onClick={()=>{onChange(p.id);setQuery('');setOpen(false)}}><div className="font-semibold text-ink text-sm">{p.name}</div><div className="text-[11px] text-sub">{p.sku} · {p.barcode}{p.brand ? ' · '+p.brand : ''}</div></button>)}</div></>}
  </div>;
}
