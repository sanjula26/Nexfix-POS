import { useMemo, useState } from 'react';
import { Download, Landmark, CalendarDays, CheckCircle2, AlertTriangle, Printer } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, EmptyState, PageHeading } from '../components/ui';
import { dkey, downloadFile, fmtRs, fmtNum } from '../lib/utils';
import { calculateDayEndTotals } from '../lib/dayEnd';

export default function DayCloseReport() {
  const { state } = usePOS();
  const today = dkey(new Date());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);

  const rows = useMemo(() => {
    const start = from <= to ? from : to;
    const end = from <= to ? to : from;
    return state.sessions
      .filter(session => session.date >= start && session.date <= end && session.closed)
      .sort((a, b) => b.date.localeCompare(a.date) || b.cashierName.localeCompare(a.cashierName))
      .map(session => {
        const totals = calculateDayEndTotals(state, session.date, session);
        const counted = Number(session.closing ?? 0);
        const expected = session.expected != null && Number.isFinite(session.expected) ? session.expected : totals.expected;
        const variance = session.variance != null && Number.isFinite(session.variance)
          ? session.variance
          : Math.round((counted - expected) * 100) / 100;
        return { session, totals, counted, expected, variance };
      });
  }, [state, from, to]);

  const summary = useMemo(() => ({
    opening: rows.reduce((sum, row) => sum + row.session.opening, 0),
    gross: rows.reduce((sum, row) => sum + row.totals.grossSales, 0),
    refunds: rows.reduce((sum, row) => sum + row.totals.refunds, 0),
    net: rows.reduce((sum, row) => sum + row.totals.netSales, 0),
    cash: rows.reduce((sum, row) => sum + row.totals.cash, 0),
    credit: rows.reduce((sum, row) => sum + row.totals.creditSales, 0),
    settled: rows.reduce((sum, row) => sum + row.totals.creditSettledTotal, 0),
    expenses: rows.reduce((sum, row) => sum + row.totals.expenses, 0),
    expected: rows.reduce((sum, row) => sum + row.expected, 0),
    counted: rows.reduce((sum, row) => sum + row.counted, 0),
    variance: rows.reduce((sum, row) => sum + row.variance, 0),
  }), [rows]);

  const exportCsv = () => {
    const esc = (value: unknown) => {
      const text = String(value ?? '');
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const headers = [
      'Date', 'Cashier', 'Status', 'Opening', 'Bills', 'Gross Sales', 'Returns / Refunds', 'Net Sales',
      'Cash Received', 'Card Received', 'Bank Received', 'Mobile Received', 'Credit Balance Due Issued',
      'Credit Settled Cash', 'Credit Settled Card', 'Credit Settled Bank', 'Credit Settled Mobile',
      'Total Credit Settled', 'Expenses', 'Cash Expenses', 'Discounts', 'Expected Cash', 'Counted Cash',
      'Variance', 'Signed Off By', 'Signed Off At', 'Note',
    ];
    const lines = [
      headers.map(esc).join(','),
      ...rows.map(({ session, totals, expected, counted, variance }) => [
        session.date, session.cashierName, variance === 0 ? 'Balanced' : variance > 0 ? 'Over' : 'Short',
        session.opening.toFixed(2), totals.bills, totals.grossSales.toFixed(2), totals.refunds.toFixed(2), totals.netSales.toFixed(2),
        totals.cash.toFixed(2), totals.card.toFixed(2), totals.bank.toFixed(2), totals.mobile.toFixed(2),
        totals.creditSales.toFixed(2), totals.creditSettled.cash.toFixed(2), totals.creditSettled.card.toFixed(2),
        totals.creditSettled.bank.toFixed(2), totals.creditSettled.mobile.toFixed(2), totals.creditSettledTotal.toFixed(2),
        totals.expenses.toFixed(2), totals.cashExpenses.toFixed(2), totals.discounts.toFixed(2),
        expected.toFixed(2), counted.toFixed(2), variance.toFixed(2), session.closedBy || '', session.closedAt || '', session.note || '',
      ].map(esc).join(',')),
    ];
    downloadFile(`nexfix-day-close-${from}_to_${to}.csv`, lines.join('\n'), 'text/csv;charset=utf-8');
  };

  return (
    <div className="space-y-5 print:space-y-3">
      <PageHeading
        chip="Reports"
        title="Day Close Report"
        sub="Historical cashier sign-offs, tender breakdown, credit settlements and saved variance"
        actions={
          <div className="flex flex-wrap gap-2 print:hidden">
            <button type="button" className="btn btn-soft" onClick={() => window.print()}><Printer size={15} /> Print</button>
            <button type="button" className="btn btn-primary" onClick={exportCsv} disabled={!rows.length}><Download size={15} /> Export CSV</button>
          </div>
        }
      />

      <div className="card p-4 flex flex-wrap items-end gap-3 print:hidden">
        <div>
          <div className="text-[10px] font-extrabold uppercase tracking-wider text-faint mb-1.5"><CalendarDays size={11} className="inline mr-1" /> From</div>
          <input type="date" className="input" value={from} onChange={event => setFrom(event.target.value)} />
        </div>
        <div>
          <div className="text-[10px] font-extrabold uppercase tracking-wider text-faint mb-1.5">To</div>
          <input type="date" className="input" value={to} min={from} onChange={event => setTo(event.target.value)} />
        </div>
        <div className="text-xs text-sub pb-2">{fmtNum(rows.length)} closed drawer session{rows.length === 1 ? '' : 's'}</div>
      </div>

      {rows.length === 0 ? (
        <div className="card"><EmptyState icon={<Landmark size={26} />} title="No closed sessions in this period" sub="After a cashier signs off, the saved reconciliation appears here." /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            {[
              ['Opening float', summary.opening], ['Gross sales', summary.gross], ['Returns / refunds', summary.refunds],
              ['Net sales', summary.net], ['Cash received', summary.cash], ['Credit balance due', summary.credit],
              ['Credit settled', summary.settled], ['Expenses', summary.expenses], ['Expected cash', summary.expected],
              ['Counted cash', summary.counted], ['Variance total', summary.variance],
            ].map(([label, value]) => (
              <div key={String(label)} className="card p-3">
                <div className="text-[9px] font-extrabold uppercase tracking-wider text-faint">{label}</div>
                <div className={`num text-[15px] font-extrabold mt-1 ${label === 'Variance total' && Number(value) !== 0 ? 'text-rose-600' : label === 'Credit settled' ? 'text-emerald-600' : 'text-ink'}`}>{fmtRs(Number(value))}</div>
              </div>
            ))}
          </div>

          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-line font-extrabold text-ink">Closed cashier sessions</div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1750px] text-sm">
                <thead><tr className="text-left text-[10px] uppercase tracking-wider text-faint border-b border-line">
                  <th className="px-4 py-3">Date / cashier</th><th className="py-3">Opening</th><th className="py-3">Bills</th>
                  <th className="py-3">Gross sales</th><th className="py-3">Refunds</th><th className="py-3">Net sales</th>
                  <th className="py-3">Cash</th><th className="py-3">Card</th><th className="py-3">Bank</th><th className="py-3">Mobile</th>
                  <th className="py-3">Credit due</th><th className="py-3">Settled cash</th><th className="py-3">Settled non-cash</th>
                  <th className="py-3">Expenses</th><th className="py-3">Discounts</th><th className="py-3">Expected</th>
                  <th className="py-3">Counted</th><th className="py-3">Variance</th><th className="px-4 py-3">Status / sign-off</th>
                </tr></thead>
                <tbody>
                  {rows.map(({ session, totals, expected, counted, variance }) => (
                    <tr key={session.id} className="border-b border-line last:border-0 align-top">
                      <td className="px-4 py-3"><div className="num">{session.date}</div><div className="font-semibold text-ink mt-1">{session.cashierName}</div></td>
                      <td className="py-3 num">{fmtRs(session.opening)}</td><td className="py-3 num">{fmtNum(totals.bills)}</td>
                      <td className="py-3 num">{fmtRs(totals.grossSales)}</td><td className="py-3 num">{fmtRs(totals.refunds)}</td>
                      <td className="py-3 num font-semibold">{fmtRs(totals.netSales)}</td>
                      <td className="py-3 num">{fmtRs(totals.cash)}</td><td className="py-3 num">{fmtRs(totals.card)}</td>
                      <td className="py-3 num">{fmtRs(totals.bank)}</td><td className="py-3 num">{fmtRs(totals.mobile)}</td>
                      <td className="py-3 num text-amber-600">{fmtRs(totals.creditSales)}</td>
                      <td className="py-3 num text-emerald-600">{fmtRs(totals.creditSettled.cash)}</td>
                      <td className="py-3 num">{fmtRs(totals.creditSettled.card + totals.creditSettled.bank + totals.creditSettled.mobile)}</td>
                      <td className="py-3 num">{fmtRs(totals.expenses)}</td><td className="py-3 num">{fmtRs(totals.discounts)}</td>
                      <td className="py-3 num font-semibold">{fmtRs(expected)}</td><td className="py-3 num font-semibold">{fmtRs(counted)}</td>
                      <td className={`py-3 num font-bold ${variance === 0 ? 'text-emerald-600' : variance > 0 ? 'text-amber-600' : 'text-rose-600'}`}>{fmtRs(variance)}</td>
                      <td className="px-4 py-3">
                        {variance === 0 ? <Badge tone="emerald"><CheckCircle2 size={11} /> Balanced</Badge> : variance > 0 ? <Badge tone="amber"><AlertTriangle size={11} /> Over</Badge> : <Badge tone="rose"><AlertTriangle size={11} /> Short</Badge>}
                        <div className="text-[10px] text-sub mt-1">{session.closedBy ? `By ${session.closedBy}` : 'Signed off'}</div>
                        {session.closedAt && <div className="text-[10px] text-sub">{new Date(session.closedAt).toLocaleString()}</div>}
                        {session.note && <div className="text-[10px] text-sub mt-1 max-w-40 whitespace-normal">{session.note}</div>}
                      </td>
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
