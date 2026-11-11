import { AnimatePresence } from 'framer-motion';
import type { HeldSale } from '../lib/types';
import { Modal } from './ui';
import POSHeldSaleRow from './POSHeldSaleRow';

interface POSHeldSalesDialogItem {
  heldSale: HeldSale;
  heldAtLabel: string;
  customerName: string;
}

interface POSHeldSalesDialogProps {
  open: boolean;
  heldSales: POSHeldSalesDialogItem[];
  onResume: (heldSaleId: string) => void;
  onDelete: (heldSaleId: string) => void;
  onClose: () => void;
}

export default function POSHeldSalesDialog({
  open,
  heldSales,
  onResume,
  onDelete,
  onClose,
}: POSHeldSalesDialogProps) {
  return (
    <Modal open={open} onClose={onClose} title="Held sales" sub="Resume or discard parked carts">
      <div className="space-y-2.5">
        <AnimatePresence initial={false}>
          {heldSales.map(({ heldSale, heldAtLabel, customerName }) => (
            <POSHeldSaleRow
              key={heldSale.id}
              heldSale={heldSale}
              heldAtLabel={heldAtLabel}
              customerName={customerName}
              onResume={onResume}
              onDelete={onDelete}
            />
          ))}
        </AnimatePresence>
        {heldSales.length === 0 && <p className="text-sm text-sub text-center py-6">No held sales — press F5 to park the current bill</p>}
      </div>
    </Modal>
  );
}
