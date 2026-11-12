import { X } from 'lucide-react';
import { Modal } from './ui';

interface POSCashDrawerModalProps {
  open: boolean;
  sub: string;
  rows: { label: string; value: string; tone: string }[];
  onClose: () => void;
}

export default function POSCashDrawerModal({ open, sub, rows, onClose }: POSCashDrawerModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Cash drawer" sub={sub}>
      <div className="space-y-3">
        {rows.map(row => (
          <div key={row.label} className="flex justify-between items-center rounded-xl bg-raised border border-line px-4 py-3">
            <span className="text-sm text-sub">{row.label}</span>
            <span className={`num font-bold ${row.tone}`}>{row.value}</span>
          </div>
        ))}
        <p className="text-[11px] text-faint">Drawer is settled at day end under Cashier Balances (admin only).</p>
        <button className="btn btn-soft w-full" onClick={onClose}><X size={15} /> Close</button>
      </div>
    </Modal>
  );
}
