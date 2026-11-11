import { Keyboard } from 'lucide-react';

export default function POSItemSearchHeading() {
  return (
    <div className="flex items-center justify-between mb-2">
      <div>
        <div className="text-[10px] font-extrabold tracking-[0.14em] uppercase text-violet-500">Add item</div>
        <div className="text-[12px] font-semibold text-sub">Fast barcode / SKU / product / IMEI search</div>
      </div>
      <span className="hidden sm:inline-flex items-center gap-1 rounded-lg bg-raised border border-line px-2 py-1 text-[9.5px] font-bold text-faint">
        <Keyboard size={10} /> F3
      </span>
    </div>
  );
}
