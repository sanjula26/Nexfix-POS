import { ArrowLeftRight, X } from 'lucide-react';
import type { Product } from '../lib/types';

export interface TradeInDraft {
  productId: string;
  imei: string;
  serial: string;
  value: string;
  addToInventory: boolean;
}

export default function POSTradeInEditor({
  open,
  value,
  trackedProducts,
  onOpen,
  onClose,
  onChange,
}: {
  open: boolean;
  value: TradeInDraft;
  trackedProducts: Pick<Product, 'id' | 'name' | 'trackImei' | 'trackSerial'>[];
  onOpen: () => void;
  onClose: () => void;
  onChange: (value: TradeInDraft) => void;
}) {
  if (!open) {
    return (
      <button type="button" className="text-[11.5px] font-semibold text-emerald-600 dark:text-emerald-400 hover:opacity-80 flex items-center gap-1" onClick={onOpen}>
        <ArrowLeftRight size={11} /> Add trade-in
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.05] p-2.5 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-bold text-emerald-700 dark:text-emerald-400">Trade-in device</span>
        <button type="button" className="text-faint hover:text-rose-500" onClick={onClose}><X size={11} /></button>
      </div>
      <select className="input !py-1.5 !text-[12px]" value={value.productId} onChange={event => onChange({ ...value, productId: event.target.value })}>
        <option value="">Select device/product</option>
        {trackedProducts.map(product => (
          <option key={product.id} value={product.id}>{product.name} · {product.trackImei && product.trackSerial ? 'IMEI + Serial' : product.trackImei ? 'IMEI' : 'Serial'}</option>
        ))}
      </select>
      <div className="grid grid-cols-2 gap-2">
        <input className="input !py-1.5 !text-[12px]" placeholder="IMEI" value={value.imei} onChange={event => onChange({ ...value, imei: event.target.value })} />
        <input className="input !py-1.5 !text-[12px]" placeholder="Serial" value={value.serial} onChange={event => onChange({ ...value, serial: event.target.value })} />
      </div>
      <div className="flex items-center gap-2">
        <input className="input !py-1.5 !text-[12px] num flex-1" placeholder="Trade-in value (Rs.)" value={value.value} onChange={event => onChange({ ...value, value: event.target.value.replace(/[^\d.]/g, '') })} inputMode="decimal" />
        <label className="flex items-center gap-1.5 text-[10.5px] text-sub whitespace-nowrap"><input type="checkbox" checked={value.addToInventory} onChange={event => onChange({ ...value, addToInventory: event.target.checked })} /> Add to inventory</label>
      </div>
      <div className="text-[10px] text-faint">Trade-in value is deducted from this bill. When added to inventory, the device is recorded at the trade-in value.</div>
    </div>
  );
}
