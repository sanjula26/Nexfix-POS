import { useMemo, useState } from 'react';
import { Tags, Printer, CheckSquare, Square, Globe } from 'lucide-react';
import { usePOS } from '../lib/store';
import { SearchInput, PageHeading, EmptyState } from '../components/ui';
import { fmtRs } from '../lib/utils';

/* decorative barcode derived from the product barcode string */
function Barcode({ value }: { value: string }) {
  const bars = useMemo(() => {
    const out: { w: number; gap: number }[] = [];
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      out.push({ w: 1 + (c % 3), gap: 1 + ((c >> 2) % 3) });
    }
    return out;
  }, [value]);
  return (
    <div className="barcode">
      {bars.map((b, i) => (
        <i key={i} style={{ width: b.w, marginRight: b.gap }} />
      ))}
    </div>
  );
}

export default function PriceTags() {
  const { state } = usePOS();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const rows = state.products.filter(p => {
    const q = search.trim().toLowerCase();
    return !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q);
  });

  const toggle = (id: string) =>
    setPicked(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  const selectedProducts = state.products.filter(p => picked.has(p.id));

  return (
    <div>
      <PageHeading
        chip="Print" chipTone="blue"
        title="Price Tags"
        sub={`${picked.size} selected · prints on A4 as shelf labels`}
        actions={
          <button className="btn btn-primary" disabled={picked.size === 0} onClick={() => window.print()}>
            <Printer size={15} /> Print {picked.size > 0 ? `${picked.size} tag(s)` : ''}
          </button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-5 items-start">
        {/* picker */}
        <div className="card overflow-hidden no-print">
          <div className="p-4 border-b border-line space-y-3">
            <SearchInput value={search} onChange={setSearch} placeholder="Find products..." />
            <div className="flex gap-2">
              <button className="btn btn-soft !text-xs flex-1" onClick={() => setPicked(new Set(rows.map(r => r.id)))}>
                <CheckSquare size={13} /> Select all
              </button>
              <button className="btn btn-soft !text-xs flex-1" onClick={() => setPicked(new Set())}>
                <Square size={13} /> Clear
              </button>
            </div>
          </div>
          <div className="max-h-[430px] overflow-y-auto divide-y divide-line">
            {rows.map(p => (
              <button
                key={p.id}
                onClick={() => toggle(p.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${picked.has(p.id) ? 'bg-violet-500/[0.07]' : 'hover:bg-raised/50'}`}
              >
                <span className={`w-[18px] h-[18px] rounded-[5px] border flex items-center justify-center shrink-0 transition-all ${
                  picked.has(p.id) ? 'bg-violet-600 border-violet-600 text-white' : 'border-line bg-surface'
                }`}>
                  {picked.has(p.id) && <CheckSquare size={12} strokeWidth={3} />}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] font-semibold text-ink truncate">{p.name}</span>
                  <span className="text-[11px] text-faint num">{p.sku} · {fmtRs(p.price, false)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* preview */}
        <div className="card p-5">
          <h3 className="font-bold text-ink mb-4 flex items-center gap-2"><Tags size={15} className="text-violet-500" /> Print preview</h3>
          {selectedProducts.length === 0 ? (
            <EmptyState icon={<Tags size={26} />} title="No tags selected" sub="Pick products on the left to build the sheet" />
          ) : (
            <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
              {selectedProducts.map(p => <TagCard key={p.id} p={p} shop={state.settings.shopName} />)}
            </div>
          )}
        </div>
      </div>

      {/* print area */}
      <div className="print-area">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4mm' }}>
          {selectedProducts.map(p => <TagCard key={p.id} p={p} shop={state.settings.shopName} forPrint />)}
        </div>
      </div>
    </div>
  );
}

function TagCard({ p, shop, forPrint }: { p: { name: string; sku: string; barcode: string; price: number }; shop: string; forPrint?: boolean }) {
  return (
    <div
      className={forPrint ? '' : 'rounded-xl border-2 border-dashed border-line bg-white dark:bg-surface p-4'}
      style={forPrint ? { border: '1.5px dashed #888', borderRadius: 8, padding: '10px 12px', background: '#fff' } : {}}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: forPrint ? '#000' : undefined }}>
        <Globe size={11} className={forPrint ? '' : 'text-violet-500'} />
        <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.12em' }} className={forPrint ? '' : 'text-faint'}>
          {shop.toUpperCase()}
        </span>
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, marginTop: 6, lineHeight: 1.25, minHeight: 30 }} className={forPrint ? '' : 'text-ink'}>
        {p.name}
      </div>
      <div style={{ fontSize: 18, fontWeight: 800, marginTop: 2 }} className={forPrint ? '' : 'text-violet-600 dark:text-violet-400 num'}>
        {fmtRs(p.price, false)}
      </div>
      <div className={forPrint ? '' : 'text-black dark:text-white mt-2'} style={{ marginTop: 8 }}>
        <Barcode value={p.barcode} />
      </div>
      <div style={{ fontSize: 9, letterSpacing: '0.18em', marginTop: 3 }} className={forPrint ? '' : 'text-faint num'}>
        {p.barcode} · {p.sku}
      </div>
    </div>
  );
}
