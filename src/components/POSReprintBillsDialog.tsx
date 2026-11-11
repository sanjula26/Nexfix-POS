import type { Sale } from '../lib/types';
import { Modal } from './ui';
import POSReprintBillRow from './POSReprintBillRow';
import POSReprintSearchHeader from './POSReprintSearchHeader';

interface POSReprintBillsDialogItem {
  sale: Sale;
  index: number;
  customerPhone: string;
}

interface POSReprintBillsDialogProps {
  open: boolean;
  todayBillCount: number;
  search: string;
  resultCount: number;
  bills: POSReprintBillsDialogItem[];
  onSearchChange: (value: string) => void;
  onPrint: (sale: Sale) => void;
  onWhatsApp: (sale: Sale) => void;
  onClose: () => void;
}

export default function POSReprintBillsDialog({
  open,
  todayBillCount,
  search,
  resultCount,
  bills,
  onSearchChange,
  onPrint,
  onWhatsApp,
  onClose,
}: POSReprintBillsDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Reprint today's bills"
      sub={`${todayBillCount} bill${todayBillCount === 1 ? '' : 's'} · newest first`}
      wide
    >
      <div className="space-y-3">
        <POSReprintSearchHeader value={search} resultCount={resultCount} onChange={onSearchChange} />
        <div className="space-y-2 max-h-[58vh] overflow-y-auto pr-1">
          {bills.map(({ sale, index, customerPhone }) => (
            <POSReprintBillRow
              key={sale.id}
              sale={sale}
              index={index}
              customerPhone={customerPhone}
              onPrint={() => onPrint(sale)}
              onWhatsApp={() => onWhatsApp(sale)}
            />
          ))}
          {bills.length === 0 && <div className="py-8 text-center text-sm text-faint">No bill matched “{search}”.</div>}
        </div>
      </div>
    </Modal>
  );
}
