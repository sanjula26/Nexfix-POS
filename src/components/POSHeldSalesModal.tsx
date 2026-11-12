import { AnimatePresence, motion } from 'framer-motion';
import { PauseCircle, Trash2, Zap } from 'lucide-react';
import { Modal } from './ui';

interface POSHeldSalesModalProps {
  open: boolean;
  items: { id: string; label: string; detail: string }[];
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export default function POSHeldSalesModal({
  open,
  items,
  onResume,
  onDelete,
  onClose,
}: POSHeldSalesModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Held sales" sub="Resume or discard parked carts">
      <div className="space-y-2.5">
        <AnimatePresence initial={false}>
          {items.map(item => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -18 }}
              className="flex items-center gap-3 rounded-xl bg-raised border border-line px-4 py-3"
            >
              <span className="w-9 h-9 rounded-lg bg-amber-500/15 text-amber-500 flex items-center justify-center shrink-0"><PauseCircle size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-ink truncate">{item.label}</div>
                <div className="text-[11px] text-faint">{item.detail}</div>
              </div>
              <button className="btn btn-soft !py-1.5 !px-3 !text-xs text-emerald-500" onClick={() => onResume(item.id)}><Zap size={13} /> Resume</button>
              <button className="btn btn-danger-soft !py-1.5 !px-3 !text-xs" onClick={() => onDelete(item.id)}><Trash2 size={13} /></button>
            </motion.div>
          ))}
        </AnimatePresence>
        {items.length === 0 && <p className="text-sm text-sub text-center py-6">No held sales — press F5 to park the current bill</p>}
      </div>
    </Modal>
  );
}
