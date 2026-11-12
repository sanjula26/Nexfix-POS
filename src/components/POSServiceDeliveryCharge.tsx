import { Plus, Truck, X } from 'lucide-react';
import { fmtRs } from '../lib/utils';

interface POSServiceDeliveryChargeProps {
  open: boolean;
  amount: string;
  calculatedAmount: number;
  onOpen: () => void;
  onClose: () => void;
  onAmountChange: (value: string) => void;
}

export default function POSServiceDeliveryCharge({
  open,
  amount,
  calculatedAmount,
  onOpen,
  onClose,
  onAmountChange,
}: POSServiceDeliveryChargeProps) {
  if (open) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl bg-sky-500/[0.04] border border-sky-500/20 px-2.5 py-2">
        <span className="text-[12.5px] text-sub flex items-center gap-1.5 font-semibold">
          <Truck size={12} className="text-sky-500" /> Service / Delivery
          <button className="text-faint hover:text-rose-500 ml-0.5" onClick={onClose} title="Remove service charge"><X size={11} /></button>
        </span>
        <div className="flex items-center gap-1.5">
          <input
            className="input !w-24 !py-1.5 !px-2.5 num !text-[13px] text-right"
            value={amount}
            onChange={e => onAmountChange(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder="0"
            inputMode="decimal"
          />
          <span className="w-24 text-right num text-[12.5px] font-semibold text-sky-600 dark:text-sky-400">
            {calculatedAmount > 0 ? fmtRs(calculatedAmount, false) : '—'}
          </span>
        </div>
      </div>
    );
  }

  return (
    <button
      className="w-full flex items-center justify-between rounded-xl border border-dashed border-line bg-raised/30 px-3 py-2 text-[11.5px] font-semibold text-sub hover:text-violet-600 hover:border-violet-300 transition-colors"
      onClick={onOpen}
    >
      <span className="flex items-center gap-1.5"><Truck size={12} /> Add service / delivery charge</span>
      <Plus size={13} />
    </button>
  );
}
