import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, Download, PackageCheck, Clock4, Printer, RotateCcw, Wallet } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, EmptyState, PageHeading, SearchInput } from '../components/ui';
import { buildPurchaseCostHistoryRows, buildSupplierReturnReportRows } from '../lib/grnReports';
import { dkey, downloadFile, fmtDate, fmtRs, inRange, periodRange, type PeriodKey } from '../lib/utils';

const PERIODS: Array<{ key: PeriodKey; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This Week' },
  { key: 'month', label: 'This Month' },
  { key: 'year', label: 'This Year' },
  { key: 'all', label: 'All Time' },
];

type ReportMode = 'receiving' | 'cost-history' | 'supplier-returns';

export default function GRNReport() {
  const { state, can } = usePOS();
  const navigate = useNavigate();
  const [period, setPeriod] = useState<PeriodKey>('month');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'pending' | 'received'>('all');
  const [mode, setMode] = useState<ReportMode>('receiving');
  const [custom, setCustom] = useState({ from: dkey(new Date(Date.now() - 29 * 86400000)), to: dkey(new Date()) });
  const [from, to] = useMemo(() => period === 'custom' ? [new Date(custom.from + 'T00:00:00'), new Date(custom.to + 'T23:59:59.999')] : periodRange(period, custom), [period, custom]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...state.purchases]
      .filter(p => inRange(p.date, [from, to]))
      .filter(p => status === 'all' || p.status === status)
      .filter(p => !q || p.poNo.toLowerCase().includes(q) || p.supplierName.toLowerCase().includes(q) || (p.supplierInvoiceNo || '').toLowerCase().includes(q))
      .sort((a, b) => +new Date(b.date) - +new Date(a.date));
  }, [from, search, state.purchases, status, to]);

  const costRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return buildPurchaseCostHistoryRows(state.purchases, state.purchaseReturns || [])
      .filter(row => inRange(row.date, [from, to]))
      .filter(row => !q || [row.productName, row.productId, row.poNo, row.supplierName, row.supplierInvoiceNo].some(value => value.toLowerCase().includes(q)))
      .sort((a, b) => +new Date(b.date) - +new Date(a.date));
  }, [from, search, state.purchases, state.purchaseReturns, to]);

  const returnRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return buildSupplierReturnReportRows(state.purchaseReturns || [])
      .filter(row => inRange(row.date, [from, to]))
      .filter(row => !q || [row.dnNo, row.poNo, row.supplierName, row.productName, row.productId, row.reason, row.by].some(value => value.toLowerCase().includes(q)))
      .sort((a, b) => +new Date(b.date) - +new Date(a.date));
  }, [from, search, state.purchaseReturns, to]);

  const received = rows.filter(p => p.status === 'received');
  const pending = rows.filter(p => p.status === 'pending');
  const receivedValue = received.reduce((sum, p) => sum + Math.max(0, p.total), 0);
  const pendingValue = pending.reduce((sum, p) => sum + Math.max(0, p.total), 0);
  const purchaseQty = costRows.reduce((sum, row) => sum + row.purchaseQty, 0);
  const returnedQty = costRows.reduce((sum, row) => sum + row.returnedQty, 0);
  const netQty = costRows.reduce((sum, row) => sum + row.netQty, 0);
  const netCostValue = costRows.reduce((sum, row) => sum + row.netValue, 0);
  const debitNotes = new Set(returnRows.map(row => row.returnId)).size;
  const debitValue = returnRows.reduce((sum, row) => sum + row.total, 0);
  const debitQty = returnRows.reduce((sum, row) => sum + row.qty, 0);

  const title = mode === 'receiving' ? 'GRN / Receiving Report' : mode === 'cost-history' ? 'Purchase Cost History' : 'Supplier Return Report';
  const subtitle = mode === 'receiving'
    ? rows.length + ' purchase/receiving records in the selected period'
    : mode === 'cost-history'
      ? costRows.length + ' received product cost entries in the selected period'
      : debitNotes + ' supplier debit notes in the selected period';

  const exportCsv = () => {
    const esc = (v: unknown) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
    let lines: string[];
    let filename: string;
    if (mode === 'receiving') {
      lines = [
        ['GRN/PO No', 'Date', 'Supplier', 'Supplier Invoice', 'Items', 'Total', 'Status'].map(esc).join(','),
        ...rows.map(p => [p.poNo, p.date, p.supplierName, p.supplierInvoiceNo || '', p.items.map(i => i.name + ' x' + i.qty).join(' | '), p.total.toFixed(2), p.status].map(esc).join(',')),
      ];
      filename = 'GRN-Report';
    } else if (mode === 'cost-history') {
      lines = [
        ['Date', 'GRN No', 'Supplier', 'Supplier Invoice', 'Product', 'Product ID', 'Purchased Qty', 'Returned Qty', 'Net Qty', 'Unit Cost', 'Purchase Value', 'Return Value', 'Net Cost Value'].map(esc).join(','),
        ...costRows.map(row => [row.date, row.poNo, row.supplierName, row.supplierInvoiceNo, row.productName, row.productId, row.purchaseQty, row.returnedQty, row.netQty, row.unitCost.toFixed(2), row.purchaseValue.toFixed(2), row.returnedValue.toFixed(2), row.netValue.toFixed(2)].map(esc).join(',')),
      ];
      filename = 'Purchase-Cost-History';
    } else {
      lines = [
        ['Debit Note No', 'Date', 'Supplier', 'Source GRN', 'Product', 'Product ID', 'Qty', 'Unit Cost', 'Line Total', 'Reason', 'Created By'].map(esc).join(','),
        ...returnRows.map(row => [row.dnNo, row.date, row.supplierName, row.poNo, row.productName, row.productId, row.qty, row.unitCost.toFixed(2), row.total.toFixed(2), row.reason, row.by].map(esc).join(',')),
      ];
      filename = 'Supplier-Return-Report';
    }
    downloadFile(filename + '-' + dkey(from) + '-to-' + dkey(to) + '.csv', lines.join('\n'), 'text/csv');
  };

  return (
    <>
      <style>{'@page { size: A4 landscape; margin: 12mm; } @media print { body * { visibility: hidden !important; } .grn-report-print, .grn-report-print * { visibility: visible !important; } .grn-report-print { position: absolute; inset: 0; width: 100%; padding: 0; background: #fff; color: #111; } .grn-report-controls { display: none !important; } .grn-report-print .card { box-shadow: none !important; border: 0 !important; } .grn-report-print .overflow-x-auto { overflow: visible !important; } .grn-report-print table { min-width: 0 !important; width: 100% !important; font-size: 9pt; } .grn-report-print th, .grn-report-print td { padding: 4px 6px !important; } }'}</style>
      <div className="grn-report-print">
        <PageHeading chip="Procurement" chipTone="violet" title={title} sub={subtitle} actions={can('act:export') ? <div className="flex flex-wrap gap-2 print:hidden"><button className="btn btn-outline" onClick={exportCsv}><Download size={14} /> Export CSV</button><button className="btn btn-primary print:hidden" onClick={() => window.print()}><Printer size={14} /> Print / Save PDF</button></div> : undefined} />
        <p className="text-xs text-sub mb-4">Showing {fmtDate(dkey(from))} to {fmtDate(dkey(to))}{mode === 'receiving' ? ' · Status: ' + (status === 'all' ? 'All' : status === 'received' ? 'Received' : 'Pending') : ''}</p>
        <div className="flex flex-wrap gap-2 mb-4 grn-report-controls" role="group" aria-label="Procurement report type">
          {([
            { value: 'receiving', label: 'GRN / Receiving' },
            { value: 'cost-history', label: 'Purchase Cost History' },
            { value: 'supplier-returns', label: 'Supplier Returns' },
          ] as const).map(option => (
            <button key={option.value} type="button" aria-pressed={mode === option.value} className={'btn !text-xs ' + (mode === option.value ? 'btn-primary' : 'btn-soft')} onClick={() => setMode(option.value)}>{option.label}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 mb-5 grn-report-controls">
          {PERIODS.map(p => <button key={p.key} className={'btn !text-xs ' + (period === p.key ? 'btn-primary' : 'btn-soft')} onClick={() => setPeriod(p.key)}>{p.label}</button>)}
          <button className={'btn !text-xs ' + (period === 'custom' ? 'btn-primary' : 'btn-soft')} onClick={() => setPeriod('custom')}>Custom</button>
          {period === 'custom' && <><input className="input !w-auto !py-1.5 text-xs" type="date" value={custom.from} onChange={e => setCustom(c => ({ ...c, from: e.target.value }))} /><input className="input !w-auto !py-1.5 text-xs" type="date" value={custom.to} onChange={e => setCustom(c => ({ ...c, to: e.target.value }))} /></>}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
          {mode === 'receiving' ? <>
            <div className="card p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-faint">Received GRNs</div><div className="num text-xl font-extrabold text-emerald-600 mt-1">{received.length}</div><div className="text-xs text-sub mt-1">{fmtRs(receivedValue)}</div></div>
            <div className="card p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-faint">Pending POs</div><div className="num text-xl font-extrabold text-amber-600 mt-1">{pending.length}</div><div className="text-xs text-sub mt-1">{fmtRs(pendingValue)}</div></div>
            <div className="card p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-faint">Total records</div><div className="num text-xl font-extrabold text-ink mt-1">{rows.length}</div><div className="text-xs text-sub mt-1">{rows.reduce((n, p) => n + p.items.reduce((a, i) => a + i.qty, 0), 0)} units on lines</div></div>
          </> : mode === 'cost-history' ? <>
            <div className="card p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-faint">Received Qty</div><div className="num text-xl font-extrabold text-ink mt-1">{purchaseQty}</div></div>
            <div className="card p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-faint">Returned Qty</div><div className="num text-xl font-extrabold text-rose-600 mt-1">{returnedQty}</div></div>
            <div className="card p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-faint">Net Purchase Cost</div><div className="num text-xl font-extrabold text-ink mt-1">{fmtRs(netCostValue)}</div><div className="text-xs text-sub mt-1">{netQty} units remaining after recorded supplier returns</div></div>
          </> : <>
            <div className="card p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-faint">Debit Notes</div><div className="num text-xl font-extrabold text-ink mt-1">{debitNotes}</div></div>
            <div className="card p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-faint">Returned Qty</div><div className="num text-xl font-extrabold text-rose-600 mt-1">{debitQty}</div></div>
            <div className="card p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-faint">Total Debit Value</div><div className="num text-xl font-extrabold text-rose-600 mt-1">{fmtRs(debitValue)}</div></div>
          </>}
        </div>
        <div className="card overflow-hidden">
          <div className="p-4 border-b border-line flex flex-wrap gap-3 items-center grn-report-controls">
            <SearchInput value={search} onChange={setSearch} placeholder={mode === 'receiving' ? 'Search GRN/PO, supplier or invoice...' : mode === 'cost-history' ? 'Search product, GRN, invoice or supplier...' : 'Search debit note, source GRN, supplier or product...'} className="max-w-md flex-1" />
            {mode === 'receiving' && <div className="flex gap-1.5">{(['all', 'pending', 'received'] as const).map(s => <button key={s} className={'btn !text-xs ' + (status === s ? 'btn-primary' : 'btn-soft')} onClick={() => setStatus(s)}>{s === 'all' ? 'All' : s === 'received' ? 'Received' : 'Pending'}</button>)}</div>}
          </div>
          {mode === 'receiving' ? (
            rows.length === 0 ? <EmptyState icon={<ClipboardList size={26} />} title="No receiving records" sub="No purchase/GRN records match the selected filters." /> : (
              <div className="overflow-x-auto"><table className="w-full min-w-[900px]"><thead><tr><th className="th">GRN / PO</th><th className="th">Date</th><th className="th">Supplier</th><th className="th">Invoice</th><th className="th">Items</th><th className="th">Status</th><th className="th !text-right">Total</th></tr></thead><tbody>{rows.map(p => <tr key={p.id} className="hover:bg-raised/40"><td className="td font-bold text-violet-500"><button type="button" className="underline underline-offset-2 hover:text-violet-700" onClick={() => navigate('/grn?grn=' + encodeURIComponent(p.id))}>{p.poNo}</button></td><td className="td text-xs text-sub">{fmtDate(p.date)}</td><td className="td font-semibold">{p.supplierName}</td><td className="td text-xs text-sub">{p.supplierInvoiceNo || '—'}</td><td className="td text-xs text-sub">{p.items.map(i => i.name + ' ×' + i.qty).join(', ')}</td><td className="td"><Badge tone={p.status === 'received' ? 'emerald' : 'amber'}>{p.status === 'received' ? <PackageCheck size={11} /> : <Clock4 size={11} />}{p.status.toUpperCase()}</Badge></td><td className="td num font-bold text-right">{fmtRs(p.total)}</td></tr>)}</tbody></table></div>
            )
          ) : mode === 'cost-history' ? (
            costRows.length === 0 ? <EmptyState icon={<Wallet size={26} />} title="No purchase cost history" sub="No processed GRN item costs match the selected filters." /> : (
              <div className="overflow-x-auto"><table className="w-full min-w-[1050px]"><thead><tr><th className="th">Received date</th><th className="th">Product</th><th className="th">GRN</th><th className="th">Supplier / Invoice</th><th className="th text-right">Received</th><th className="th text-right">Returned</th><th className="th text-right">Net Qty</th><th className="th text-right">Unit Cost</th><th className="th text-right">Net Cost</th></tr></thead><tbody>{costRows.map(row => <tr key={row.id}><td className="td text-xs text-sub">{fmtDate(row.date)}</td><td className="td font-semibold">{row.productName}<div className="text-[10px] text-sub">{row.productId}</div></td><td className="td font-bold text-violet-500"><button type="button" className="underline underline-offset-2" onClick={() => navigate('/grn?grn=' + encodeURIComponent(row.purchaseId))}>{row.poNo}</button></td><td className="td text-xs text-sub">{row.supplierName}<div className="text-[10px]">{row.supplierInvoiceNo || 'No invoice ref'}</div></td><td className="td num text-right">{row.purchaseQty}</td><td className="td num text-right text-rose-600">{row.returnedQty}</td><td className="td num text-right font-bold">{row.netQty}</td><td className="td num text-right">{fmtRs(row.unitCost)}</td><td className="td num text-right font-bold">{fmtRs(row.netValue)}</td></tr>)}</tbody></table></div>
            )
          ) : (
            returnRows.length === 0 ? <EmptyState icon={<RotateCcw size={26} />} title="No supplier returns" sub="No supplier debit notes match the selected filters." /> : (
              <div className="overflow-x-auto"><table className="w-full min-w-[1100px]"><thead><tr><th className="th">Debit Note</th><th className="th">Date</th><th className="th">Supplier</th><th className="th">Source GRN</th><th className="th">Product</th><th className="th text-right">Qty</th><th className="th text-right">Unit Cost</th><th className="th text-right">Line Total</th><th className="th">Reason / By</th></tr></thead><tbody>{returnRows.map(row => <tr key={row.id}><td className="td font-bold text-rose-600">{row.dnNo}</td><td className="td text-xs text-sub">{fmtDate(row.date)}</td><td className="td font-semibold">{row.supplierName}</td><td className="td font-bold text-violet-500"><button type="button" className="underline underline-offset-2" onClick={() => navigate('/grn?grn=' + encodeURIComponent(row.purchaseId))}>{row.poNo}</button></td><td className="td text-xs text-sub">{row.productName}<div className="text-[10px]">{row.productId}</div></td><td className="td num text-right">{row.qty}</td><td className="td num text-right">{fmtRs(row.unitCost)}</td><td className="td num text-right font-bold">{fmtRs(row.total)}</td><td className="td text-xs text-sub">{row.reason}<div className="text-[10px]">By: {row.by}</div></td></tr>)}</tbody></table></div>
            )
          )}
        </div>
      </div>
    </>
  );
}
