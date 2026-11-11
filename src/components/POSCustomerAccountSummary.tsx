import { BadgeDollarSign } from 'lucide-react';
import { fmtRs } from '../lib/utils';
import type { Sale } from '../lib/types';

export default function POSCustomerAccountSummary({
  creditBalance,
  lastPurchases,
}: {
  creditBalance: number;
  lastPurchases: Sale[];
}) {
  return (
    <>
      {creditBalance > 0 && (
        <div className="flex items-center justify-between mt-2.5 rounded-lg bg-rose-500/10 border border-rose-500/25 px-3 py-2">
          <span className="text-[10.5px] font-extrabold tracking-wide text-rose-500 flex items-center gap-1.5">
            <BadgeDollarSign size={12} /> OUTSTANDING BALANCE
          </span>
          <span className="num text-[13px] font-extrabold text-rose-500">{fmtRs(creditBalance)}</span>
        </div>
      )}
      {lastPurchases.length > 0 && (
        <div className="mt-3 rounded-lg border border-line bg-raised/50 px-3 py-2.5">
          <div className="text-[10px] font-extrabold uppercase tracking-wider text-sub mb-1.5">Last purchases</div>
          <div className="space-y-1">
            {lastPurchases.map(s => <div key={s.id} className="flex items-center justify-between gap-3 text-[11px]"><span className="text-sub truncate">{s.billNo} · {s.items.slice(0, 2).map(x => x.name).join(', ')}{s.items.length > 2 ? '…' : ''}</span><span className="num font-semibold text-ink shrink-0">{fmtRs(s.total, false)}</span></div>)}
          </div>
        </div>
      )}
    </>
  );
}
