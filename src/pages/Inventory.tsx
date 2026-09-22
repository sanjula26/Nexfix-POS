import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Package, Plus, Pencil, Trash2, Boxes, Banknote, AlertTriangle, Layers,
  Barcode, Tag, Minus, ScanBarcode, ClipboardCheck,
} from 'lucide-react';
import { usePOS } from '../lib/store';
import { SearchInput, Badge, Modal, Field, EmptyState } from '../components/ui';
import { fmtRs, fmtNum, uid, fmtDate } from '../lib/utils';
import type { Product, InventoryUnit } from '../lib/types';

const FALLBACK_CATEGORIES = ['Smartphones', 'Laptops', 'Tablets', 'Audio', 'Power', 'Accessories', 'Storage', 'Batteries', 'Parts', 'Desktop', 'Other'];

const blankProduct = (lowDefault: number): Product => ({
  id: uid(), name: '', sku: `NFX-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
  barcode: String(4790000000 + Math.floor(Math.random() * 9999999)),
  category: 'Accessories', brand: '', cost: 0, price: 0, stock: 0,
  reorderLevel: lowDefault, trackImei: false, trackSerial: false, warrantyMonths: 0,
  active: true, createdAt: new Date().toISOString(),
});

export default function Inventory() {
  const { state, saveProduct, saveUnitsBulk, deleteProduct, adjustStock, can, user, saveCategory, removeCategory, renameCategory } = usePOS() as ReturnType<typeof usePOS> & { renameCategory?: (a: string, b: string) => void };
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('all');
  const lowOnly = params.get('low') === '1';
  const [editing, setEditing] = useState<Product | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [deleting, setDeleting] = useState<Product | null>(null);
  const [stockAdj, setStockAdj] = useState<Product | null>(null);
  const [adjDelta, setAdjDelta] = useState('');
  const [adjReason, setAdjReason] = useState('Restock');
  const [catMgrOpen, setCatMgrOpen] = useState(false);
  const [newCat, setNewCat] = useState('');
  const [renameFrom, setRenameFrom] = useState('');
  const [renameTo, setRenameTo] = useState('');
  const [stockTakeOpen, setStockTakeOpen] = useState(false);
  const [stockCounts, setStockCounts] = useState<Record<string, string>>({});
  const [stockTakeReason, setStockTakeReason] = useState('Stock take adjustment');
  const [newUnitText, setNewUnitText] = useState('');

  const products = useMemo(() => {
    const q = search.trim().toLowerCase();
    return state.products
      .filter(p =>
        (!q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || p.barcode.includes(q) || p.brand.toLowerCase().includes(q)) &&
        (cat === 'all' || p.category === cat) &&
        (!lowOnly || p.stock <= p.reorderLevel),
      )
      .sort((a, b) => (lowOnly ? a.stock - b.stock : a.name.localeCompare(b.name)));
  }, [state.products, search, cat, lowOnly]);

  const categoryOptions = state.settings.categories?.length
    ? state.settings.categories
    : FALLBACK_CATEGORIES;
  const cats = ['all', ...Array.from(new Set([...categoryOptions, ...state.products.map(p => p.category)]))];
  const units = state.products.reduce((a, p) => a + p.stock, 0);
  const value = state.products.reduce((a, p) => a + p.stock * p.cost, 0);
  const retail = state.products.reduce((a, p) => a + p.stock * p.price, 0);
  const low = state.products.filter(p => p.stock <= p.reorderLevel).map(p => ({ ...p, suggestedReorderQty: Math.max(0, p.reorderLevel * 2 - p.stock) }));

  const save = () => {
    if (!editing || !editing.name.trim()) return;
    const current = isNew ? null : state.products.find(p => p.id === editing.id);
    const currentTracked = !!(current?.trackImei || current?.trackSerial);
    const nextTracked = !!(editing.trackImei || editing.trackSerial);
    const inStockUnits = isNew ? 0 : state.units.filter(u => u.productId === editing.id && u.status === 'in_stock').length;

    if (nextTracked && editing.stock !== inStockUnits) {
      alert(isNew
        ? 'Tracked products must start with stock 0. Receive stock through GRN or add individual units.'
        : `Cannot save this tracked product because stock (${editing.stock}) does not match its in-stock units (${inStockUnits}). Reconcile the units first.`);
      return;
    }
    if (currentTracked && !nextTracked && inStockUnits > 0) {
      alert(`Cannot disable IMEI/Serial tracking while ${inStockUnits} unit(s) are still in stock. Sell, return, or otherwise reconcile those units first.`);
      return;
    }

    const duplicateBarcode = editing.barcode.trim();
    if (duplicateBarcode && state.products.some(x => x.id !== editing.id && x.barcode.trim() === duplicateBarcode)) {
      alert(`Barcode ${duplicateBarcode} is already assigned to another product. Please use a unique barcode.`);
      return;
    }

    // For a new tracked product, identifiers entered in this modal are created as
    // normal InventoryUnit records so the Units page is populated immediately.
    if (isNew && nextTracked && newUnitText.trim()) {
      const lines = newUnitText.split(/\r?\n/);
      const newUnits: InventoryUnit[] = [];
      const parseErrors: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i].trim();
        if (!raw) continue;
        const parts = raw.split(',').map(x => x.trim());
        let imei = '', serial = '';
        if (editing.trackImei && editing.trackSerial) {
          if (parts.length !== 2 || !parts[0] || !parts[1]) {
            parseErrors.push('Line ' + (i + 1) + ': enter IMEI,SERIAL');
            continue;
          }
          imei = parts[0]; serial = parts[1];
        } else if (editing.trackImei) {
          if (parts.length !== 1 || !parts[0]) {
            parseErrors.push('Line ' + (i + 1) + ': enter one IMEI');
            continue;
          }
          imei = parts[0];
        } else {
          if (parts.length !== 1 || !parts[0]) {
            parseErrors.push('Line ' + (i + 1) + ': enter one serial number');
            continue;
          }
          serial = parts[0];
        }
        newUnits.push({
          id: uid(),
          productId: editing.id,
          imei: imei || undefined,
          serial: serial || undefined,
          status: 'in_stock',
          createdAt: new Date().toISOString(),
        });
      }
      if (parseErrors.length) {
        alert(parseErrors.join('\n'));
        return;
      }
      saveProduct(editing);
      const result = saveUnitsBulk(newUnits);
      if (!result.ok || result.errors.length) {
        alert(result.errors.length ? result.errors.join('\n') : 'The product was saved, but the unit identifiers could not be added.');
      }
    } else {
      saveProduct(editing);
    }
    setEditing(null);
    setNewUnitText('');
  };

  const num = (v: string) => Number(v.replace(/[^\d.]/g, '')) || 0;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <Badge tone="blue" className="uppercase mb-2"><Layers size={11} /> Stock Control</Badge>
          <h1 className="text-[26px] sm:text-3xl font-extrabold text-ink tracking-tight">Inventory</h1>
          <p className="text-sm text-sub mt-1">
            {fmtNum(state.products.length)} products · {fmtNum(units)} units · {low.length} low-stock alerts
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {can('act:manageStock') && (
            <>
              <button type="button" className="btn btn-soft" onClick={() => { setStockCounts(Object.fromEntries(state.products.filter(p => p.active && !p.trackImei && !p.trackSerial).map(p => [p.id, String(p.stock)]))); setStockTakeOpen(true); }}>
                <ClipboardCheck size={15} /> Stock take
              </button>
              <button type="button" className="btn btn-soft" onClick={() => setCatMgrOpen(true)}>
                <Layers size={15} /> Categories
              </button>
              <button
                className="btn btn-primary"
                onClick={() => { setEditing(blankProduct(state.settings.lowStockDefault)); setNewUnitText(''); setIsNew(true); }}
              >
                <Plus size={15} /> Add Product
              </button>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { icon: Package, label: 'Products', value: fmtNum(state.products.length), tint: 'from-sky-500 to-blue-600' },
          { icon: Boxes, label: 'Units in stock', value: fmtNum(units), tint: 'from-violet-500 to-indigo-600' },
          { icon: Banknote, label: 'Stock value (cost)', value: can('act:viewCost') ? fmtRs(value, false) : 'Rs. ••••••', tint: 'from-emerald-500 to-teal-600' },
          { icon: AlertTriangle, label: 'Low stock', value: fmtNum(low.length), tint: 'from-amber-500 to-orange-600' },
        ].map(s => (
          <div key={s.label} className="card p-4 flex items-center gap-3.5">
            <span className={`w-10 h-10 rounded-xl bg-gradient-to-br ${s.tint} text-white flex items-center justify-center shadow-md shrink-0`}>
              <s.icon size={17} />
            </span>
            <div className="min-w-0">
              <div className="text-[10.5px] font-bold tracking-wider uppercase text-faint">{s.label}</div>
              <div className="num text-lg font-extrabold text-ink truncate">{s.value}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="card p-4 mb-5 flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search by name, SKU, barcode, brand..." className="flex-1 min-w-[220px]" />
        <select className="input w-44" value={cat} onChange={e => setCat(e.target.value)}>
          {cats.map(c => <option key={c} value={c}>{c === 'all' ? 'All categories' : c}</option>)}
        </select>
        <button onClick={() => setParams(lowOnly ? {} : { low: '1' })} className={`btn ${lowOnly ? 'btn-primary' : 'btn-soft'}`}>
          <AlertTriangle size={15} /> Low stock only
        </button>
      </div>

      <div className="card mb-4 p-4">
        <div className="text-sm font-bold text-ink mb-2">Low stock reorder hints</div>
        {low.length === 0 ? <div className="text-sm text-sub">No low-stock products.</div> : <div className="flex flex-wrap gap-2">{low.slice(0, 12).map(p => <Badge key={p.id} tone="amber">{p.name}: order {fmtNum(p.suggestedReorderQty)}</Badge>)}</div>}
      </div>

      <div className="card overflow-hidden">
        {filteredEmpty(products.length) ? (
          <EmptyState icon={<Package size={26} />} title="No products found" sub={lowOnly ? 'No low stock items — all healthy' : 'Try a different search'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px]">
              <thead><tr>
                <th className="th">Product</th><th className="th">Category</th>
                {can('act:viewCost') && <th className="th">Cost</th>}
                <th className="th">Price</th><th className="th">Stock</th><th className="th">Suggested reorder</th>
                {can('act:viewCost') && <th className="th">Stock Value</th>}
                {can('act:manageStock') && <th className="th !text-right">Actions</th>}
              </tr></thead>
              <tbody>
                {products.map(p => {
                  const tracked = !!(p.trackImei || p.trackSerial);
                  return <tr key={p.id} className="hover:bg-raised/40 transition-colors">
                    <td className="td">
                      <div className="font-semibold text-ink">{p.name}</div>
                      <div className="flex items-center gap-2 text-[11px] text-faint mt-0.5">
                        <span className="flex items-center gap-1"><Tag size={10} /> {p.sku}</span>
                        <span className="flex items-center gap-1"><Barcode size={10} /> {p.barcode}</span>
                        {p.trackImei && <Badge tone="violet" className="!text-[9px] !py-0">IMEI</Badge>}
                        {p.trackSerial && <Badge tone="violet" className="!text-[9px] !py-0">SERIAL</Badge>}
                      </div>
                    </td>
                    <td className="td"><Badge tone="slate">{p.category}</Badge></td>
                    {can('act:viewCost') && <td className="td num text-sub">{fmtRs(p.cost)}</td>}
                    <td className="td num font-semibold text-ink">{fmtRs(p.price)}</td>
                    <td className="td">
                      <div className="flex items-center gap-2"><span className={`num font-bold ${p.stock === 0 ? 'text-rose-500' : p.stock <= p.reorderLevel ? 'text-amber-500' : 'text-ink'}`}>{p.stock}</span>{p.stock <= p.reorderLevel && <Badge tone={p.stock === 0 ? 'rose' : 'amber'}>{p.stock === 0 ? 'OUT' : 'LOW'}</Badge>}</div>
                      <div className="w-24 h-1.5 rounded-full bg-raised mt-1.5 overflow-hidden"><div className={`h-full rounded-full ${p.stock === 0 ? 'bg-rose-500' : p.stock <= p.reorderLevel ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(100, (p.stock / Math.max(p.reorderLevel * 3, 1)) * 100)}%` }} /></div>
                    </td><td className="td num font-semibold text-sub">{Math.max(0, p.reorderLevel * 2 - p.stock)}</td>
                    {can('act:viewCost') && <td className="td num text-sub">{fmtRs(p.stock * p.cost)}</td>}
                    {can('act:manageStock') && <td className="td"><div className="flex items-center justify-end gap-1">
                      <button className={`icon-btn !w-8 !h-8 ${tracked ? 'opacity-40 cursor-not-allowed' : ''}`} title={tracked ? 'Use GRN or Units for tracked stock' : 'Adjust stock'} disabled={tracked} onClick={() => { setStockAdj(p); setAdjDelta(''); }}><Boxes size={14} /></button>
                      <button className="icon-btn !w-8 !h-8" title="Edit" onClick={() => { setEditing({ ...p }); setIsNew(false); }}><Pencil size={14} /></button>
                      {can('act:deleteRecords') && <button className="icon-btn !w-8 !h-8 hover:!bg-rose-500/10 hover:!text-rose-500" title="Delete" onClick={() => setDeleting(p)}><Trash2 size={14} /></button>}
                    </div></td>}
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {can('act:viewCost') && <div className="mt-4 text-xs text-faint">Retail value of all stock: <b className="text-sub num">{fmtRs(retail)}</b> · Potential margin <b className="text-emerald-500 num">{fmtRs(retail - value)}</b></div>}

      <Modal open={!!editing} onClose={() => setEditing(null)} title={isNew ? 'Add product' : 'Edit product'} sub={isNew ? 'New item in your catalog' : editing?.name} wide
        footer={
          <div className="flex gap-2 justify-end">
            <button type="button" className="btn btn-soft" onClick={() => setEditing(null)}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={save} disabled={!editing?.name.trim() || (editing && (editing.trackImei || editing.trackSerial) && editing.stock !== (isNew ? 0 : state.units.filter(u => u.productId === editing.id && u.status === 'in_stock').length)) || (editing && !isNew && (state.products.find(p => p.id === editing.id)?.trackImei || state.products.find(p => p.id === editing.id)?.trackSerial) && !(editing.trackImei || editing.trackSerial) && state.units.filter(u => u.productId === editing.id && u.status === 'in_stock').length > 0)}>
              {isNew ? <Plus size={15} /> : <Pencil size={15} />} {isNew ? 'Add product' : 'Save changes'}
            </button>
          </div>
        }
      >
        {editing && (() => {
          const tracked = !!(editing.trackImei || editing.trackSerial);
          const current = isNew ? null : state.products.find(p => p.id === editing.id);
          const currentTracked = !!(current?.trackImei || current?.trackSerial);
          const inStockUnits = isNew ? 0 : state.units.filter(u => u.productId === editing.id && u.status === 'in_stock').length;
          const stockAligned = editing.stock === inStockUnits;
          return <div className="space-y-4">
            <Field label="Product name"><input className="input" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="e.g. Samsung Galaxy A15 5G" /></Field>
            <div className="grid sm:grid-cols-3 gap-4">
              <Field label="SKU / Code"><input className="input num" value={editing.sku} onChange={e => setEditing({ ...editing, sku: e.target.value })} /></Field>
              <Field label="Barcode"><input className="input num" value={editing.barcode} onChange={e => setEditing({ ...editing, barcode: e.target.value })} /></Field>
              <Field label="Brand"><input className="input" value={editing.brand} onChange={e => setEditing({ ...editing, brand: e.target.value })} /></Field>
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label="Category"><select className="input" value={editing.category} onChange={e => setEditing({ ...editing, category: e.target.value })}>{categoryOptions.map(c => <option key={c}>{c}</option>)}</select></Field>
              <Field label="Supplier"><select className="input" value={editing.supplierId || ''} onChange={e => setEditing({ ...editing, supplierId: e.target.value || undefined })}><option value="">— None —</option>{state.suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Field label="Cost (Rs.)"><input className="input num" value={editing.cost || ''} onChange={e => setEditing({ ...editing, cost: num(e.target.value) })} /></Field>
              <Field label="Sell price (Rs.)"><input className="input num" value={editing.price || ''} onChange={e => setEditing({ ...editing, price: num(e.target.value) })} /></Field>
              <Field label="Stock" hint={tracked ? `Controlled by ${currentTracked ? 'tracked units / GRN' : 'GRN / Units'}` : undefined}><input className="input num" value={editing.stock || ''} disabled={tracked} onChange={e => setEditing({ ...editing, stock: Math.round(num(e.target.value)) })} />{tracked && <div className={`mt-1 text-xs ${stockAligned ? 'text-emerald-600' : 'text-amber-600'}`}>{isNew ? 'Start at 0; receive stock through GRN or add units.' : `In-stock units: ${inStockUnits}. Stock is ${stockAligned ? 'aligned.' : 'not aligned — reconcile units before enabling/saving tracking.'}`}</div>}</Field>
              <Field label="Low-stock alert at"><input className="input num" value={editing.reorderLevel || ''} onChange={e => setEditing({ ...editing, reorderLevel: Math.round(num(e.target.value)) })} /></Field>
            </div>
            {editing.price > 0 && editing.cost > 0 && <div className="rounded-xl bg-emerald-500/[0.07] border border-emerald-500/20 px-4 py-3 text-sm flex justify-between"><span className="text-sub">Margin per unit</span><span className="num font-bold text-emerald-500">{fmtRs(editing.price - editing.cost)} ({Math.round(((editing.price - editing.cost) / editing.price) * 100)}%)</span></div>}
            <div className="grid sm:grid-cols-2 gap-3">
              <label className={`flex items-center gap-3 rounded-xl bg-raised border border-line px-4 py-3 ${!isNew && editing.trackImei !== current?.trackImei && !stockAligned ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}><input type="checkbox" className="accent-violet-600 w-4 h-4" checked={!!editing.trackImei} disabled={!isNew && editing.trackImei !== current?.trackImei && !stockAligned} onChange={e => setEditing({ ...editing, trackImei: e.target.checked })} /><span className="flex items-center gap-2 text-sm text-ink font-medium"><ScanBarcode size={15} className="text-violet-500" /> Track IMEI</span></label>
              <label className={`flex items-center gap-3 rounded-xl bg-raised border border-line px-4 py-3 ${!isNew && editing.trackSerial !== current?.trackSerial && !stockAligned ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}><input type="checkbox" className="accent-violet-600 w-4 h-4" checked={!!editing.trackSerial} disabled={!isNew && editing.trackSerial !== current?.trackSerial && !stockAligned} onChange={e => setEditing({ ...editing, trackSerial: e.target.checked })} /><span className="text-sm text-ink font-medium">Track Serial No.</span></label>
            </div>
            {currentTracked && !tracked && inStockUnits > 0 && <p className="text-xs font-medium text-rose-600">Tracking cannot be disabled while in-stock units remain. Reconcile those units first.</p>}
            {isNew && tracked && (
              <div className="rounded-xl border border-violet-200 bg-violet-50/50 p-4 space-y-3">
                <div>
                  <div className="text-sm font-bold text-ink">Initial IMEI / Serial numbers</div>
                  <p className="text-xs text-sub mt-0.5">
                    Add one unit per line. {editing.trackImei && editing.trackSerial
                      ? 'For both, use IMEI,SERIAL on each line.'
                      : editing.trackImei ? 'Enter one IMEI per line.' : 'Enter one serial number per line.'}
                  </p>
                </div>
                <textarea
                  className="input min-h-[150px] font-mono text-sm bg-white"
                  value={newUnitText}
                  onChange={e => setNewUnitText(e.target.value)}
                  placeholder={editing.trackImei && editing.trackSerial
                    ? '356789012345678,ABC123\n356789012345679,ABC124'
                    : editing.trackImei
                      ? '356789012345678\n356789012345679'
                      : 'SN-ABC123\nSN-ABC124'}
                  aria-label="Initial IMEI or serial numbers"
                />
                <p className="text-[11px] text-sub">Blank lines are ignored. Duplicate identifiers are rejected.</p>
              </div>
            )}
            <Field label="Warranty (months)" hint="Printed on receipt for this product"><input className="input num" value={editing.warrantyMonths || ''} onChange={e => setEditing({ ...editing, warrantyMonths: Math.round(num(e.target.value)) || undefined })} placeholder="e.g. 12" /></Field>
            
          </div>;
        })()}
      </Modal>

      <Modal open={!!deleting} onClose={() => setDeleting(null)} title="Delete product?" sub={deleting?.name}>
        <p className="text-sm text-sub">This removes <b className="text-ink">{deleting?.name}</b> from the catalog. Past bills keep their records.</p>
        <div className="flex gap-2.5 mt-5"><button className="btn btn-danger-soft flex-1" onClick={() => { if (deleting) deleteProduct(deleting.id); setDeleting(null); }}><Trash2 size={15} /> Delete</button><button className="btn btn-soft flex-1" onClick={() => setDeleting(null)}>Keep product</button></div>
      </Modal>

      <Modal open={stockTakeOpen} onClose={() => setStockTakeOpen(false)} title="Stock take" sub="Compare physical count with system quantity and post adjustments">
        <div className="space-y-4">
          <div className="rounded-xl bg-raised border border-line px-4 py-3 text-sm text-sub">Tracked IMEI/serial stock is excluded here. Reconcile those through Units/GRN.</div>
          <div className="max-h-[55vh] overflow-y-auto rounded-xl border border-line divide-y divide-line">
            {state.products.filter(p => p.active && !p.trackImei && !p.trackSerial).map(p => { const counted = Number(stockCounts[p.id]); const delta = Number.isFinite(counted) ? counted - p.stock : 0; return <div key={p.id} className="p-3 flex items-center gap-3"><div className="min-w-0 flex-1"><div className="font-semibold text-ink truncate">{p.name}</div><div className="text-[11px] text-sub">System {p.stock} · Difference <span className={delta === 0 ? 'text-sub' : delta > 0 ? 'text-emerald-600' : 'text-rose-500'}>{delta > 0 ? '+' : ''}{delta}</span></div></div><input className="input num !w-28" type="number" min={0} value={stockCounts[p.id] ?? ''} onChange={e => setStockCounts(s => ({ ...s, [p.id]: e.target.value }))} /></div>; })}
          </div>
          <Field label="Reason"><input className="input" value={stockTakeReason} onChange={e => setStockTakeReason(e.target.value)} /></Field>
          <div className="flex justify-end gap-2"><button type="button" className="btn btn-soft" onClick={() => setStockTakeOpen(false)}>Cancel</button><button type="button" className="btn btn-primary" onClick={() => { let changed = 0; state.products.filter(p => p.active && !p.trackImei && !p.trackSerial).forEach(p => { const counted = Number(stockCounts[p.id]); const delta = Number.isFinite(counted) ? Math.round(counted - p.stock) : 0; if (delta !== 0) { adjustStock(p.id, delta, stockTakeReason.trim() || 'Stock take adjustment'); changed++; } }); setStockTakeOpen(false); setStockCounts({}); if (changed === 0) window.alert('No stock differences to post.'); }}>Post adjustments</button></div>
        </div>
      </Modal>
      <Modal open={!!stockAdj} onClose={() => setStockAdj(null)} title="Adjust stock" sub={stockAdj?.name}>
        {stockAdj && <div className="space-y-4">
          <div className="flex items-center justify-between rounded-xl bg-raised border border-line px-4 py-3"><span className="text-sm text-sub">Current stock</span><span className="num text-xl font-extrabold text-ink">{stockAdj.stock}</span></div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quantity (+/-)"><div className="flex gap-2"><button className="btn btn-soft !px-3" onClick={() => setAdjDelta(d => String((parseFloat(d) || 0) - 1))}><Minus size={14} /></button><input className="input num text-center" value={adjDelta} onChange={e => setAdjDelta(e.target.value.replace(/[^\d-]/g, ''))} placeholder="e.g. 10 or -2" /><button className="btn btn-soft !px-3" onClick={() => setAdjDelta(d => String((parseFloat(d) || 0) + 1))}><Plus size={14} /></button></div></Field>
            <Field label="Reason"><select className="input" value={adjReason} onChange={e => setAdjReason(e.target.value)}>{['Restock', 'Supplier return', 'Damaged / broken', 'Stock count fix', 'Internal use'].map(r => <option key={r}>{r}</option>)}</select></Field>
          </div>
          {adjDelta && <p className="text-sm text-sub">New stock will be <b className="num text-ink">{Math.max(0, stockAdj.stock + (parseFloat(adjDelta) || 0))}</b></p>}
          <button className="btn btn-primary w-full" disabled={!adjDelta || parseFloat(adjDelta) === 0 || user == null} onClick={() => { adjustStock(stockAdj.id, parseFloat(adjDelta) || 0, adjReason); setStockAdj(null); }}><Boxes size={15} /> Apply adjustment</button>
        </div>}
      </Modal>

      <Modal open={catMgrOpen} onClose={() => setCatMgrOpen(false)} title="Manage categories" wide>
        <div className="space-y-4">
          <div className="flex gap-2"><input className="input flex-1" placeholder="New category name" value={newCat} onChange={e => setNewCat(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && newCat.trim()) { saveCategory(newCat); setNewCat(''); } }} /><button type="button" className="btn btn-primary" onClick={() => { if (newCat.trim()) { saveCategory(newCat); setNewCat(''); } }}>Add</button></div>
          <ul className="divide-y divide-line rounded-xl border border-line overflow-hidden max-h-80 overflow-y-auto">{categoryOptions.map(c => <li key={c} className="flex flex-wrap items-center gap-2 px-3 py-2.5 bg-surface">{renameFrom === c ? <><input className="input flex-1" value={renameTo} onChange={e => setRenameTo(e.target.value)} autoFocus /><button type="button" className="btn btn-primary !py-1.5 !px-3 text-xs" onClick={() => { renameCategory?.(c, renameTo); setRenameFrom(''); setRenameTo(''); }}>Save</button><button type="button" className="btn btn-soft !py-1.5 !px-3 text-xs" onClick={() => setRenameFrom('')}>Cancel</button></> : <><span className="flex-1 font-medium text-ink">{c}</span><span className="text-xs text-faint">{state.products.filter(pr => pr.category === c).length} items</span><button type="button" className="btn btn-soft !py-1.5 !px-3 text-xs" onClick={() => { setRenameFrom(c); setRenameTo(c); }}>Rename</button><button type="button" className="btn btn-danger-soft !py-1.5 !px-3 text-xs" onClick={() => { if (state.products.some(pr => pr.category === c)) { alert('Reassign products in this category first, or use Rename.'); return; } removeCategory(c); }}>Remove</button></>}</li>)}</ul>
        </div>
      </Modal>
    </div>
  );
}

function filteredEmpty(n: number) { return n === 0; }

export { fmtDate as _unusedFmtDate };
