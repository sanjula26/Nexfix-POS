import { fmtRs } from '../lib/utils';

interface POSTaxControlProps {
  defaultRate: number;
  taxRate: string;
  calculatedTax: number;
  onTaxRateChange: (value: string) => void;
}

export default function POSTaxControl({
  defaultRate,
  taxRate,
  calculatedTax,
  onTaxRateChange,
}: POSTaxControlProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12.5px] text-sub">
        Tax <span className="text-faint text-[10.5px]">(auto {defaultRate}%)</span>
      </span>
      <div className="flex items-center gap-1.5">
        <div className="relative">
          <input
            className="input !w-24 !py-1.5 !px-2.5 pr-6 num !text-[13px] text-right"
            value={taxRate}
            onChange={e => onTaxRateChange(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder="0"
            inputMode="decimal"
          />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-faint">%</span>
        </div>
        <span className="w-24 text-right num text-[12.5px] font-semibold text-sub">
          {calculatedTax > 0 ? fmtRs(calculatedTax, false) : '—'}
        </span>
      </div>
    </div>
  );
}
