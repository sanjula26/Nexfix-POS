import { useMemo, useState } from 'react';
import { Download, Copy, PackageSearch } from 'lucide-react';
import { usePOS } from '../lib/store';
import { EmptyState, PageHeading, Badge } from '../components/ui';
import { downloadFile, fmtRs } from '../lib/utils';

const csv = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
export default function LowStockSuggestions() {
  const { state } = usePOS();
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState(false);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return state.products.filter(p => p.active && !p.isService && p.stock <= p.reorderLevel)
      .filter(p => !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || p.brand.toLowerCase().includes(q))
      .map(p => {
        const history = (state.purchases || []).filter(po => po.status === 'received' && po.items.some(i => i.productId === p.id))
          .map(po => ({ date: po.processedAt || po.date, supplier: po.supplierName })).sort((a,b)=>b.date.localeCompare(a.date));
        const grnHistory = (state.grns || []).filter(g => g.status === 'processed' && g.items.some(i => i.productId === p.id))
          .map(g => ({date:g.processedAt || g.date,supplier:g.supplierName})).sort((a,b)=>b.date.localeCompare(a.date));
        const latest = [...history,...grnHistory].sort((a,b)=>b.date.localeCompare(a.date))[0];
        const supplier = state.suppliers.find(s=>s.id===p.supplierId)?.name || latest?.supplier || '—';
        return {...p,suggested:Math.max(0,Math.ceil(((Number(p.reorderLevel)||0)*2)-(Number(p.stock)||0))),lastSupplier:supplier};
      }).sort((a,b)=>a.stock-b.stock || a.name.localeCompare(b.name));
  }, [state.products,state.purchases,state.grns,state.suppliers,search]);
  const exportCsv = () => downloadFile('nexfix-low-stock-reorder.csv',[
    ['SKU','Product','Brand','Stock','Reorder level','Suggested qty','Unit cost','Last supplier'],
    ...rows.map(p=>[p.sku,p.name,p.brand,p.stock,p.reorderLevel,p.suggested,p.cost,p.lastSupplier])
  ].map(r=>r.map(csv).join(',')).join('\n'),'text/csv;charset=utf-8');
  const copyDraft = async () => {
    const content = ['NexFix POS — Draft Purchase Suggestions','Not a purchase order; verify supplier and quantities before ordering.','',...rows.map(p=>`${p.sku} | ${p.name} | Current ${p.stock} | Reorder at ${p.reorderLevel} | Suggested ${p.suggested} | Supplier ${p.lastSupplier}`)].join('\n');
    try { await navigator.clipboard.writeText(content); setCopied(true); } catch { setCopied(false); }
  };
  return <div className="space-y-5">
    <PageHeading chip="Inventory" chipTone="amber" title="Low Stock — Purchase Suggestions" sub="Active stock items at or below reorder level. Suggested quantity targets roughly twice the reorder level." actions={<div className="flex gap-2"><button className="btn btn-soft" onClick={()=>void copyDraft()} disabled={!rows.length}><Copy size={15}/> {copied?'Copied list':'Copy draft PO notes'}</button><button className="btn btn-primary" onClick={exportCsv} disabled={!rows.length}><Download size={15}/> Export CSV</button></div>}/>
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3"><div className="card p-4"><div className="text-xs text-sub">Items to reorder</div><div className="text-2xl font-extrabold mt-1">{rows.length}</div></div><div className="card p-4"><div className="text-xs text-sub">Suggested units</div><div className="text-2xl font-extrabold num mt-1">{rows.reduce((s,p)=>s+p.suggested,0)}</div></div><div className="card p-4 col-span-2 sm:col-span-1"><div className="text-xs text-sub">Estimated unit-cost value</div><div className="text-2xl font-extrabold num mt-1">{fmtRs(rows.reduce((s,p)=>s+p.suggested*p.cost,0))}</div></div></div>
    <div className="card overflow-hidden"><div className="p-4 border-b border-line"><input className="input max-w-md" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search SKU, product or brand"/></div>
      {rows.length ? <div className="overflow-x-auto"><table className="table w-full"><thead><tr><th className="th">SKU / Product</th><th className="th">Stock</th><th className="th">Reorder level</th><th className="th">Suggested qty</th><th className="th">Last supplier</th><th className="th text-right">Estimated cost</th></tr></thead><tbody>{rows.map(p=><tr key={p.id}><td className="td"><div className="font-semibold">{p.name}</div><div className="text-xs text-sub">{p.sku} · {p.brand || p.category}</div></td><td className="td"><Badge tone={p.stock<=0?'rose':'amber'}>{p.stock}</Badge></td><td className="td num">{p.reorderLevel}</td><td className="td font-bold num">{p.suggested}</td><td className="td">{p.lastSupplier}</td><td className="td text-right num">{fmtRs(p.suggested*p.cost)}</td></tr>)}</tbody></table></div> : <div className="p-6"><EmptyState icon={<PackageSearch size={25}/>} title="No low-stock items" sub={search?'Try a broader search.':'All active stock products are above their reorder levels.'}/></div>}
    </div><p className="text-xs text-sub">Suggestions are advisory only. No stock, supplier balance, purchase order or GRN is changed by this report. Quantity formula: max(0, 2 × reorder level − current stock).</p>
  </div>;
}
