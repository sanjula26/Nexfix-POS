import { AnimatePresence, motion } from 'framer-motion';

export type POSPaymentBalanceState = 'idle' | 'short' | 'exact' | 'change' | 'due';

interface POSPaymentBalanceIndicatorProps {
  payState: POSPaymentBalanceState;
  total: number;
  paidNum: number;
  change: number;
  shortage: number;
  formatRs: (amount: number) => string;
}

/** Presentation-only payment balance / change indicator. All amounts and state are resolved by POS. */
export default function POSPaymentBalanceIndicator({
  payState,
  total,
  paidNum,
  change,
  shortage,
  formatRs,
}: POSPaymentBalanceIndicatorProps) {
  return (
    <AnimatePresence mode="wait">
      {total > 0 && (
        <motion.div
          key={payState}
          initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className={`flex justify-between items-center rounded-xl px-4 py-3 border ${
            payState === 'change'
              ? 'bg-emerald-500/10 border-emerald-500/30'
              : payState === 'exact'
                ? 'bg-sky-500/10 border-sky-500/30'
                : payState === 'due' || payState === 'short'
                  ? 'bg-rose-500/10 border-rose-500/30'
                  : 'bg-raised border-line'
          }`}
        >
          <span className={`text-[11px] font-extrabold tracking-wide ${
            payState === 'change' ? 'text-emerald-600 dark:text-emerald-400'
            : payState === 'exact' ? 'text-sky-600 dark:text-sky-400'
            : payState === 'due' || payState === 'short' ? 'text-rose-500'
            : 'text-faint'
          }`}>
            {payState === 'change' && 'CHANGE TO GIVE'}
            {payState === 'exact' && (paidNum > 0 ? 'EXACT AMOUNT' : 'AWAITING PAYMENT')}
            {payState === 'due' && 'BALANCE DUE (CREDIT)'}
            {payState === 'short' && 'SHORT OF TOTAL'}
            {payState === 'idle' && 'AWAITING PAYMENT'}
          </span>
          <span className={`num text-[17px] font-extrabold ${
            payState === 'change' ? 'text-emerald-600 dark:text-emerald-400'
            : payState === 'exact' ? 'text-sky-600 dark:text-sky-400'
            : payState === 'due' || payState === 'short' ? 'text-rose-500'
            : 'text-faint'
          }`}>
            {payState === 'change' && formatRs(change)}
            {payState === 'exact' && (paidNum > 0 ? formatRs(0) : formatRs(total))}
            {(payState === 'due' || payState === 'short') && formatRs(shortage)}
            {payState === 'idle' && formatRs(total)}
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
