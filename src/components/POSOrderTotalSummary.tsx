import { fmtRs } from '../lib/utils';

export default function POSOrderTotalSummary({
  fullAmount,
  pointsValueue,
  total,
}: {
  fullAmount: number;
  pointsValueue: number;
  total: number;
}) {
  return (
        {/* full amount before payment */}
        <div className="rounded-xl border border-line bg-surface px-3.5 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11.5px] font-bold text-sub">Full Amount</span>
            <span className="num text-[15px] font-extrabold text-ink">{fmtRs(fullAmount)}</span>
          </div>
          {pointsValue > 0 && (
            <div className="flex items-center justify-between mt-1 text-[10.5px]">
              <span className="text-amber-600 dark:text-amber-400">Loyalty points applied</span>
              <span className="num font-bold text-amber-600 dark:text-amber-400">− {fmtRs(pointsValue, false)}</span>
            </div>
          )}
        </div>

        {/* grand total */}
        <div className="!mt-3.5 rounded-2xl bg-gradient-to-r from-violet-600 to-indigo-600 px-5 py-4 flex items-end justify-between shadow-lg shadow-violet-600/30">
          <div className="text-white">
            <div className="text-[10px] font-extrabold tracking-[0.16em] text-violet-200 uppercase">Grand Total</div>
            {pointsValue > 0 && <div className="text-[10px] text-amber-300 num font-semibold mt-0.5">points applied: −{fmtRs(pointsValue)}</div>}
            <div className="text-[10px] text-violet-200 mt-0.5">incl. tax &amp; charges</div>
          </div>
          <div className="num text-[32px] leading-none font-extrabold text-white drop-shadow-sm">{fmtRs(total)}</div>
        </div>
  );
}
