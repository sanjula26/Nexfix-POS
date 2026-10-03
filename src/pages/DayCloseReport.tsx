import { useMemo, useState } from 'react';
import { Download, Landmark, CalendarDays, CheckCircle2, AlertTriangle } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, EmptyState, PageHeading } from '../components/ui';
import { dkey, downloadFile, fmtRs, fmtNum, salePayments } from '../lib/utils';

export default function DayCloseReport() {
  const { state } = usePOS();
  const today = dkey(new Date());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);

  const rows = useMemo(() => {
    const start = from <= to ? from : to;
    const end = from <= to ? to : from;
    return state.sessions
      .filter(s => s.date >= start && s.date <= end && s.closed)
      .sort((a, b) => b.date.localeCompare(a.date) || b.cashierName.localeCompare(a.cashierName))
      .map(session => {
        const sales = state.sales.filter(s =>
          dkey(s.date) === session.date &&
          s.cashierId === session.cashierId &&
          (s.status === 'completed' || s.status === 'exchanged')
        );
        const cashSales = sales.reduce((sum, sale) =>
          sum + salePayments(sale).filter(l => l.method === 'cash').reduce((x, l) => x + l.amount, 0), 0);
        const refunds = state.sales
          .filter(s => s.status === 'refunded' && dkey(s.date) === session.date && s.cashierId === session.cashierId)
          .reduce((sum, sale) => {
            const cashPart = salePayments(sale).filter(l => l.method === 'cash').reduce((x, l) => x + l.amount, 0);
            return sum + (cashPart > 0 ? cashPart : sale.total);
          }, 0);
        const expenses = state.expenses
          .filter(e => dkey(e.date) === session.date && (e.paymentMethod || 'cash') === 'cash' && e.by === session.cashierName)
          .reduce((sum, e) => sum + e.amount, 0);
        const expected = Math.round((session.opening + cashSales - refunds - expenses) * 100) / 100;
        const counted = Number(session.closing ?? 0);
        const variance = Math.round((counted - expected) * 100) / 100;
        const grossSales = sales.reduce((sum, sale) => sum + sale.total, 0);
        return { session, bills: sales.length, grossSales, cashSales, refunds, expenses, expected, counted, variance };
      });
  }, [state.sessions, state.sales, state.expenses, from, to]);

  const summary = useMemo(() => ({
    opening: rows.reduce((a, r) => a + r.session.opening, 0),
    sales: rows.reduce((a, r) => a + r.grossSales, 0),
    cash: rows.reduce((a, r) => a + r.cashSales, 0),
    refunds: rows.reduce((a, r) => a + r.refunds, 0),
    expenses: rows.reduce((a, r) => a + r.expenses, 0),
    expected: rows.reduce((a, r) => a + r.expected, 0),
    counted: rows.reduce((a, r) => a + r.counted, 0),
    variance: rows.reduce((a, r) => a + r.variance, 0),
  }), [rows]);

  const exportCsv = () => {
    const esc = (v: unknown) => {
      const t = String(v ?? '');
      return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const lines = [
      ['Date', 'Cashier', 'Opening', 'Bills', 'Sales', 'Cash Sales', 'Refunds', 'Cash Expenses', 'Expected Drawer', 'Counted Drawer', 'Variance', 'Note'].map(esc).join(','),
      ...rows.map(r => [
        r.session.date, r.session.cashierName, r.session.opening.toFixed(2), r.bills, r.grossSales.toFixed(2),
        r.cashSales.toFixed(2), r.refunds.toFixed(2), r.expenses.toFixed(2), r.expected.toFixed(2),
        r.counted.toFixed(2), r.variance.toFixed(2), r.session.note || '',
      ].map(esc).join(',')),
    ];
    downloadFile(`nexfix-day-close-${from}_to_${to}.csv`, lines.join('\n'), 'text/csv');
  };

  return (
    <div className="space-y-5">
      <PageHeading
        chip="Reports"
        title="Day Close Report"
        sub="Opening cash, daily sales, drawer reconciliation and closing variance"
        actions={<button type="button" className="btn btn-primary" onClick={exportCsv} disabled={!rows.length}><Download size={15} /> Export CSV</button>}
      />

      <div className="card p-4 flex flex-wrap items-end gap-3">
        <div>
          <div className="text-[10px] font-extrabold uppercase tracking-wider text-faint mb-1.5"><CalendarDays size={11} className="inline mr-1" /> From</div>
          <input type="date" className="input" value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div>
          <div className="text-[10px] font-extrabold uppercase tracking-wider text-faint mb-1.5">To</div>
          <input type="date" className="input" value={to} min={from} onChange={e => setTo(e.target.value)} />
        </div>
        <div className="text-xs text-sub pb-2">{fmtNum(rows.length)} closed drawer session{rows.length === 1 ? '' : 's'}</div>
      </div>

      {rows.length === 0 ? (
        <div className="card"><EmptyState icon={<Landmark size={26} />} title="No closed sessions in this period" sub="Close a business day from Day Cash & Drawer and the reconciliation will appear here." /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
            {[
              ['Opening', summary.opening], ['Sales', summary.sales], ['Cash sales', summary.cash], ['Refunds', summary.refunds],
              ['Cash expenses', summary.expenses], ['Expected', summary.expected], ['Counted', summary.counted], ['Variance', summary.variance],
            ].map(([label, value]) => (
              <div key={String(label)} className="card p-3">
                <div className="text-[9px] font-extrabold uppercase tracking-wider text-faint">{label}</div>
                <div className={`num text-[15px] font-extrabold mt-1 ${label === 'Variance' && Number(value) !== 0 ? 'text-rose-600' : 'text-ink'}`}>{fmtRs(Number(value))}</div>
              </div>
            ))}
          </div>

          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-line font-extrabold text-ink">Closed drawer sessions</div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1100px] text-sm">
                <thead><tr className="text-left text-[10px] uppercase tracking-wider text-faint border-b border-line">
                  <th className="px-4 py-3">Date</th><th className="py-3">Cashier</th><th className="py-3">Opening</th><th className="py-3">Bills</th><th className="py-3">Sales</th><th className="py-3">Cash</th><th className="py-3">Refunds</th><th className="py-3">Expenses</th><th className="py-3">Expected</th><th className="py-3">Counted</th><th className="py-3">Variance</th><th className="px-4 py-3">Status</th>
                </tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.session.id} className="border-b border-line last:border-0">
                      <td className="px-4 py-3 num">{r.session.date}</td>
                      <td className="py-3 font-semibold text-ink">{r.session.cashierName}</td>
                      <td className="py-3 num">{fmtRs(r.session.opening)}</td>
                      <td className="py-3 num">{fmtNum(r.bills)}</td>
                      <td className="py-3 num">{fmtRs(r.grossSales)}</td>
                      <td className="py-3 num">{fmtRs(r.cashSales)}</td>
                      <td className="py-3 num">{fmtRs(r.refunds)}</td>
                      <td className="py-3 num">{fmtRs(r.expenses)}</td>
                      <td className="py-3 num font-semibold">{fmtRs(r.expected)}</td>
                      <td className="py-3 num font-semibold">{fmtRs(r.counted)}</td>
                      <td className={`py-3 num font-bold ${r.variance === 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{fmtRs(r.variance)}</td>
                      <td className="px-4 py-3">{r.variance === 0 ? <Badge tone="emerald"><CheckCircle2 size={11} /> Balanced</Badge> : <Badge tone="rose"><AlertTriangle size={11} /> Variance</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
