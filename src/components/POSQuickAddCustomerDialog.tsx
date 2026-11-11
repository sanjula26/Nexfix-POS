import { UserPlus } from 'lucide-react';
import { Field, Modal } from './ui';

export interface POSQuickAddCustomerDraft {
  name: string;
  phone: string;
  nic: string;
  address: string;
}

interface POSQuickAddCustomerDialogProps {
  open: boolean;
  customer: POSQuickAddCustomerDraft;
  onChange: (field: keyof POSQuickAddCustomerDraft, value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export default function POSQuickAddCustomerDialog({
  open,
  customer,
  onChange,
  onSubmit,
  onClose,
}: POSQuickAddCustomerDialogProps) {
  return (
    <Modal open={open} onClose={onClose} title="Add New Customer" sub="Saved to your customer book — selected instantly">
      <div className="space-y-4">
        <Field label="Full name">
          <input className="input" value={customer.name} onChange={e => onChange('name', e.target.value)} placeholder="Customer name" autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone / WhatsApp number">
            <input className="input num" value={customer.phone} onChange={e => onChange('phone', e.target.value)} placeholder="+94 77 000 0000" inputMode="tel" autoComplete="tel" />
          </Field>
          <Field label="NIC (optional)">
            <input className="input num" value={customer.nic} onChange={e => onChange('nic', e.target.value)} placeholder="ID / NIC" />
          </Field>
        </div>
        <Field label="Address (optional)">
          <textarea
            className="input min-h-[72px] resize-none"
            value={customer.address}
            onChange={e => onChange('address', e.target.value)}
            placeholder="Customer address"
            maxLength={240}
          />
        </Field>
        <p className="text-[11px] text-faint">New members start with 0 loyalty points and earn 1 pt per Rs. 1,000 spent.</p>
        <div className="flex gap-2.5">
          <button type="button" className="btn btn-primary flex-1" onClick={onSubmit} disabled={!customer.name.trim() || !customer.phone.trim()}>
            <UserPlus size={15} /> Add &amp; select
          </button>
          <button type="button" className="btn btn-soft" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}
