export default function POSSplitCreditSummary({
  total,
  receivedNow,
  balanceOnCredit,
}: {
  total: string;
  receivedNow: string;
  balanceOnCredit: string;
}) {
  return (
    <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3 grid grid-cols-3 gap-2 text-center">
      <div><div className="text-[9px] uppercase tracking-wide text-faint">Total</div><div className="font-extrabold num text-xs">{total}</div></div>
      <div><div className="text-[9px] uppercase tracking-wide text-faint">Received now</div><div className="font-extrabold num text-xs text-emerald-600">{receivedNow}</div></div>
      <div><div className="text-[9px] uppercase tracking-wide text-faint">Balance on credit</div><div className="font-extrabold num text-xs text-amber-600">{balanceOnCredit}</div></div>
    </div>
  );
}
