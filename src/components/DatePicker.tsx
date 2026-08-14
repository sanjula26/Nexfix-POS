import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CalendarDays, ChevronLeft, ChevronRight, Eraser, CalendarClock, ChevronsLeft, ChevronsRight } from 'lucide-react';

export const toISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const fmtMDY = (iso: string) => {
  if (!iso) return 'mm/dd/yyyy';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WD = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

export default function DatePicker({
  value, onChange, label, alignRight,
}: {
  value: string; // yyyy-mm-dd or ''
  onChange: (iso: string) => void;
  label?: string;
  alignRight?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const base = value ? new Date(value + 'T00:00:00') : new Date();
  const [vy, setVy] = useState(base.getFullYear());
  const [vm, setVm] = useState(base.getMonth());
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const b = value ? new Date(value + 'T00:00:00') : new Date();
    setVy(b.getFullYear()); setVm(b.getMonth());
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const move = (dm: number) => {
    let m = vm + dm, y = vy;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    setVm(m); setVy(y);
  };

  const todayIso = toISO(new Date());
  const firstDow = new Date(vy, vm, 1).getDay();
  const daysInMonth = new Date(vy, vm + 1, 0).getDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(toISO(new Date(vy, vm, d)));

  const select = (iso: string) => { onChange(iso); setOpen(false); };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`input flex items-center gap-2.5 !py-2.5 text-left ${value ? 'text-ink' : 'text-faint'} ${open ? '!border-violet-400 !ring-2 !ring-violet-500/20' : ''}`}
      >
        <CalendarDays size={15} className="text-violet-500 shrink-0" />
        <span className="num text-[13px] font-semibold flex-1">{value ? fmtMDY(value) : (label || 'mm/dd/yyyy')}</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className={`absolute top-full mt-2 z-50 card !rounded-2xl p-4 w-[288px] shadow-2xl shadow-[#17133c]/20 ${alignRight ? 'right-0' : 'left-0'}`}
          >
            {/* month header */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-0.5">
                <button className="icon-btn !w-7 !h-7" onClick={() => move(-12)} title="Previous year"><ChevronsLeft size={14} /></button>
                <button className="icon-btn !w-7 !h-7" onClick={() => move(-1)} title="Previous month"><ChevronLeft size={15} /></button>
              </div>
              <div className="text-[13.5px] font-extrabold text-ink">{MONTHS[vm]} <span className="text-faint font-semibold">{vy}</span></div>
              <div className="flex items-center gap-0.5">
                <button className="icon-btn !w-7 !h-7" onClick={() => move(1)} title="Next month"><ChevronRight size={15} /></button>
                <button className="icon-btn !w-7 !h-7" onClick={() => move(12)} title="Next year"><ChevronsRight size={14} /></button>
              </div>
            </div>

            {/* weekday row */}
            <div className="grid grid-cols-7 gap-0.5 mb-1">
              {WD.map(w => <div key={w} className="text-center text-[9.5px] font-extrabold tracking-wider text-faint py-1">{w.toUpperCase()}</div>)}
            </div>

            {/* days */}
            <div className="grid grid-cols-7 gap-0.5">
              {cells.map((iso, i) => {
                if (!iso) return <span key={i} />;
                const selected = iso === value;
                const today = iso === todayIso;
                return (
                  <button
                    key={i}
                    onClick={() => select(iso)}
                    className={`h-8 rounded-lg text-[12.5px] num font-semibold transition-all ${
                      selected
                        ? 'bg-violet-600 text-white shadow-md shadow-violet-600/40'
                        : today
                          ? 'text-violet-600 dark:text-violet-400 ring-1 ring-violet-400/60 hover:bg-violet-500/10'
                          : 'text-sub hover:bg-raised hover:text-ink'
                    }`}
                  >
                    {Number(iso.slice(-2))}
                  </button>
                );
              })}
            </div>

            {/* footer */}
            <div className="flex items-center justify-between mt-3 pt-3 border-t border-line">
              <button
                className="inline-flex items-center gap-1.5 text-[11.5px] font-bold text-rose-500 hover:text-rose-600 px-2 py-1.5 rounded-lg hover:bg-rose-500/10 transition-colors"
                onClick={() => { onChange(''); setOpen(false); }}
              >
                <Eraser size={13} /> Clear
              </button>
              <div className="text-[10px] text-faint num font-medium">Selected: <b className="text-violet-500">{value || '—'}</b></div>
              <button
                className="inline-flex items-center gap-1.5 text-[11.5px] font-bold text-violet-600 dark:text-violet-400 px-2 py-1.5 rounded-lg hover:bg-violet-500/10 transition-colors"
                onClick={() => select(todayIso)}
              >
                <CalendarClock size={13} /> Today
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
