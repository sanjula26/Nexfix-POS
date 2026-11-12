import { ShieldCheck } from 'lucide-react';
import { Field, Modal } from './ui';

export interface POSReverseBillOption {
  id: string;
  label: string;
}

export interface POSReverseBillDetails {
  id: string;
  billNo: string;
  total: number;
  itemsSummary: string;
}

interface POSBillReversalModalProps {
  open: boolean;
  options: POSReverseBillOption[];
  selectedBill: POSReverseBillDetails | null;
  reason: string;
  onSelect: (id: string) => void;
  onReasonChange: (reason: string) => void;
  onRequest: () => void;
  onClose: () => void;
}

export default function POSBillReversalModal({
  open,
  options,
  selectedBill,
  reason,
  onSelect,
  onReasonChange,
  onRequest,
  onClose,
}: POSBillReversalModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Request bill reversal" sub="A cashier can request; only an admin can approve. The original sale stays in history.">
      <div className="space-y-4">
        <Field label="Recent completed bill">
          <select className="input" value={selectedBill?.id || ''} onChange={e => onSelect(e.target.value)}>
            <option value="">Select a recent bill...</option>
            {options.map(option => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </Field>
        {selectedBill && (
          <div className="rounded-xl bg-amber-500/[0.07] border border-amber-500/25 p-3 text-sm">
            <div className="font-bold text-ink">{selectedBill.billNo} · {selectedBill.total}</div>
            <div className="text-xs text-sub mt-1">{selectedBill.itemsSummary}</div>
          </div>
        )}
        <Field label="Reason">
          <textarea className="input min-h-[82px] resize-none" value={reason} onChange={e => onReasonChange(e.target.value)} placeholder="Enter the reason for reversing this bill..." maxLength={240} />
        </Field>
        <div className="rounded-xl bg-raised border border-line px-3 py-2.5 text-[11px] text-sub">Admin approval will restore stock and mark the bill as <b className="text-ink">REVERSED</b>. No sale history is deleted.</div>
        <div className="flex gap-2.5">
          <button className="btn btn-danger-soft flex-1" disabled={!selectedBill || !reason.trim()} onClick={onRequest}><ShieldCheck size={15} /> Request approval</button>
          <button className="btn btn-soft flex-1" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}
