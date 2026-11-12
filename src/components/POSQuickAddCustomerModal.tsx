import { UserPlus } from 'lucide-react';
import { Field, Modal } from './ui';

interface POSQuickAddCustomer {
  name: string;
  phone: string;
  nic: string;
  address: string;
}

interface POSQuickAddCustomerModalProps {
  open: boolean;
  customer: POSQuickAddCustomer;
  canAdd: boolean;
  onNameChange: (value: string) => void;
  onPhoneChange: (value: string) => void;
  onNicChange: (value: string) => void;
  onAddressChange: (value: string) => void;
  onAdd: () => void;
  onClose: () => void;
}

export default function POSQuickAddCustomerModal({
  open,
  customer,
  canAdd,
  onNameChange,
  onPhoneChange,
  onNicChange,
  onAddressChange,
  onAdd,
  onClose,
}: POSQuickAddCustomerModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Add New Customer" sub="Saved to your customer book — selected instantly">
      <div className="space-y-4">
        <Field label="Full name">
          <input className="input" value={customer.name} onChange={e => onNameChange(e.target.value)} placeholder="Customer name" autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone / WhatsApp number">
            <input className="input num" value={customer.phone} onChange={e => onPhoneChange(e.target.value)} placeholder="+94 77 000 0000" inputMode="tel" autoComplete="tel" />
          </Field>
          <Field label="NIC (optional)">
            <input className="input num" value={customer.nic} onChange={e => onNicChange(e.target.value)} placeholder="ID / NIC" />
          </Field>
        </div>
        <Field label="Address (optional)">
          <textarea
            className="input min-h-[72px] resize-none"
            value={customer.address}
            onChange={e => onAddressChange(e.target.value)}
            placeholder="Customer address"
            maxLength={240}
          />
        </Field>
        <p className="text-[11px] text-faint">New members start with 0 loyalty points and earn 1 pt per Rs. 1,000 spent.</p>
        <div className="flex gap-2.5">
          <button className="btn btn-primary flex-1" onClick={onAdd} disabled={!canAdd}>
            <UserPlus size={15} /> Add &amp; select
          </button>
          <button className="btn btn-soft" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}
