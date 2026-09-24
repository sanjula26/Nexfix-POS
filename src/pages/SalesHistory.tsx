import { useMemo, useState } from 'react';
import {
  ReceiptText, Eye, RotateCcw, Printer, TrendingUp, Banknote, CalendarDays, ShieldCheck, CheckCircle2, X,
} from 'lucide-react';
import { usePOS } from '../lib/store';
import { SearchInput, Badge, Modal, EmptyState, PageHeading, Avatar } from '../components/ui';
import ReceiptModal from '../components/ReceiptModal';
import { fmtRs, fmtDateTime, fmtNum, PAYMENT_LABEL, periodRange, inRange, salePayments, salePaymentLabel } from '../lib/utils';
import type { Sale } from '../lib/types';

type RangeKey = 'today' | 'custom' | 'week' | 'month' | 'all';

export default function SalesHistory() {
  const { state, refundSale, can, user, approveBillReverse, rejectBillReverse } = usePOS();
  const [search, setSearch] = useState('');
  const [range, setRange] = useState<RangeKey>('all');
  const [paymentFilter, setPaymentFilter] = useState('all');
  const [cashierFilter, setCashierFilter] = useState('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [view, setView] = useState<Sale | null>(null);
  const [refunding, setRefunding] = useState<Sale | null>(null);
  const [printSale, setPrintSale] = useState<Sale | null>(null);
  const [limit, setLimit] = useState(50);
  const [refundBusy, setRefundBusy] = useState(false);
  const [reverseBusy, setReverseBusy] = useState<string | null>(null);

  const cashiers = useMemo(() => [...new Map(state.sales.map(s => [s.cashierId, s.cashierName])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [state.sales]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const [a, b] = range === 'custom'
      ? [customFrom ? new Date(customFrom + 'T00:00:00') : new Date(0), customTo ? new Date(customTo + 'T23:59:59.999') : new Date()]
      : periodRange(range === 'all' ? 'all' : range);
    return [...state.sales]
      .sort((x, y) => +new Date(y.date) - +new Date(x.date))
      .filter(s => {
        const paymentMatches = paymentFilter === 'all' || salePayments(s).some(l => l.method === paymentFilter);
        return inRange(s.date, [a, b]) && paymentMatches &&
          (cashierFilter === 'all' || s.cashierId === cashierFilter) &&
          (!q || s.billNo.toLowerCase().includes(q) || s.customerName.toLowerCase().includes(q) || s.cashierName.toLowerCase().includes(q));
      });
  }, [state.sales, search, range, paymentFilter, cashierFilter, customFrom, customTo]);

  const revenue = rows.filter(s => s.status !== 'refunded' && s.status !== 'reversed').reduce((a, s) => a + s.total, 0);
  const refunded = rows.filter(s => s.status === 'refunded').length;
  const reversed = rows.filter(s => s.status === 'reversed').length;

  return (
    <div>
      <PageHeading
        chip="Transactions" chipTone="violet"
        title="Sales History"
        sub={`${fmtNum(rows.length)} bills · ${fmtRs(revenue)} revenue${refunded ? ` · ${refunded} refunded` : ''}${reversed ? ` · ${reversed} reversed` : ''}`}
        actions={
          <div className="flex flex-wrap gap-1.5 bg-raised border border-line rounded-xl p-1">
            {(['today', 'custom', 'week', 'month', 'all'] as RangeKey[]).map(r => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  range === r ? 'bg-violet-600 text-white shadow-md shadow-violet-600/30' : 'text-sub hover:text-ink'
                }`}
              >
                {{ today: 'Today', custom: 'Custom', week: 'This Week', month: 'This Month', all: 'All Time' }[r]}
              </button>
            ))}
          </div>
        }
      />

      {range === 'custom' && (
        <div className="card mb-4 p-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-sub">Custom date</span>
          <input type="date" className="input w-40" value={customFrom} onChange={e => setCustomFrom(e.target.value)} aria-label="Sales from date" />
          <span className="text-xs text-faint">to</span>
          <input type="date" className="input w-40" value={customTo} min={customFrom || undefined} onChange={e => setCustomTo(e.target.value)} aria-label="Sales to date" />
        </div>
      )}

      {user?.role === 'admin' && (state.reverseRequests || []).some(r => r.status === 'pending') && (
        <div className="card mb-4 overflow-hidden border-amber-500/30">
          <div className="px-4 py-3 border-b border-line bg-amber-500/[0.06] flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-lg bg-amber-500/15 text-amber-600 flex items-center justify-center"><ShieldCheck size={15} /></span>
              <div><div className="text-sm font-extrabold text-ink">Reverse approvals</div><div className="text-[10.5px] text-faint">Admin approval is required before stock or sale status changes.</div></div>
            </div>
            <Badge tone="amber">{(state.reverseRequests || []).filter(r => r.status === 'pending').length} pending</Badge>
          </div>
          <div className="divide-y divide-line">
            {(state.reverseRequests || []).filter(r => r.status === 'pending').slice(0, 10).map(req => {
              const sale = state.sales.find(x => x.id === req.saleId);
              if (!sale) return null;
              return (
                <div key={req.id} className="p-4 flex flex-col lg:flex-row lg:items-center gap-3">
                  <div className="flex-1 min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-bold text-violet-500">{req.billNo}</span><span className="text-xs text-sub">{sale.customerName}</span><span className="num text-xs font-bold text-ink">{fmtRs(sale.total)}</span></div><div className="text-[11px] text-faint mt-1">Requested by {req.requestedBy} · {req.reason}</div></div>
                  <div className="flex gap-2 shrink-0">
                    <button className="btn btn-outline-emerald !py-2 !px-3" onClick={() => approveBillReverse(req.id)}><CheckCircle2 size={14} /> Approve</button>
                    <button className="btn btn-danger-soft !py-2 !px-3" onClick={() => { const note = window.prompt('Optional rejection note:', ''); rejectBillReverse(req.id, note || undefined); }}><X size={14} /> Reject</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="card overflow-hidden">
        <div className="p-4 border-b border-line">
          <div className="flex flex-wrap gap-2 items-center">
            <SearchInput value={search} onChange={setSearch} placeholder="Search by bill #, customer, cashier..." className="flex-1 min-w-[240px] max-w-md" />
            <select className="input w-36" value={paymentFilter} onChange={e => setPaymentFilter(e.target.value)} aria-label="Filter by payment">
              <option value="all">All payments</option><option value="cash">Cash</option><option value="card">Card</option><option value="bank">Bank</option><option value="mobile">Mobile</option><option value="credit">Credit</option>
            </select>
            <select className="input w-44" value={cashierFilter} onChange={e => setCashierFilter(e.target.value)} aria-label="Filter by cashier">
              <option value="all">All cashiers</option>{cashiers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </div>
        </div>
        {rows.length === 0 ? (
          <EmptyState icon={<ReceiptText size={26} />} title="No sales found" sub="Completed bills will appear here" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px]">
              <thead>
                <tr>
                  <th className="th">Bill #</th><th className="th">Date</th><th className="th">Customer</th>
                  <th className="th">Cashier</th><th className="th">Items</th><th className="th">Payment</th>
                  <th className="th">Status</th><th className="th !text-right">Total</th><th className="th !text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, limit).map(s => (
                  <tr key={s.id} className="hover:bg-raised/40 transition-colors">
                    <td className="td font-bold text-violet-500 whitespace-nowrap">{s.billNo}</td>
                    <td className="td text-[12.5px] text-sub whitespace-nowrap"><span className="inline-flex items-center gap-1.5"><CalendarDays size={12} className="text-faint" />{fmtDateTime(s.date)}</span></td>
                    <td className="td text-[13px] text-ink font-medium">{s.customerName}</td>
                    <td className="td">
                      <span className="inline-flex items-center gap-2"><Avatar name={s.cashierName} size={22} /><span className="text-[12.5px] text-sub">{s.cashierName.split(' ')[0]}</span></span>
                    </td>
                    <td className="td num text-sub">{s.items.reduce((a, i) => a + i.qty, 0)}</td>
                    <td className="td"><Badge tone={s.payments && s.payments.length > 1 ? 'violet' : s.payment === 'cash' ? 'emerald' : s.payment === 'card' ? 'blue' : s.payment === 'credit' ? 'amber' : 'violet'}>{salePaymentLabel(s)}</Badge></td>
                    <td className="td">
                      <Badge tone={s.status === 'completed' ? 'emerald' : s.status === 'refunded' ? 'rose' : s.status === 'reversed' ? 'rose' : 'amber'}>
                        {s.status.toUpperCase()}
                      </Badge>
                    </td>
                    <td className="td num font-bold text-right">{fmtRs(s.total)}</td>
                    <td className="td">
                      <div className="flex items-center justify-end gap-1">
                        <button className="icon-btn !w-8 !h-8" title="View" onClick={() => setView(s)}><Eye size={14} /></button>
                        <button className="icon-btn !w-8 !h-8" title="Reprint receipt" onClick={() => setPrintSale(s)}><Printer size={14} /></button>
                        {can('act:refund') && s.status === 'completed' && (
                          <button className="icon-btn !w-8 !h-8 hover:!bg-rose-500/10 hover:!text-rose-500" title="Refund" onClick={() => setRefunding(s)}>
                            <RotateCcw size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > limit ? (
              <div className="p-4 text-center">
                <button type="button" className="btn btn-soft" onClick={() => setLimit(l => l + 50)}>
                  Load more ({limit} of {rows.length})
                </button>
              </div>
            ) : rows.length > 0 ? (
              <div className="p-3 text-center text-xs text-faint">Showing all {rows.length} bills</div>
            ) : null}
          </div>
        )}
      </div>

      {/* view bill */}
      <Modal open={!!view} onClose={() => setView(null)} title={`Bill ${view?.billNo}`} sub={view ? fmtDateTime(view.date) : ''} wide>
        {view && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                ['Customer', view.customerName], ['Cashier', view.cashierName],
                ['Payment', view.payments && view.payments.length > 1 ? `SPLIT (${view.payments.map(l => PAYMENT_LABEL[l.method]).join(' + ')})` : PAYMENT_LABEL[view.payment]], ['Status', view.status.toUpperCase()],
              ].map(([l, v]) => (
                <div key={l} className="rounded-xl bg-raised border border-line p-3">
                  <div className="text-[10px] font-bold tracking-wider uppercase text-faint">{l}</div>
                  <div className="text-[13px] font-bold text-ink mt-1">{v}</div>
                </div>
              ))}
            </div>
            <div className="rounded-xl border border-line overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr><th className="th">Item</th><th className="th">Qty</th><th className="th">Price</th><th className="th !text-right">Amount</th></tr>
                </thead>
                <tbody>
                  {view.items.map((it, i) => (
                    <tr key={i}>
                      <td className="td text-[13px] font-medium">
                        {it.name}
                        {(it.discount || 0) > 0 && <div className="text-[10px] text-rose-500 num">item discount − {fmtRs(it.discount || 0)}</div>}
                        {it.imeis?.length ? <div className="text-[10px] text-faint num">IMEI: {it.imeis.join(', ')}</div> : null}
                        {it.serials?.length ? <div className="text-[10px] text-faint num">S/N: {it.serials.join(', ')}</div> : null}
                        {it.warrantyMonths ? <div className="text-[10px] text-emerald-600">Warranty {it.warrantyMonths} mo</div> : null}
                      </td>
                      <td className="td num">{it.qty}</td>
                      <td className="td num">{fmtRs(it.price)}</td>
                      <td className="td num font-semibold text-right">{fmtRs(it.price * it.qty - (it.discount || 0))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between text-sub"><span>Subtotal</span><span className="num">{fmtRs(view.items.reduce((a, i) => a + i.price * i.qty - (i.discount || 0), 0))}</span></div>
              {view.discount > 0 && <div className="flex justify-between text-rose-500"><span>Discount</span><span className="num">- {fmtRs(view.discount)}</span></div>}
              {view.note && (
                <div className="rounded-lg bg-amber-500/[0.08] border border-amber-500/25 px-3 py-2 text-[12px] text-amber-600 dark:text-amber-400">
                  <b>Note:</b> {view.note}
                </div>
              )}
              {view.tax > 0 && <div className="flex justify-between text-sub"><span>Tax</span><span className="num">{fmtRs(view.tax)}</span></div>}
              {(view.shipping || 0) > 0 && <div className="flex justify-between text-sub"><span>Delivery / other</span><span className="num">{fmtRs(view.shipping || 0)}</span></div>}
              {(view.pointsRedeemed || 0) > 0 && <div className="flex justify-between text-amber-600 dark:text-amber-400"><span>Loyalty points ({view.pointsRedeemed} pts)</span><span className="num">- {fmtRs((view.pointsRedeemed || 0) * Math.max(0, Number(state.settings.loyaltyPointValue ?? 20)))}</span></div>}
              {can('act:viewCost') && (
                <div className="flex justify-between text-emerald-500"><span className="flex items-center gap-1.5"><TrendingUp size={13} /> Profit</span><span className="num">{fmtRs(view.profit)}</span></div>
              )}
              <div className="flex justify-between text-lg font-extrabold text-ink pt-2 border-t border-line"><span>Total</span><span className="num">{fmtRs(view.total)}</span></div>
              {view.payments && view.payments.length > 1 && (
                <div className="rounded-lg bg-raised border border-line px-3 py-2 space-y-1">
                  {salePayments(view).map((l, i) => (
                    <div key={i} className="flex justify-between text-[12px] text-sub"><span>{PAYMENT_LABEL[l.method]}</span><span className="num">{fmtRs(l.amount)}</span></div>
                  ))}
                </div>
              )}
              <div className="flex justify-between text-sub text-[13px]"><span className="flex items-center gap-1.5"><Banknote size={13} /> Paid / Change</span><span className="num">{fmtRs(view.amountPaid)} / {fmtRs(view.change)}</span></div>
            </div>
            <div className="flex gap-2.5">
              <button className="btn btn-primary flex-1" onClick={() => { setPrintSale(view); setView(null); }}><Printer size={15} /> Print receipt</button>
              <button className="btn btn-soft" onClick={() => setView(null)}>Close</button>
            </div>
          </div>
        )}
      </Modal>

      {/* refund confirm */}
      <Modal open={!!refunding} onClose={() => setRefunding(null)} title="Refund this bill?" sub={refunding?.billNo}>
        <p className="text-sm text-sub">
          Refunding <b className="text-ink">{refunding?.billNo}</b> returns <b className="num text-ink">{refunding ? fmtRs(refunding.total) : ''}</b> to the customer and restocks all items.
          This is logged against <b className="text-ink">{user?.name}</b>.
        </p>
        <div className="flex gap-2.5 mt-5">
          <button
            className="btn btn-danger-soft flex-1"
            onClick={async () => {
              if (!refunding || refundBusy) return;
              setRefundBusy(true);
              try {
                const ok = await refundSale(refunding.id);
                if (ok) setRefunding(null);
              } finally {
                setRefundBusy(false);
              }
            }}
            disabled={refundBusy}
          >
            <RotateCcw size={15} /> {refundBusy ? 'Processing…' : 'Refund bill'}
          </button>
          <button className="btn btn-soft flex-1" onClick={() => setRefunding(null)}>Cancel</button>
        </div>
      </Modal>

      <ReceiptModal sale={printSale} onClose={() => setPrintSale(null)} />
    </div>
  );
}
