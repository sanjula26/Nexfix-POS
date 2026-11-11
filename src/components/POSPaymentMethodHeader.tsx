import { Split } from 'lucide-react';

export default function POSPaymentMethodHeader({
  splitOn,
  onToggleSplit,
}: {
  splitOn: boolean;
  onToggleSplit: () => void;
}) {
  return (
    <div className="flex items-center justify-between mb-1.5">
      <span className="text-[10px] font-bold tracking-wider uppercase text-faint">Payment method</span>
      <button
        type="button"
        onClick={onToggleSplit}
        className={`inline-flex items-center gap-1 text-[10.5px] font-bold px-2 py-1 rounded-lg border transition-all ${
          splitOn ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-raised text-sub border-line hover:text-ink'
        }`}
      >
        <Split size={11} /> Split
      </button>
    </div>
  );
}
