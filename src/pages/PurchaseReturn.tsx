import { useMemo, useState } from 'react';
import { ArrowLeft, FileX, Plus, Minus, Download, Printer } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, EmptyState, Modal, PageHeading, SearchInput } from '../components/ui';
import { fmtRs, fmtDate, dkey, downloadFile } from '../lib/utils';
import type { Purchase, PurchaseReturn } from '../lib/types';

interface ReturnLine { itemIdx: number; productId: string; name: string; maxQty: number; qty: number; cost: number; unitIds: string[]; }

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function printDebitNote(dn: PurchaseReturn, shopName: string) {
  const w = window.open('', '_blank', 'width=800,height=600');
  if (!w) return;
  const rows = dn.items.filter(i => i.qty > 0).map(i =>
    `<tr><td>${escapeHtml(i.name)}</td><td style="text-align:right">${i.qty}</td><td style="text-align:right">Rs.${i.cost.toLocaleString('en-US',{minimumFractionDigits:2})}</td><td style="text-align:right">Rs.${(i.qty*i.cost).toLocaleString('en-US',{minimumFractionDigits:2})}</td></tr>`
  ).join('');
  w.document.write(`<!DOCTYPE html><html><head><title>Debit Note ${dn.dnNo}</title>
  <style>body{font-family:Arial,sans-serif;font-size:13px;margin:24px}h2{margin:0 0 4px}p{margin:2px 0;color:#555}
  table{width:100%;border-collapse:collapse;margin-top:16px}th,td{border:1px solid #ddd;padding:6px 10px;font-size:12px}
  th{background:#f5f5f5;font-weight:600}.total{font-weight:700}@media print{button{display:none}}</style></head><body>
  <h2>${escapeHtml(shopName)}</h2>
  <p><strong>DEBIT NOTE</strong> &nbsp;|&nbsp; <strong>${escapeHtml(dn.dnNo)}</strong></p>
  <p>Date: ${fmtDate(dn.date)}</p>
  <p>Supplier: ${escapeHtml(dn.supplierName)}</p>
  <p>Reason: ${escapeHtml(dn.reason)}</p>
  <table><thead><tr><th>Item</th><th>Return Qty</th><th>Unit Cost</th><th>Total</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr><td colspan="3" style="text-align:right;font-weight:700">Total Debit</td>
  <td style="text-align:right;font-weight:700">Rs.${dn.total.toLocaleString('en-US',{minimumFractionDigits:2})}</td></tr></tfoot>
  </table>
  <p style="margin-top:16px;font-size:11px;color:#666">This is a computer generated debit note.</p>
  <button onclick="window.print()" style="margin-top:12px;padding:8px 20px;cursor:pointer">Print</button>
  </body></html>`);
  w.document.close();
}

export default function PurchaseReturn() {
  const { state, user, can, createPurchaseReturn } = usePOS();
  const [search, setSearch] = useState('');
  const [selectedGRN, setSelectedGRN] = useState<Purchase | null>(null);
  const [lines, setLines] = useState<ReturnLine[]>([]);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<PurchaseReturn | null>(null);

  const processedGRNs = useMemo(() => {
    const q = search.toLowerCase();
    return state.purchases
      .filter(p => p.status === 'received' && (!q || p.poNo.toLowerCase().includes(q) || p.supplierName.toLowerCase().includes(q)))
      .sort((a, b) => +new Date(b.date) - +new Date(a.date));
  }, [state.purchases, search]);

  const selectGRN = (grn: Purchase) => {
    setSelectedGRN(grn);
    const returnedByItem = new Map<number, number>();
    for (const ret of state.purchaseReturns || []) {
      if (ret.purchaseId !== grn.id) continue;
      for (const item of ret.items) returnedByItem.set(item.itemIdx, (returnedByItem.get(item.itemIdx) || 0) + item.qty);
    }
    setLines(grn.items.map((i, itemIdx) => {
      const alreadyReturned = returnedByItem.get(itemIdx) || 0;
      const product = state.products.find(p => p.id === i.productId);
      const stock = product?.stock ?? 0;
      const tracked = Array.isArray(i.unitIdentifiers) && i.unitIdentifiers.length > 0;
      const availableUnits = tracked ? (state.units || []).filter(u => u.productId === i.productId && u.purchaseId === grn.id && u.status === 'in_stock') : [];
      return { itemIdx, productId: i.productId, name: i.name, maxQty: Math.min(Math.max(0, i.qty - alreadyReturned), Math.max(0, tracked ? availableUnits.length : stock)), qty: 0, cost: i.cost, unitIds: [] };
    }));
    setReason('');
  };

  const setLineQty = (idx: number, qty: number) => {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, qty: Math.max(0, Math.min(l.maxQty, qty)) } : l));
  };

  const returnItems = lines.filter(l => l.qty > 0);
  const returnTotal = returnItems.reduce((a, l) => a + l.qty * l.cost, 0);

  const dnNo = `DN-${String((state.counters.dn || 0) + 1).padStart(4, '0')}`;

  const handleSubmit = async () => {
    if (!selectedGRN || returnItems.length === 0 || !reason.trim()) return;
    setSubmitting(true);
    try {
      const result = await createPurchaseReturn({ purchaseId: selectedGRN.id, lines: returnItems.map(item => ({ itemIdx: item.itemIdx, qty: item.qty, ...(item.unitIds.length ? { unitIds: item.unitIds } : {}) })), reason: reason.trim() });
      if (!result) return;
      setDone(result);
      setSelectedGRN(null);
      setLines([]);
    } finally {
      setSubmitting(false);
    }
  };

  const exportCSV = () => {
    if (!user || !can('act:export')) return;
    const csvCell = (value: unknown) => {
      const text = String(value ?? '');
      const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const rows = processedGRNs.flatMap(p => p.items.map(i =>
      [p.poNo, dkey(p.date), p.supplierName, i.name, i.qty, i.cost, i.qty * i.cost].map(csvCell).join(',')
    ));
    downloadFile(`GRN-Return-Export.csv`, ['GRN,Date,Supplier,Item,Qty,Cost,Total', ...rows].join(String.fromCharCode(10)), 'text/csv');
  };

  return (
    <div>
      <PageHeading chip="Procurement" chipTone="rose" title="Purchase Return / Debit Note"
        sub="Return items to supplier and deduct stock"
        actions={can('act:export') ? <button className="btn btn-soft !py-1.5 !px-3 !text-xs" onClick={exportCSV}><Download size={13}/> Export</button> : undefined}
      />

      {done && (
        <Modal open={Boolean(done)} title={`Debit Note Created — ${done.dnNo}`} onClose={() => setDone(null)}>
          <div className="space-y-3">
            <p className="text-sm text-sub">Stock has been deducted. Debit note <strong>{done.dnNo}</strong> for <strong>{done.supplierName}</strong>.</p>
            <p className="text-sm font-bold text-rose-500">Total Debit: {fmtRs(done.total)}</p>
            <div className="flex gap-2">
              <button className="btn btn-outline flex-1" onClick={() => printDebitNote(done, state.settings.shopName)}>
                <Printer size={14}/> Print Debit Note
              </button>
              <button className="btn btn-soft flex-1" onClick={() => setDone(null)}>Close</button>
            </div>
          </div>
        </Modal>
      )}

      <div className="grid lg:grid-cols-2 gap-4 p-4">
        <div className="card overflow-hidden">
          <div className="p-3 border-b border-line">
            <SearchInput value={search} onChange={setSearch} placeholder="Search GRN or supplier..." />
          </div>
          {processedGRNs.length === 0
            ? <EmptyState icon={<FileX size={24}/>} title="No processed GRNs" sub="Process a GRN first to create a return" />
            : (
              <div className="overflow-y-auto max-h-[500px]">
                {processedGRNs.map(grn => (
                  <button
                    key={grn.id}
                    className={`w-full text-left p-3 border-b border-line hover:bg-raised/60 transition-colors ${selectedGRN?.id === grn.id ? 'bg-violet-50 dark:bg-violet-900/20 border-l-2 border-l-violet-500' : ''}`}
                    onClick={() => selectGRN(grn)}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-violet-500 text-sm">{grn.poNo}</span>
                      <Badge tone="emerald">PROCESSED</Badge>
                    </div>
                    <p className="text-xs text-sub mt-0.5">{grn.supplierName} · {fmtDate(grn.date)}</p>
                    <p className="text-xs text-ink mt-0.5">{grn.items.length} items · {fmtRs(grn.total)}</p>
                  </button>
                ))}
              </div>
            )
          }
        </div>

        <div className="card overflow-hidden">
          {!selectedGRN ? (
            <EmptyState icon={<ArrowLeft size={24}/>} title="Select a GRN" sub="Choose a processed GRN from the list to create a return" />
          ) : (
            <div>
              <div className="p-3 border-b border-line bg-raised/30">
                <p className="font-bold text-sm">{selectedGRN.poNo} — {selectedGRN.supplierName}</p>
                <p className="text-xs text-sub">{fmtDate(selectedGRN.date)} · {fmtRs(selectedGRN.total)}</p>
              </div>
              <div className="p-3 space-y-2 max-h-[320px] overflow-y-auto">
                {lines.map((line, idx) => {
                  const historicalIdentifiers = selectedGRN.items[line.itemIdx]?.unitIdentifiers || [];
                  const tracked = historicalIdentifiers.length > 0;
                  const availableUnits = tracked ? (state.units || []).filter(u => u.productId === line.productId && u.purchaseId === selectedGRN.id && u.status === 'in_stock') : [];
                  return (
                    <div key={idx} className={`p-2.5 rounded-lg border ${line.qty > 0 ? 'border-rose-300 bg-rose-50/50 dark:bg-rose-900/10' : 'border-line'}`}>
                      <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{line.name}</p>
                          <p className="text-xs text-sub">Max: {line.maxQty} · {fmtRs(line.cost)} each</p>
                        </div>
                        {!tracked && (
                          <div className="flex items-center gap-1">
                            <button className="w-7 h-7 rounded-lg border border-line bg-surface flex items-center justify-center hover:bg-raised" onClick={() => setLineQty(idx, line.qty - 1)} disabled={line.qty <= 0}><Minus size={12}/></button>
                            <input type="number" min={0} max={line.maxQty} className="w-12 text-center rounded border border-line bg-surface px-1 py-1 text-sm" value={line.qty} onChange={e => setLineQty(idx, +e.target.value)} />
                            <button className="w-7 h-7 rounded-lg border border-line bg-surface flex items-center justify-center hover:bg-raised" onClick={() => setLineQty(idx, line.qty + 1)} disabled={line.qty >= line.maxQty}><Plus size={12}/></button>
                          </div>
                        )}
                        <div className="text-right w-20"><p className="text-sm font-bold text-rose-500">{line.qty > 0 ? fmtRs(line.qty * line.cost) : '—'}</p></div>
                      </div>
                      {tracked && (
                        <div className="mt-2 rounded-lg border border-line bg-raised p-2">
                          <div className="text-[10px] uppercase font-bold tracking-wider text-faint mb-2">Select units to return</div>
                          {availableUnits.length === 0 ? <div className="text-xs text-faint">No in-stock tracked units are available for return.</div> : (
                            <div className="grid grid-cols-1 gap-1.5">
                              {availableUnits.map(unit => {
                                const selected = line.unitIds.includes(unit.id);
                                const label = [unit.imei, unit.serial].filter(Boolean).join(' · ') || unit.id;
                                return <label key={unit.id} className={`flex items-center gap-2 rounded border px-2 py-1.5 text-xs cursor-pointer ${selected ? 'border-rose-400 bg-rose-50 dark:bg-rose-900/20' : 'border-line bg-surface'}`}>
                                  <input type="checkbox" checked={selected} onChange={() => setLines(ls => ls.map((l,i) => {
                                    if (i !== idx) return l;
                                    const nextIds = selected ? l.unitIds.filter(id => id !== unit.id) : [...l.unitIds, unit.id];
                                    return { ...l, unitIds: nextIds, qty: nextIds.length };
                                  }))} disabled={submitting} />
                                  <span className="font-mono break-all">{label}</span>
                                </label>;
                              })}
                            </div>
                          )}
                          <div className="text-[11px] text-sub mt-1">Selected: {line.unitIds.length} / {line.maxQty}</div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="p-3 border-t border-line space-y-3">
                <div>
                  <label className="text-xs font-semibold text-sub block mb-1">Return Reason *</label>
                  <select className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm focus:ring-2 focus:ring-violet-500 outline-none"
                    value={reason} onChange={e => setReason(e.target.value)}>
                    <option value="">— Select reason —</option>
                    <option value="Defective / Damaged">Defective / Damaged</option>
                    <option value="Wrong item received">Wrong item received</option>
                    <option value="Excess quantity">Excess quantity</option>
                    <option value="Quality issue">Quality issue</option>
                    <option value="Price dispute">Price dispute</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
                {returnTotal > 0 && (
                  <div className="flex justify-between items-center bg-rose-50 dark:bg-rose-900/10 rounded-lg p-3">
                    <span className="text-sm font-semibold">Total Debit Amount</span>
                    <span className="text-lg font-bold text-rose-500">{fmtRs(returnTotal)}</span>
                  </div>
                )}
                <button
                  className="btn w-full bg-rose-600 hover:bg-rose-700 text-white"
                  disabled={returnItems.length === 0 || !reason.trim() || submitting}
                  onClick={handleSubmit}
                >
                  <FileX size={15}/> Create Debit Note & Deduct Stock
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
