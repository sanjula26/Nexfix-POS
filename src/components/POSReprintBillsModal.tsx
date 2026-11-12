import { MessageCircle, Printer } from 'lucide-react';
import { Modal, SearchInput } from './ui';

export interface POSReprintBillItem {
  id: string;
  billNo: string;
  ago: string;
  customerName: string;
  itemCount: number;
  totalLabel: string;
  hasCustomerPhone: boolean;
}

interface POSReprintBillsModalProps {
  open: boolean;
  todayBillCount: number;
  search: string;
  shownCount: number;
  items: POSReprintBillItem[];
  onSearchChange: (value: string) => void;
  onPrint: (id: string) => void;
  onWhatsApp: (id: string) => void;
  onClose: () => void;
}

export default function POSReprintBillsModal({
  open,
  todayBillCount,
  search,
  shownCount,
  items,
  onSearchChange,
  onPrint,
  onWhatsApp,
  onClose,
}: POSReprintBillsModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Reprint today's bills" sub={`${todayBillCount} bill${todayBillCount === 1 ? '' : 's'} · newest first`} wide>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput value={search} onChange={onSearchChange} placeholder="Find bill #, customer, cashier or WhatsApp number…" className="flex-1 min-w-[240px]" />
          <span className="text-[11px] text-faint num">{shownCount} shown</span>
        </div>
        <div className="space-y-2 max-h-[58vh] overflow-y-auto pr-1">
          {items.map((sale, index) => (
            <div key={sale.id} className="rounded-xl border border-line bg-raised/40 p-3 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="w-8 h-8 rounded-lg bg-violet-500/10 text-violet-600 flex items-center justify-center text-[11px] font-extrabold num">{index + 1}</div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-extrabold text-violet-600">{sale.billNo}</span><span className="text-[11px] text-faint">{sale.ago}</span></div>
                  <div className="text-[11px] text-sub truncate">{sale.customerName || 'Walk-in customer'} · {sale.itemCount} item{sale.itemCount === 1 ? '' : 's'}</div>
                  <div className="text-sm font-extrabold text-ink num mt-0.5">{sale.totalLabel}</div>
                </div>
              </div>
              <div className="flex gap-1.5 shrink-0">
                <button type="button" className="btn btn-primary !py-2 !px-3 !text-xs" onClick={() => onPrint(sale.id)}><Printer size={13} /> Print</button>
                <button type="button" className="btn !py-2 !px-3 !text-xs !text-white" style={{ background: 'linear-gradient(135deg,#25d366,#128c7e)' }} onClick={() => onWhatsApp(sale.id)}><MessageCircle size={13} /> WhatsApp</button>
                {!sale.hasCustomerPhone && <span className="self-center text-[10px] text-faint">number will be requested</span>}
              </div>
            </div>
          ))}
          {items.length === 0 && <div className="py-8 text-center text-sm text-faint">No bill matched “{search}”.</div>}
        </div>
      </div>
    </Modal>
  );
}
