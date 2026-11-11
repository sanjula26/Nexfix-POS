import type { InventoryUnit } from '../lib/types';
import { Modal } from './ui';

export default function POSImeiUnitPickerDialog({
  open, productName, search, units, onSearchChange, onSelect, onClose,
}: {
  open: boolean;
  productName?: string;
  search: string;
  units: InventoryUnit[];
  onSearchChange: (value: string) => void;
  onSelect: (unitId: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Select unit (IMEI / Serial)" sub={productName}>
      <div className="space-y-3">
        <input className="input" autoFocus placeholder="Scan or type IMEI / serialâ€¦" value={search} onChange={e => onSearchChange(e.target.value)} />
        {units.length === 0 ? (
          <p className="text-sm text-faint py-4 text-center">
            No available units. Add them under <b>IMEI / Serial</b> first.
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto space-y-1.5">
            {units.map(unit => (
              <button key={unit.id} type="button" className="w-full text-left rounded-xl border border-line px-3 py-2.5 hover:bg-raised transition-colors" onClick={() => onSelect(unit.id)}>
                <div className="font-semibold text-ink text-[13px] num">{unit.imei || unit.serial || unit.id}</div>
                <div className="text-[11px] text-faint">
                  {unit.imei && unit.serial ? 'Serial: ' + unit.serial : ''}
                  {unit.expiryDate ? ' · Exp ' + unit.expiryDate.slice(0, 10) : ''}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
