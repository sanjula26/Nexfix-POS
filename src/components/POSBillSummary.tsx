import { fmtRs } from '../lib/utils';

interface POSBillSummaryProps {
  nextBillPreview: string;
  customerName: string;
  customerPhone: string;
  creditBalance: number;
}

export default function POSBillSummary({
  nextBillPreview,
  customerName,
  customerPhone,
  creditBalance,
}: POSBillSummaryProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-line border-b border-line">
      <div className="bg-surface px-4 sm:px-5 py-2.5">
        <div className="text-[9px] font-extrabold uppercase tracking-[0.14em] text-faint">Invoice No · next</div>
        <div className="num text-[14px] font-extrabold text-violet-600 dark:text-violet-400 mt-0.5">{nextBillPreview}</div>
      </div>
      <div className="bg-surface px-4 sm:px-5 py-2.5">
        <div className="text-[9px] font-extrabold uppercase tracking-[0.14em] text-faint">Customer</div>
        <div className="text-[12.5px] font-bold text-ink truncate mt-0.5">{customerName}</div>
      </div>
      <div className="bg-surface px-4 sm:px-5 py-2.5">
        <div className="text-[9px] font-extrabold uppercase tracking-[0.14em] text-faint">Mobile / WhatsApp</div>
        <div className="num text-[12.5px] font-bold text-ink truncate mt-0.5">{customerPhone}</div>
      </div>
      <div className="bg-surface px-4 sm:px-5 py-2.5">
        <div className="text-[9px] font-extrabold uppercase tracking-[0.14em] text-faint">Customer Balance</div>
        <div className={`num text-[14px] font-extrabold mt-0.5 ${creditBalance ? 'text-rose-500' : 'text-emerald-600 dark:text-emerald-400'}`}>
          {fmtRs(creditBalance)}
        </div>
      </div>
    </div>
  );
}
