import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Search, X, Inbox } from 'lucide-react';

/* ---------- Modal ---------- */
export function Modal({
  open, onClose, title, sub, children, footer, wide, xl, locked,
}: {
  open: boolean; onClose: () => void; title: string; sub?: string;
  children: React.ReactNode; footer?: React.ReactNode; wide?: boolean; xl?: boolean;
  /** locked: backdrop does not dismiss (header close stays available) */
  locked?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  if (!open) return null;

  const dialog = (
    <div className="fixed inset-0 z-[60]">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={locked ? undefined : onClose}
      />

      <div className="absolute inset-0 flex items-start sm:items-center justify-center overflow-y-auto p-4">
        <div
          className={`relative z-10 flex w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-xl ${xl ? 'max-w-4xl' : wide ? 'max-w-2xl' : 'max-w-lg'}`}
          style={{ maxHeight: 'min(90vh, 860px)' }}
          role="dialog"
          aria-modal="true"
        >
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div>
              <h3 className="text-lg font-bold text-ink">{title}</h3>
              {sub ? <p className="mt-0.5 text-xs text-sub">{sub}</p> : null}
            </div>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <X size={17} />
            </button>
          </div>

          <div className="overflow-y-auto px-5 py-4"
            style={{ maxHeight: 'calc(min(90vh, 860px) - 9rem)' }}>
            {children}
          </div>

          {footer ? (
            <div className="shrink-0 border-t border-line bg-surface px-5 py-3">
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}

/* ---------- Field ---------- */
export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-bold tracking-wider uppercase text-sub mb-1.5">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-faint mt-1">{hint}</span>}
    </label>
  );
}

/* ---------- Search input ---------- */
export function SearchInput({
  value, onChange, placeholder, className = '', autoFocus,
}: {
  value: string; onChange: (v: string) => void; placeholder?: string; className?: string; autoFocus?: boolean;
}) {
  return (
    <div className={`relative ${className}`}>
      <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
      <input
        className="input pl-9"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder || 'Search...'}
        autoFocus={autoFocus}
      />
    </div>
  );
}

/* ---------- Badge ---------- */
const badgeTones: Record<string, string> = {
  violet: 'bg-violet-500/10 text-violet-500 border border-violet-500/20',
  emerald: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20',
  amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/25',
  rose: 'bg-rose-500/10 text-rose-500 border border-rose-500/20',
  blue: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/20',
  slate: 'bg-raised text-sub border border-line',
};

export function Badge({ tone = 'slate', children, className = '' }: {
  tone?: keyof typeof badgeTones; children: React.ReactNode; className?: string;
}) {
  return <span className={`badge ${badgeTones[tone]} ${className}`}>{children}</span>;
}

export const ACTION_TONE: Record<string, keyof typeof badgeTones> = {
  CREATE: 'emerald', UPDATE: 'blue', DELETE: 'rose', SALE: 'violet', LOGIN: 'slate',
  LOGOUT: 'slate', REFUND: 'rose', EXCHANGE: 'amber', STOCK: 'blue', RECEIVE: 'emerald',
  EXPENSE: 'amber', SETTINGS: 'slate', PERMISSION: 'violet', SWITCH: 'blue', IMPORT: 'blue',
  'DAY-CLOSE': 'emerald',
};

/* ---------- Empty state ---------- */
export function EmptyState({ icon, title, sub }: { icon?: React.ReactNode; title: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-14 text-center">
      <div className="w-16 h-16 rounded-2xl bg-raised flex items-center justify-center text-faint mb-4">
        {icon || <Inbox size={26} />}
      </div>
      <p className="font-semibold text-ink">{title}</p>
      {sub && <p className="text-sm text-faint mt-1">{sub}</p>}
    </div>
  );
}

/* ---------- Toggle ---------- */
export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-[22px] rounded-full transition-colors duration-200 ${
        checked ? 'bg-violet-600' : 'bg-line'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span
        className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-all duration-200 ${
          checked ? 'left-[21px]' : 'left-[3px]'
        }`}
      />
    </button>
  );
}

/* ---------- Section header for pages ---------- */
export function PageHeading({ chip, chipTone = 'violet', title, sub, actions }: {
  chip?: string; chipTone?: keyof typeof badgeTones; title: string; sub?: string; actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
      <div>
        {chip && <Badge tone={chipTone} className="uppercase mb-2">{chip}</Badge>}
        <h1 className="text-[26px] sm:text-3xl font-extrabold text-ink tracking-tight leading-tight">{title}</h1>
        {sub && <p className="text-sm text-sub mt-1">{sub}</p>}
      </div>
      {actions && <div className="flex items-center gap-2.5 flex-wrap">{actions}</div>}
    </div>
  );
}

/* ---------- Avatar ---------- */
const avatarTints = [
  'from-violet-500 to-indigo-500', 'from-emerald-500 to-teal-500', 'from-amber-500 to-orange-500',
  'from-sky-500 to-blue-600', 'from-rose-500 to-pink-600', 'from-fuchsia-500 to-purple-600',
];
export function Avatar({ name, size = 34 }: { name: string; size?: number }) {
  const idx = (name.charCodeAt(0) + name.length) % avatarTints.length;
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full bg-gradient-to-br ${avatarTints[idx]} text-white font-bold shrink-0`}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
