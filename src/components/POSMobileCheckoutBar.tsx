import { Zap } from 'lucide-react';
import { fmtRs } from '../lib/utils';

export default function POSMobileCheckoutBar({
  visible,
  itemCount,
  total,
  onReviewPay,
}: {
  visible: boolean;
  itemCount: number;
  total: number;
  onReviewPay: () => void;
}) {
  if (!visible) return null;

  return (
    <div className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-surface/95 backdrop-blur border-t border-line px-4 py-3 flex items-center gap-3 no-print">
      <div className="flex-1 min-w-0">
        <div className="text-[10px] font-bold tracking-wider uppercase text-faint num">{itemCount} items</div>
        <div className="num text-lg font-extrabold text-violet-600 dark:text-violet-400 leading-none">{fmtRs(total)}</div>
      </div>
      <button type="button" className="btn btn-primary !py-3" onClick={onReviewPay}>
        <Zap size={15} /> Review &amp; Pay
      </button>
    </div>
  );
}
