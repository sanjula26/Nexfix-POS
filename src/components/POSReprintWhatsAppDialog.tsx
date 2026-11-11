import { MessageCircle } from 'lucide-react';
import { Modal } from './ui';

export default function POSReprintWhatsAppDialog({
  open,
  billNo,
  phone,
  canSubmit,
  onPhoneChange,
  onConfirm,
  onClose,
}: {
  open: boolean;
  billNo: string;
  phone: string;
  canSubmit: boolean;
  onPhoneChange: (value: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Send reprint via WhatsApp" sub={billNo}>
      <div className="space-y-4">
        <div className="text-sm text-sub">
          Enter the customer's WhatsApp number. The bill message will be prepared for this number in WhatsApp.
        </div>
        <input
          className="input w-full"
          type="tel"
          inputMode="tel"
          autoFocus
          value={phone}
          onChange={e => onPhoneChange(e.target.value)}
          placeholder="e.g. 0771234567 or +94771234567"
          onKeyDown={e => { if (e.key === 'Enter') onConfirm(); }}
        />
        <div className="rounded-xl bg-raised border border-line p-3 text-[11px] text-faint">
          WhatsApp will open with the selected bill and number. Press <b className="text-ink">Send</b> in WhatsApp to deliver it.
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn btn-soft flex-1" onClick={onClose}>Cancel</button>
          <button type="button" className="btn !text-white flex-1" disabled={!canSubmit} onClick={onConfirm} style={{ background: 'linear-gradient(135deg,#25d366,#128c7e)' }}>
            <MessageCircle size={15} /> Open WhatsApp
          </button>
        </div>
      </div>
    </Modal>
  );
}
