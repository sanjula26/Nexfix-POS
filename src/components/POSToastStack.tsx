import { AlertTriangle } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

export default function POSToastStack({
  toasts,
}: {
  toasts: Array<{ id: string; msg: string; tone: 'rose' | 'amber' }>;
}) {
  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[70] space-y-2 no-print">
      <AnimatePresence>
        {toasts.map(toast => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            className={`flex items-center gap-2 rounded-xl px-4 py-2.5 shadow-xl text-[12.5px] font-bold text-white ${toast.tone === 'rose' ? 'bg-rose-500' : 'bg-amber-500'}`}
          >
            <AlertTriangle size={14} /> {toast.msg}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
