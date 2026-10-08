import { useEffect, useMemo, useState } from 'react';
import {
  Barcode as BarcodeIcon, CheckSquare, ChevronDown, Filter, Printer, Tags,
  Square, X, AlertTriangle, Minus, Plus,
} from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, EmptyState, PageHeading, SearchInput, Toggle } from '../components/ui';
import { fmtRs } from '../lib/utils';
import type { InventoryUnit, Product } from '../lib/types';

type PrintMode = 'products' | 'units';
type Template = 'compact' | 'standard' | 'wide';
type GridPreset = '2x4' | '3x5' | '3x7' | 'thermal';

const CODE128_PATTERNS = [
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
  '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
  '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
  '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
  '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
  '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
  '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
  '114131','311141','411131','211412','211214','211232','2331112',
] as const;

function code128Value(value: string): number[] | null {
  if (!value) return null;
  const chars = Array.from(value);
  if (chars.some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) > 126)) return null;
  const data = chars.map(ch => ch.charCodeAt(0) - 32);
  let checksum = 104;
  data.forEach((v, i) => { checksum += v * (i + 1); });
  return [104, ...data, checksum % 103, 106];
}

function BarcodeSvg({ value, height = 38 }: { value: string; height?: number }) {
  const codes = code128Value(value);
  if (!codes) return null;
  const modules = codes.reduce((sum, code) => sum + [...CODE128_PATTERNS[code]].reduce((a, n) => a + Number(n), 0), 0);
  let x = 0;
  const bars: { x: number; w: number }[] = [];
  codes.forEach(code => {
    const pattern = CODE128_PATTERNS[code];
    [...pattern].forEach((width, index) => {
      const w = Number(width);
      if (index % 2 === 0) bars.push({ x, w });
      x += w;
    });
  });
  return (
    <svg
      className="price-tag-barcode-svg"
      viewBox={`0 0 ${modules} 50`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Barcode ${value}`}
      style={{ height }}
    >
      {bars.map((bar, i) => <rect key={i} x={bar.x} y="0" width={bar.w} height="38" fill="currentColor" shapeRendering="crispEdges" />)}
      <text x={modules / 2} y="48" textAnchor="middle" fontSize="7" fontFamily="monospace" fill="currentColor">{value}</text>
    </svg>
  );
}

function hasScannableBarcode(value: string) {
  return Boolean(value && code128Value(value));
}

const TEMPLATE_INFO: Record<Template, { label: string; description: string }> = {
  compact: { label: 'Compact shelf', description: 'Many labels per A4 · accessories & small items' },
  standard: { label: 'Standard', description: 'Larger price · general phones, chargers & laptops' },
  wide: { label: 'Wide / promo', description: 'Wide label with extra price emphasis' },
};

const GRID_INFO: Record<GridPreset, { label: string; columns: number; rows: number }> = {
  '2x4': { label: '2 × 4', columns: 2, rows: 4 },
  '3x5': { label: '3 × 5', columns: 3, rows: 5 },
  '3x7': { label: '3 × 7', columns: 3, rows: 7 },
  thermal: { label: '80mm thermal', columns: 1, rows: 1 },
};

type TagToggles = {
  shop: boolean;
  name: boolean;
  price: boolean;
  sku: boolean;
  barcode: boolean;
};

const DEFAULT_TOGGLES: TagToggles = { shop: true, name: true, price: true, sku: true, barcode: true };

function chunk<T>(items: T[], size: number) {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size));
  return pages;
}

function ProductTag({
  product, shopName, template, toggles, forPrint = false,
}: {
  product: Product;
  shopName: string;
  template: Template;
  toggles: TagToggles;
  forPrint?: boolean;
}) {
  const barcode = product.barcode.trim();
  const barcodeReady = hasScannableBarcode(barcode);
  return (
    <div className={`price-tag price-tag--${template} ${forPrint ? 'price-tag--print' : ''}`}>
      {toggles.shop && <div className="price-tag-shop">{shopName || 'SHOP'}</div>}
      {toggles.name && <div className="price-tag-name">{product.name}</div>}
      {toggles.price && <div className="price-tag-price">{fmtRs(product.price, false)}</div>}
      {toggles.sku && product.sku && <div className="price-tag-sku">SKU: {product.sku}</div>}
      {toggles.barcode && (
        barcodeReady
          ? <div className="price-tag-barcode"><BarcodeSvg value={barcode} height={template === 'compact' ? 34 : 42} /></div>
          : <div className="price-tag-barcode-warning"><AlertTriangle size={11} /> No scannable barcode</div>
      )}
    </div>
  );
}

function UnitTag({
  unit, product, shopName, template, toggles,
}: {
  unit: InventoryUnit;
  product: Product;
  shopName: string;
  template: Template;
  toggles: TagToggles;
}) {
  const identifier = (unit.imei || unit.serial || '').trim();
  const barcodeReady = hasScannableBarcode(identifier);
  return (
    <div className={`price-tag price-tag--${template} price-tag--unit price-tag--print`}>
      {toggles.shop && <div className="price-tag-shop">{shopName || 'SHOP'}</div>}
      {toggles.name && <div className="price-tag-name">{product.name}</div>}
      {toggles.price && <div className="price-tag-price">{fmtRs(product.price, false)}</div>}
      <div className="price-tag-unit-id">{unit.imei ? `IMEI: ${unit.imei}` : `SERIAL: ${unit.serial}`}</div>
      {toggles.barcode && (
        barcodeReady
          ? <div className="price-tag-barcode"><BarcodeSvg value={identifier} height={template === 'compact' ? 34 : 44} /></div>
          : <div className="price-tag-barcode-warning"><AlertTriangle size={11} /> Identifier is not barcode-compatible</div>
      )}
    </div>
  );
}

function CopyControl({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
      <button type="button" className="icon-btn !w-7 !h-7" onClick={() => onChange(Math.max(1, value - 1))} aria-label="Decrease copies"><Minus size={12} /></button>
      <input
        className="input !w-16 !py-1.5 !px-2 text-center num"
        type="number"
        min={1}
        step={1}
        value={value}
        onChange={e => onChange(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
        aria-label="Copies"
      />
      <button type="button" className="icon-btn !w-7 !h-7" onClick={() => onChange(value + 1)} aria-label="Increase copies"><Plus size={12} /></button>
    </div>
  );
}

export default function PriceTags() {
  const { state } = usePOS();
  const [mode, setMode] = useState<PrintMode>('products');
  const [template, setTemplate] = useState<Template>(() => {
    try { return (localStorage.getItem('nexfix_price_tag_template') as Template) || 'compact'; } catch { return 'compact'; }
  });
  const [grid, setGrid] = useState<GridPreset>('3x7');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [activeOnly, setActiveOnly] = useState(true);
  const [stockOnly, setStockOnly] = useState(false);
  const [hideServices, setHideServices] = useState(true);
  const [hideZeroPrice, setHideZeroPrice] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [copies, setCopies] = useState<Record<string, number>>({});
  const [unitPicked, setUnitPicked] = useState<Set<string>>(new Set());
  const [unitSearch, setUnitSearch] = useState('');
  const [toggles, setToggles] = useState<TagToggles>(DEFAULT_TOGGLES);
  const [bulkCopies, setBulkCopies] = useState(10);

  useEffect(() => {
    try { localStorage.setItem('nexfix_price_tag_template', template); } catch { /* best effort */ }
  }, [template]);

  useEffect(() => {
    setPicked(new Set());
    setUnitPicked(new Set());
  }, [mode]);

  const categories = useMemo(() => Array.from(new Set(state.products.map(p => p.category).filter(Boolean))).sort((a, b) => a.localeCompare(b)), [state.products]);

  const productRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return state.products.filter(p => {
      if (activeOnly && !p.active) return false;
      if (stockOnly && !(Number(p.stock) > 0)) return false;
      if (hideServices && p.isService) return false;
      if (hideZeroPrice && !(Number(p.price) > 0)) return false;
      if (category !== 'all' && p.category !== category) return false;
      if (q && ![p.name, p.sku, p.barcode].some(v => String(v || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }, [state.products, search, category, activeOnly, stockOnly, hideServices, hideZeroPrice]);

  const unitRows = useMemo(() => {
    const q = unitSearch.trim().toLowerCase();
    return (state.units || []).filter(u => {
      if (u.status !== 'in_stock') return false;
      if (!u.imei && !u.serial) return false;
      if (!q) return true;
      const p = state.products.find(x => x.id === u.productId);
      return [u.imei, u.serial, p?.name, p?.sku, p?.barcode].some(v => String(v || '').toLowerCase().includes(q));
    }).sort((a, b) => {
      const pa = state.products.find(p => p.id === a.productId)?.name || '';
      const pb = state.products.find(p => p.id === b.productId)?.name || '';
      return pa.localeCompare(pb);
    });
  }, [state.units, state.products, unitSearch]);

  const selectedProducts = useMemo(() => state.products.filter(p => picked.has(p.id)), [state.products, picked]);
  const selectedUnits = useMemo(() => (state.units || []).filter(u => unitPicked.has(u.id) && u.status === 'in_stock' && (u.imei || u.serial)), [state.units, unitPicked]);

  const totalLabels = mode === 'products'
    ? selectedProducts.reduce((sum, p) => sum + Math.max(1, Math.floor(copies[p.id] || 1)), 0)
    : selectedUnits.length;

  const updateCopies = (id: string, value: number) => setCopies(prev => ({ ...prev, [id]: Math.max(1, Math.floor(value || 1)) }));
  const setAllCopies = () => {
    const value = Math.max(1, Math.floor(bulkCopies || 1));
    setCopies(prev => {
      const next = { ...prev };
      selectedProducts.forEach(p => { next[p.id] = value; });
      return next;
    });
  };

  const productPrintItems = useMemo(() => {
    const items: Product[] = [];
    selectedProducts.forEach(p => {
      const n = Math.max(1, Math.floor(copies[p.id] || 1));
      for (let i = 0; i < n; i++) items.push(p);
    });
    return items;
  }, [selectedProducts, copies]);

  const unitPrintItems = selectedUnits;
  const gridCapacity = grid === 'thermal' ? 1 : GRID_INFO[grid].columns * GRID_INFO[grid].rows;
  const productPrintPages = useMemo(() => chunk(productPrintItems, gridCapacity), [productPrintItems, gridCapacity]);
  const unitPrintPages = useMemo(() => chunk(unitPrintItems, gridCapacity), [unitPrintItems, gridCapacity]);
  const printItemCount = mode === 'products' ? productPrintItems.length : unitPrintItems.length;

  const startPrint = () => {
    if (totalLabels <= 0) return;
    if (totalLabels > 100 && !window.confirm(`You are about to print ${totalLabels} labels. Continue?`)) return;
    document.body.classList.add('printing-price-tags');
    const cleanup = () => document.body.classList.remove('printing-price-tags');
    window.addEventListener('afterprint', cleanup, { once: true });
    window.requestAnimationFrame(() => window.print());
  };

  const selectAllProducts = () => setPicked(prev => {
    const next = new Set(prev);
    productRows.forEach(p => next.add(p.id));
    return next;
  });
  const clearProducts = () => setPicked(new Set());
  const toggleProduct = (id: string) => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleUnit = (id: string) => setUnitPicked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectAllUnits = () => setUnitPicked(prev => {
    const next = new Set(prev);
    unitRows.forEach(u => next.add(u.id));
    return next;
  });

  return (
    <div>
      <PageHeading
        chip="Print"
        chipTone="blue"
        title="Barcode & Price Tags"
        sub={`${totalLabels} labels · ${mode === 'products' ? selectedProducts.length + ' products' : selectedUnits.length + ' units'}`}
        actions={
          <button className="btn btn-primary" disabled={totalLabels === 0} onClick={startPrint}>
            <Printer size={15} /> Print {totalLabels > 0 ? `${totalLabels} label${totalLabels === 1 ? '' : 's'}` : ''}
          </button>
        }
      />

      <div className="no-print mb-4 flex flex-wrap gap-2">
        <button className={`btn ${mode === 'products' ? 'btn-primary' : 'btn-soft'}`} onClick={() => setMode('products')}><Tags size={15} /> Product shelf labels</button>
        <button className={`btn ${mode === 'units' ? 'btn-primary' : 'btn-soft'}`} onClick={() => setMode('units')}><BarcodeIcon size={15} /> IMEI / Serial unit labels</button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[390px_1fr] gap-5 items-start">
        <div className="card overflow-hidden no-print">
          {mode === 'products' ? (
            <>
              <div className="p-4 border-b border-line space-y-3">
                <SearchInput value={search} onChange={setSearch} placeholder="Search name, SKU or barcode..." />
                <div className="grid grid-cols-2 gap-2">
                  <label className="input !py-2 flex items-center gap-2 text-xs cursor-pointer"><input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} /> Active only</label>
                  <label className="input !py-2 flex items-center gap-2 text-xs cursor-pointer"><input type="checkbox" checked={stockOnly} onChange={e => setStockOnly(e.target.checked)} /> In stock only</label>
                  <label className="input !py-2 flex items-center gap-2 text-xs cursor-pointer"><input type="checkbox" checked={hideServices} onChange={e => setHideServices(e.target.checked)} /> Hide services</label>
                  <label className="input !py-2 flex items-center gap-2 text-xs cursor-pointer"><input type="checkbox" checked={hideZeroPrice} onChange={e => setHideZeroPrice(e.target.checked)} /> Hide ₹0</label>
                </div>
                <div className="relative">
                  <Filter size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
                  <select className="input pl-9" value={category} onChange={e => setCategory(e.target.value)}>
                    <option value="all">All categories</option>
                    {categories.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="flex gap-2">
                  <button className="btn btn-soft !text-xs flex-1" onClick={selectAllProducts}><CheckSquare size={13} /> Select all filtered</button>
                  <button className="btn btn-soft !text-xs" onClick={clearProducts}><Square size={13} /> Clear</button>
                </div>
              </div>
              <div className="max-h-[500px] overflow-y-auto divide-y divide-line">
                {productRows.map(p => {
                  const selected = picked.has(p.id);
                  return (
                    <div key={p.id} className={`px-3.5 py-3 ${selected ? 'bg-violet-500/[0.07]' : 'hover:bg-raised/50'}`}>
                      <div className="flex items-center gap-3">
                        <button type="button" onClick={() => toggleProduct(p.id)} className="shrink-0" aria-label={selected ? `Deselect ${p.name}` : `Select ${p.name}`}>
                          <span className={`w-[18px] h-[18px] rounded-[5px] border flex items-center justify-center ${selected ? 'bg-violet-600 border-violet-600 text-white' : 'border-line bg-surface'}`}>
                            {selected && <CheckSquare size={12} strokeWidth={3} />}
                          </span>
                        </button>
                        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => toggleProduct(p.id)}>
                          <span className="block text-[13px] font-semibold text-ink truncate">{p.name}</span>
                          <span className="block text-[11px] text-faint num truncate">{p.sku || 'No SKU'} · {p.barcode || 'No barcode'} · {fmtRs(p.price, false)} · Stock {p.stock}</span>
                        </button>
                        {selected && <CopyControl value={copies[p.id] || 1} onChange={n => updateCopies(p.id, n)} />}
                      </div>
                    </div>
                  );
                })}
                {productRows.length === 0 && <EmptyState icon={<Tags size={24} />} title="No products found" sub="Try another search or filter." />}
              </div>
            </>
          ) : (
            <>
              <div className="p-4 border-b border-line space-y-3">
                <SearchInput value={unitSearch} onChange={setUnitSearch} placeholder="Search IMEI, serial or product..." />
                <div className="flex gap-2">
                  <button className="btn btn-soft !text-xs flex-1" onClick={selectAllUnits}><CheckSquare size={13} /> Select all filtered</button>
                  <button className="btn btn-soft !text-xs" onClick={() => setUnitPicked(new Set())}><X size={13} /> Clear</button>
                </div>
                <p className="text-[11px] text-faint">Only in-stock units with a real IMEI or serial are shown. Each selected unit prints exactly once.</p>
              </div>
              <div className="max-h-[550px] overflow-y-auto divide-y divide-line">
                {unitRows.map(u => {
                  const p = state.products.find(x => x.id === u.productId);
                  const selected = unitPicked.has(u.id);
                  const idText = u.imei || u.serial || '';
                  return (
                    <button key={u.id} type="button" onClick={() => toggleUnit(u.id)} className={`w-full flex items-center gap-3 px-4 py-3 text-left ${selected ? 'bg-violet-500/[0.07]' : 'hover:bg-raised/50'}`}>
                      <span className={`w-[18px] h-[18px] rounded-[5px] border flex items-center justify-center shrink-0 ${selected ? 'bg-violet-600 border-violet-600 text-white' : 'border-line bg-surface'}`}>
                        {selected && <CheckSquare size={12} strokeWidth={3} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-semibold text-ink truncate">{p?.name || 'Unknown product'}</span>
                        <span className="block text-[11px] text-faint font-mono truncate">{idText} · {fmtRs(p?.price || 0, false)}</span>
                      </span>
                    </button>
                  );
                })}
                {unitRows.length === 0 && <EmptyState icon={<BarcodeIcon size={24} />} title="No in-stock IMEI / serial units" sub="Add units from Inventory → Units first." />}
              </div>
            </>
          )}
        </div>

        <div className="space-y-5">
          <div className="card p-4 no-print">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-bold text-ink">Label setup</div>
                <div className="text-xs text-faint mt-0.5">{TEMPLATE_INFO[template].description}</div>
              </div>
              <div className="flex gap-2">
                {(Object.keys(TEMPLATE_INFO) as Template[]).map(t => (
                  <button key={t} type="button" className={`btn !text-xs ${template === t ? 'btn-primary' : 'btn-soft'}`} onClick={() => setTemplate(t)}>{TEMPLATE_INFO[t].label}</button>
                ))}
              </div>
            </div>
            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-sub mb-1.5">A4 grid</div>
                <select className="input" value={grid} onChange={e => setGrid(e.target.value as GridPreset)}>
                  {(Object.keys(GRID_INFO) as GridPreset[]).map(g => <option key={g} value={g}>{GRID_INFO[g].label}{g !== 'thermal' ? ` · ${GRID_INFO[g].columns * GRID_INFO[g].rows}/page` : ''}</option>)}
                </select>
              </div>
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-sub mb-1.5">Bulk copies</div>
                <div className="flex gap-2"><input className="input" type="number" min={1} value={bulkCopies} onChange={e => setBulkCopies(Math.max(1, Math.floor(Number(e.target.value) || 1)))} /><button className="btn btn-soft shrink-0" onClick={setAllCopies} disabled={mode !== 'products' || selectedProducts.length === 0}>Set all</button></div>
              </div>
              <div className="md:col-span-2">
                <div className="text-[11px] font-bold uppercase tracking-wider text-sub mb-1.5">Label content</div>
                <div className="flex flex-wrap gap-3 rounded-xl border border-line bg-raised/40 px-3 py-2.5">
                  {([
                    ['shop', 'Shop name'], ['name', 'Product name'], ['price', 'Price'], ['sku', 'SKU'], ['barcode', 'Barcode'],
                  ] as [keyof TagToggles, string][]).map(([key, label]) => <label key={key} className="flex items-center gap-2 text-xs font-semibold text-sub"><Toggle checked={toggles[key]} onChange={v => setToggles(prev => ({ ...prev, [key]: v }))} />{label}</label>)}
                </div>
              </div>
            </div>
          </div>

          <div className="card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4 no-print">
              <div>
                <h3 className="font-bold text-ink flex items-center gap-2"><Tags size={15} className="text-violet-500" /> Real print preview</h3>
                <p className="text-xs text-faint mt-1">{totalLabels} labels · {mode === 'products' ? selectedProducts.length + ' products' : selectedUnits.length + ' units'} · {grid === 'thermal' ? '80mm roll' : `${GRID_INFO[grid].columns} × ${GRID_INFO[grid].rows} per A4 page`}</p>
              </div>
              {totalLabels > 0 && <Badge tone={totalLabels > 100 ? 'amber' : 'emerald'}>{totalLabels > 100 ? '100+ labels — confirm before print' : 'Ready to print'}</Badge>}
            </div>

            {printItemCount === 0 ? (
              <EmptyState icon={<Tags size={26} />} title="No labels selected" sub="Select products or in-stock IMEI / serial units on the left." />
            ) : (
              <div className={`price-tag-preview price-tag-preview--${grid}`}>
                {mode === 'products'
                  ? productPrintItems.map((p, i) => <ProductTag key={`${p.id}-${i}`} product={p} shopName={state.settings.shopName} template={template} toggles={toggles} />)
                  : unitPrintItems.map(u => {
                    const p = state.products.find(x => x.id === u.productId);
                    return p ? <UnitTag key={u.id} unit={u} product={p} shopName={state.settings.shopName} template={template} toggles={toggles} /> : null;
                  })}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={`price-tag-print-area ${grid === 'thermal' ? 'price-tag-print-area--thermal' : ''}`}>
        {grid === 'thermal'
          ? <div className="price-tag-thermal-stack">
            {mode === 'products'
              ? productPrintItems.map((p, i) => <ProductTag key={`${p.id}-t-${i}`} product={p} shopName={state.settings.shopName} template={template} toggles={toggles} forPrint />)
              : unitPrintItems.map(u => {
                const p = state.products.find(x => x.id === u.productId);
                return p ? <UnitTag key={`${u.id}-t`} unit={u} product={p} shopName={state.settings.shopName} template={template} toggles={toggles} /> : null;
              })}
          </div>
          : (mode === 'products' ? productPrintPages : unitPrintPages).map((page, pageIndex) => (
            <div className={`price-tag-print-page price-tag-print-page--${grid}`} key={pageIndex}>
              {mode === 'products'
                ? (page as Product[]).map((p, i) => <ProductTag key={`${p.id}-p-${pageIndex}-${i}`} product={p} shopName={state.settings.shopName} template={template} toggles={toggles} forPrint />)
                : (page as InventoryUnit[]).map(u => {
                  const p = state.products.find(x => x.id === u.productId);
                  return p ? <UnitTag key={`${u.id}-p`} unit={u} product={p} shopName={state.settings.shopName} template={template} toggles={toggles} /> : null;
                })}
            </div>
          ))
      </div>
    </div>
  );
}
