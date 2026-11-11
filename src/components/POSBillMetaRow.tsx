import { AnimatePresence, motion } from 'framer-motion';
import { StickyNote } from 'lucide-react';
import type { AppUser } from '../lib/types';

export default function POSBillMetaRow({
  staff,
  salesmanId,
  noteOpen,
  note,
  onSalesmanChange,
  onToggleNote,
  onNoteChange,
}: {
  staff: AppUser[];
  salesmanId: string;
  noteOpen: boolean;
  note: string;
  onSalesmanChange: (id: string) => void;
  onToggleNote: () => void;
  onNoteChange: (value: string) => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <span className="flex items-center gap-1.5 text-[10px] font-bold tracking-wider uppercase text-faint">
          Salesman
        </span>
        <select
          className="input !w-auto !py-1.5 !px-2.5 !text-[12px] font-semibold"
          value={salesmanId}
          onChange={e => onSalesmanChange(e.target.value)}
        >
          {staff.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
        </select>
        <button
          className={`ml-auto inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1.5 rounded-lg border transition-all ${
            noteOpen || note ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30' : 'bg-raised text-sub border-line hover:text-ink'
          }`}
          onClick={onToggleNote}
        >
          <StickyNote size={12} /> {note ? 'Note added' : 'Bill note'}
        </button>
      </div>
      <AnimatePresence>
        {noteOpen && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <textarea
              className="input mt-2.5 !text-[12.5px] min-h-[56px] resize-none"
              placeholder="e.g. Gift packing · Deliver tomorrow after 4 PM"
              value={note}
              onChange={e => onNoteChange(e.target.value)}
              maxLength={160}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
