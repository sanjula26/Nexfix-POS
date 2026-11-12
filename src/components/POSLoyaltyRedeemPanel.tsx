import { CheckCircle2, Coins } from 'lucide-react';
import { fmtRs } from '../lib/utils';
import type { Customer } from '../lib/types';

interface POSLoyaltyRedeemPanelProps {
  customer?: Customer;
  enabled: boolean;
  points: string;
  maxRedeem: number;
  redeemedPoints: number;
  pointsValue: number;
  pointValue: number;
  onToggle: () => void;
  onPointsChange: (value: string) => void;
  onSetMax: () => void;
}

export default function POSLoyaltyRedeemPanel({
  customer,
  enabled,
  points,
  maxRedeem,
  redeemedPoints,
  pointsValue,
  pointValue,
  onToggle,
  onPointsChange,
  onSetMax,
}: POSLoyaltyRedeemPanelProps) {
  if (!customer || customer.loyaltyPoints <= 0) return null;

  return (
    <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-2.5">
      <div className="flex items-center justify-between">
        <button className="flex items-center gap-2" onClick={onToggle}>
          <span className={`w-[16px] h-[16px] rounded-[4px] border flex items-center justify-center transition-all ${enabled ? 'bg-amber-500 border-amber-500 text-white' : 'border-amber-400/50 bg-surface'}`}>
            {enabled && <CheckCircle2 size={11} strokeWidth={3} />}
          </span>
          <span className="text-[12px] font-bold text-amber-600 dark:text-amber-400 flex items-center gap-1">
            <Coins size={12} /> Redeem points · {customer.loyaltyPoints} available
          </span>
        </button>
        {enabled && (
          <div className="flex items-center gap-1.5">
            <input
              className="input !w-20 !py-1 !px-2 num !text-[12px] text-right"
              value={points}
              onChange={e => onPointsChange(e.target.value)}
              placeholder={String(maxRedeem)}
              inputMode="numeric"
            />
            <button className="text-[10px] font-bold text-amber-600 dark:text-amber-400" onClick={onSetMax}>MAX</button>
          </div>
        )}
      </div>
      {enabled && redeemedPoints > 0 && (
        <div className="text-right text-[11px] font-bold text-amber-600 dark:text-amber-400 num mt-1">
          − {fmtRs(pointsValue)} ({redeemedPoints} pts × Rs. {pointValue})
        </div>
      )}
    </div>
  );
}
