import { X } from 'lucide-react';
import { fmtRs } from '../lib/utils';
import { Modal } from './ui';

export default function POSCashDrawerDialog({
  open,
  userName,
  openingFloat,
  myCash,
  expected,
  onClose,
}: {
  open: boolean;
  userName: string;
  openingFloat: number;
  myCash: number;
  expected: number;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Cash drawer" sub={`Today · ${userName}`}>
      <div className="space-y-3">
        {[
          { label: 'Opening float', value: openingFloat, tone: 'text-ink' },
          { label: 'My cash sales today', value: myCash, tone: 'text-emerald-500' },
          { label: 'Expected in drawer', value: expected, tone: 'text-violet-500' },
        ].map(row => (
          <div key={row.label} className="flex justify-between items-center rounded-xl bg-raised border border-line px-4 py-3">
            <span className="text-sm text-sub">{row.label}</span>
            <span className={`num font-bold ${row.tone}`}>{fmtRs(row.value)}</span>
          </div>
        ))}
        <p className="text-[11px] text-faint">Drawer is settled at day end under Cashier Balances (admin only).</p>
        <button type="button" className="btn btn-soft w-full" onClick={onClose}><X size={15} /> Close</button>
      </div>
    </Modal>
  );
}
