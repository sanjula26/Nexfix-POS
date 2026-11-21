import { useMemo, useState } from 'react';
import { Download, FileX } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, EmptyState, PageHeading, SearchInput } from '../components/ui';
import { dkey, downloadFile, fmtDate, fmtRs } from '../lib/utils';
import ReportPrintButton from '../components/ReportPrintButton';

const csv = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;

export default function PurchaseReturnReport() {
  const { state } = usePOS();
  const [from, setFrom] = useState(dkey(new Date(Date.now() - 29 * 86400000)));
  const [to, setTo] = useState(dkey(new Date()));
  const [search, setSearch] = useState('');

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...(state.purchaseReturns || [])]
      .filter(item => {
        const day = dkey(item.date);
        return (!from || day >= from) && (!to || day <= to);
      })
      .filter(item => !q || [item.dnNo, item.poNo, item.supplierName, item.reason, item.by, ...item.items.map(line => line.name)].some(value => String(value || '').toLowerCase().includes(q)))
      .sort((a, b) => +new Date(b.date) - +new Date(a.date));
  }, [from, search, state.purchaseReturns, to]);

  const total = rows.reduce((sum, item) => sum + item.total, 0);
  const exportCsv = () => {
    const lines = [
      ['Debit Note', 'Date', 'GRN / PO', 'Supplier', 'Items', 'Reason', 'Processed By', 'Total'].map(csv).join(','),
      ...rows.map(item => [item.dnNo, item.date, item.poNo, item.supplierName, item.items.map(line => `${line.name} x${line.qty}`).join(' | '), item.reason, item.by, item.total.toFixed(2)].map(csv).join(',')),
    ];
    downloadFile(`NexFix-Supplier-Returns-${from || 'all'}-to-${to || 'all'}.csv`, lines.join('\n'), 'text/csv;charset=utf-8');
  };

  return (
    <div className="report-print">
      <PageHeading chip="Procurement" chipTone="rose" title="Supplier Returns Report" sub={`${rows.length} debit notes · ${fmtRs(total)} total supplier returns`} actions={<div className="flex flex-wrap gap-2"><ReportPrintButton /><button className="btn btn-outline" onClick={exportCsv} disabled={!rows.length}><Download size={14}/> Export CSV</button></div>} />
      <div className="card p-4 mb-5 flex flex-wrap items-end gap-3 no-print">
        <label className="text-xs font-semibold text-sub">From date<input type="date" className="input mt-1" value={from} max={to || undefined} onChange={event => setFrom(event.target.value)}/></label>
        <label className="text-xs font-semibold text-sub">To date<input type="date" className="input mt-1" value={to} min={from || undefined} onChange={event => setTo(event.target.value)}/></label>
        <div className="flex-1 min-w-[220px]"><SearchInput value={search} onChange={setSearch} placeholder="Search debit note, GRN, supplier or item..."/></div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <div className="card p-4"><div className="text-xs text-sub">Debit notes</div><div className="mt-1 text-2xl font-extrabold num">{rows.length}</div></div>
        <div className="card p-4"><div className="text-xs text-sub">Returned units</div><div className="mt-1 text-2xl font-extrabold num">{rows.reduce((sum,item)=>sum+item.items.reduce((n,line)=>n+line.qty,0),0)}</div></div>
        <div className="card p-4"><div className="text-xs text-sub">Total supplier returns</div><div className="mt-1 text-2xl font-extrabold num text-rose-600">{fmtRs(total)}</div></div>
      </div>
      <div className="card overflow-hidden">
        {rows.length === 0 ? <div className="p-6"><EmptyState icon={<FileX size={25}/>} title="No supplier returns found" sub="Try another date range or search term. Processed supplier returns will appear here."/></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[850px]"><thead><tr><th className="th">Debit Note</th><th className="th">Date</th><th className="th">GRN / PO</th><th className="th">Supplier</th><th className="th">Items</th><th className="th">Reason</th><th className="th">By</th><th className="th text-right">Total</th></tr></thead>
            <tbody>{rows.map(item=><tr key={item.id}><td className="td font-bold text-violet-600">{item.dnNo}</td><td className="td text-xs">{fmtDate(item.date)}</td><td className="td">{item.poNo}</td><td className="td font-semibold">{item.supplierName}</td><td className="td text-xs">{item.items.map(line=>`${line.name} ×${line.qty}`).join(', ')}</td><td className="td text-xs">{item.reason}</td><td className="td text-xs">{item.by}</td><td className="td text-right num font-bold text-rose-600">{fmtRs(item.total)}</td></tr>)}</tbody>
          </table></div>
        )}
      </div>
      <p className="mt-3 text-xs text-sub">This report is read-only. It does not create a return or change stock.</p>
    </div>
  );
}
