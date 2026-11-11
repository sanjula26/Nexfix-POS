import { AnimatePresence, motion } from 'framer-motion';
import { MessageCircle } from 'lucide-react';

export default function POSWhatsAppReceiptOptIn({
  visible,
  phone,
  enabled,
  onToggle,
}: {
  visible: boolean;
  phone: string;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.button
          type="button"
          initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
          onClick={onToggle}
          className={`w-full flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 transition-all text-left ${
            enabled
              ? 'bg-emerald-500/10 border-emerald-500/35'
              : 'bg-surface border-line hover:border-emerald-400/50'
          }`}
        >
          <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
            enabled ? 'bg-gradient-to-br from-[#25d366] to-[#128c7e] text-white shadow-md' : 'bg-raised text-faint'
          }`}>
            <MessageCircle size={15} />
          </span>
          <span className="flex-1 min-w-0">
            <span className={`block text-[12px] font-bold ${enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-ink'}`}>
              Send receipt on WhatsApp
            </span>
            <span className="block text-[10px] text-faint num">to {phone} — only when the customer asks</span>
          </span>
          <span className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${enabled ? 'bg-emerald-500' : 'bg-line'}`}>
            <span className={`absolute top-[2.5px] w-4 h-4 rounded-full bg-white shadow transition-all ${enabled ? 'left-[18px]' : 'left-[2px]'}`} />
          </span>
        </motion.button>
      )}
    </AnimatePresence>
  );
}
