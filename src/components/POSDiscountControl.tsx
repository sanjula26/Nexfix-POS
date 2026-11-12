import { Percent } from 'lucide-react';
import { fmtRs } from '../lib/utils';

type DiscountMode = 'rs' | 'pct';

interface POSDiscountControlProps {
  mode: DiscountMode;
  discount: string;
  calculatedDiscount: number;
  canDiscount: boolean;
  inputRef: React.Ref<HTMLInputElement>;
  onModeChange: (mode: DiscountMode) => void;
  onDiscountChange: (value: string) => void;
}

export default function POSDiscountControl({
  mode,
  discount,
  calculatedDiscount,
  canDiscount,
  inputRef,
  onModeChange,
  onDiscountChange,
}: POSDiscountControlProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12.5px] text-sub flex items-center gap-1.5">
        Discount
        <span className="flex rounded-lg bg-raised border border-line overflow-hidden">
          {(['rs', 'pct'] as const).map(m => (
            <button
              key={m}
              onClick={() => onModeChange(m)}
              className={`px-2 py-[3px] text-[9.5px] font-extrabold transition-all ${mode === m ? 'bg-violet-600 text-white' : 'text-faint hover:text-ink'}`}
            >
              {m === 'rs' ? 'Rs.' : <Percent size={9} />}
            </button>
          ))}
        </span>
      </span>
      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          className={`input !w-24 !py-1.5 !px-2.5 num !text-[13px] text-right ${!canDiscount ? 'opacity-50 cursor-not-allowed' : ''}`}
          value={discount}
          onChange={e => onDiscountChange(e.target.value.replace(/[^\d.]/g, ''))}
          placeholder="0"
          inputMode="decimal"
          disabled={!canDiscount}
        />
        <span className="w-24 text-right num text-[12.5px] font-semibold text-rose-500">
          {calculatedDiscount > 0 ? `- ${fmtRs(calculatedDiscount, false)}` : '—'}
        </span>
      </div>
    </div>
  );
}
