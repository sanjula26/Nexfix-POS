import { motion } from 'framer-motion';
import { PauseCircle, Trash2, Zap } from 'lucide-react';
import type { HeldSale } from '../lib/types';

interface POSHeldSaleRowProps {
  heldSale: HeldSale;
  heldAtLabel: string;
  customerName: string;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
}

export default function POSHeldSaleRow({
  heldSale,
  heldAtLabel,
  customerName,
  onResume,
  onDelete,
}: POSHeldSaleRowProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -18 }}
      className="flex items-center gap-3 rounded-xl bg-raised border border-line px-4 py-3"
    >
      <span className="w-9 h-9 rounded-lg bg-amber-500/15 text-amber-500 flex items-center justify-center shrink-0">
        <PauseCircle size={16} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-ink truncate">{heldSale.label}</div>
        <div className="text-[11px] text-faint">
          {heldAtLabel} · {heldSale.lines.length} lines{heldSale.customerId ? ` · ${customerName}` : ''}
        </div>
      </div>
      <button className="btn btn-soft !py-1.5 !px-3 !text-xs text-emerald-500" onClick={() => onResume(heldSale.id)}>
        <Zap size={13} /> Resume
      </button>
      <button className="btn btn-danger-soft !py-1.5 !px-3 !text-xs" onClick={() => onDelete(heldSale.id)}>
        <Trash2 size={13} />
      </button>
    </motion.div>
  );
}
