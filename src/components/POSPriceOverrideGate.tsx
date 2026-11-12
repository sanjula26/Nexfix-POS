import { AlertTriangle, Eye, EyeOff, Loader2, Lock, LockKeyhole, ShieldCheck } from 'lucide-react';
import { Modal } from './ui';

interface POSPriceOverrideGateProps {
  open: boolean;
  pin: string;
  error: string;
  busy: boolean;
  showPin: boolean;
  onPinChange: (value: string) => void;
  onEnter: () => void;
  onToggleShow: () => void;
  onUnlock: () => void;
  onClose: () => void;
}

export default function POSPriceOverrideGate({
  open,
  pin,
  error,
  busy,
  showPin,
  onPinChange,
  onEnter,
  onToggleShow,
  onUnlock,
  onClose,
}: POSPriceOverrideGateProps) {
  return (
    <Modal open={open} onClose={onClose} title="Admin approval — price override" sub="Selling price changes need the admin password" locked>
      <div className="space-y-3.5">
        <div className="flex items-center gap-3 rounded-xl bg-amber-500/[0.08] border border-amber-500/25 px-3.5 py-3">
          <LockKeyhole size={16} className="text-amber-500 shrink-0" />
          <p className="text-[12px] text-sub">Enter the <b className="text-ink">admin password</b> to unlock price editing for this bill. Attempts are audit-logged.</p>
        </div>
        <div className="relative">
          <Lock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
          <input
            type={showPin ? 'text' : 'password'}
            className={`input pl-9 pr-10 !py-2.5 font-mono tracking-widest ${error ? '!border-rose-400' : ''}`}
            placeholder="••••••••"
            value={pin}
            autoFocus
            onChange={e => onPinChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') onEnter(); }}
          />
          <button type="button" onClick={onToggleShow} className="absolute right-3 top-1/2 -translate-y-1/2 text-faint hover:text-ink">
            {showPin ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        {error && <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-rose-500"><AlertTriangle size={13} /> {error}</p>}
        <div className="flex gap-2.5">
          <button className="btn btn-primary flex-1" onClick={onUnlock} disabled={!pin || busy}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />} Unlock price editing
          </button>
          <button className="btn btn-soft" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}
