import type { ElementType } from 'react';
import { Plus, Split, X } from 'lucide-react';
import type { PaymentLeg, PaymentMethod } from '../lib/types';
import { fmtRs } from '../lib/utils';

export interface POSPaymentOption {
  key: PaymentMethod;
  label: string;
  icon: ElementType;
}

interface POSPaymentMethodSelectorProps {
  methods: POSPaymentOption[];
  splitMethods: POSPaymentOption[];
  payment: PaymentMethod;
  splitOn: boolean;
  legs: PaymentLeg[];
  total: number;
  legSum: number;
  coverageLabel: string;
  coverageClassName: string;
  formatAmount: (amount: number) => string;
  onPaymentSelect: (method: PaymentMethod) => void;
  onToggleSplit: () => void;
  onLegMethodChange: (index: number, method: PaymentMethod) => void;
  onLegAmountChange: (index: number, value: string) => void;
  onRemoveLeg: (index: number) => void;
  onAddPayment: () => void;
}

export default function POSPaymentMethodSelector({
  methods,
  splitMethods,
  payment,
  splitOn,
  legs,
  total,
  legSum,
  coverageLabel,
  coverageClassName,
  formatAmount,
  onPaymentSelect,
  onToggleSplit,
  onLegMethodChange,
  onLegAmountChange,
  onRemoveLeg,
  onAddPayment,
}: POSPaymentMethodSelectorProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-bold tracking-wider uppercase text-faint">Payment method</span>
        <button
          onClick={onToggleSplit}
          className={`inline-flex items-center gap-1 text-[10.5px] font-bold px-2 py-1 rounded-lg border transition-all ${
            splitOn ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-raised text-sub border-line hover:text-ink'
          }`}
        >
          <Split size={11} /> Split
        </button>
      </div>
      {!splitOn ? (
        <div className="grid grid-cols-5 gap-1.5">
          {methods.map(method => {
            const disabled = method.key === 'credit' && method.key !== payment && !splitMethods.some(option => option.key === 'credit');
            return (
              <button
                key={method.key}
                disabled={disabled}
                onClick={() => onPaymentSelect(method.key)}
                className={`flex flex-col items-center gap-1 rounded-xl py-2 border text-[9.5px] font-bold transition-all ${
                  payment === method.key
                    ? 'bg-emerald-500 text-white border-emerald-500 shadow-md shadow-emerald-500/30'
                    : disabled
                      ? 'bg-raised/50 border-line text-faint opacity-50 cursor-not-allowed'
                      : 'bg-surface border-line text-sub hover:text-ink hover:border-violet-300'
                }`}
              >
                <method.icon size={15} />
                {method.label}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="space-y-1.5">
          {legs.map((leg, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <select
                className="input !w-28 !py-1.5 !px-2 !text-[12px]"
                value={leg.method}
                onChange={event => onLegMethodChange(index, event.target.value as PaymentMethod)}
              >
                {splitMethods.map(method => <option key={method.key} value={method.key}>{method.label}</option>)}
              </select>
              <input
                className="input flex-1 !py-1.5 !px-2.5 num !text-[12.5px] text-right"
                value={leg.amount ? formatAmount(leg.amount) : ''}
                onChange={event => onLegAmountChange(index, event.target.value)}
                placeholder="Amount"
                inputMode="decimal"
              />
              <button
                className="icon-btn !w-8 !h-8 hover:!bg-rose-500/10 hover:!text-rose-500"
                disabled={legs.length === 1}
                onClick={() => onRemoveLeg(index)}
                aria-label={`Remove payment ${index + 1}`}
              >
                <X size={13} />
              </button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <button className="text-[11px] font-bold text-indigo-500 hover:text-indigo-600 flex items-center gap-1" onClick={onAddPayment}>
              <Plus size={11} /> Add payment
            </button>
            <span className={`text-[11px] font-bold num ${coverageClassName}`}>{coverageLabel}</span>
          </div>
        </div>
      )}
    </div>
  );
}
