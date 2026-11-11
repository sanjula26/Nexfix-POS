import { ShieldCheck } from 'lucide-react';
import { Field, Modal } from './ui';
import { fmtRs } from '../lib/utils';
import type { Sale } from '../lib/types';

export default function POSBillReversalDialog({
  open,
  sales,
  selectedSale,
  reason,
  onSaleChange,
  onReasonChange,
  onRequest,
  onClose,
}: {
  open: boolean;
  sales: Sale[];
  selectedSale: Sale | null;
  reason: string;
  onSaleChange: (saleId: string) => void;
  onReasonChange: (value: string) => void;
  onRequest: () => void;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Request bill reversal" sub="A cashier can request; only an admin can approve. The original sale stays in history.">
      <div className="space-y-4">
        <Field label="Recent completed bill">
          <select className="input" value={selectedSale?.id || ''} onChange={event => onSaleChange(event.target.value)}>
            <option value="">Select a recent bill...</option>
            {sales.map(sale => (
              <option key={sale.id} value={sale.id}>{sale.billNo} · {sale.customerName} · {fmtRs(sale.total)}</option>
            ))}
          </select>
        </Field>
        {selectedSale && (
          <div className="rounded-xl bg-amber-500/[0.07] border border-amber-500/25 p-3 text-sm">
            <div className="font-bold text-ink">{selectedSale.billNo} · {fmtRs(selectedSale.total)}</div>
            <div className="text-xs text-sub mt-1">{selectedSale.items.map(item => item.name + ' ×' + item.qty).join(' · ')}</div>
          </div>
        )}
        <Field label="Reason">
          <textarea className="input min-h-[82px] resize-none" value={reason} onChange={event => onReasonChange(event.target.value)} placeholder="Enter the reason for reversing this bill..." maxLength={240} />
        </Field>
        <div className="rounded-xl bg-raised border border-line px-3 py-2.5 text-[11px] text-sub">Admin approval will restore stock and mark the bill as <b className="text-ink">REVERSED</b>. No sale history is deleted.</div>
        <div className="flex gap-2.5">
          <button type="button" className="btn btn-danger-soft flex-1" disabled={!selectedSale || !reason.trim()} onClick={onRequest}>
            <ShieldCheck size={15} /> Request approval
          </button>
          <button type="button" className="btn btn-soft flex-1" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}
