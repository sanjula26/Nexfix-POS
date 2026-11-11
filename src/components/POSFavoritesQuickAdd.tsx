import type { ElementType } from 'react';
import { Star } from 'lucide-react';
import { fmtRs } from '../lib/utils';

type FavoriteQuickAddItem = {
  id: string;
  name: string;
  price: number;
  stock: number;
  quantityInCart: number;
  Icon: ElementType;
  tint: string;
};

export default function POSFavoritesQuickAdd({
  items,
  onAdd,
}: {
  items: FavoriteQuickAddItem[];
  onAdd: (productId: string) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div className="mb-4">
      <span className="flex items-center gap-1.5 text-[10px] font-extrabold tracking-[0.14em] text-faint uppercase mb-2">
        <Star size={11} className="text-amber-500" /> Quick add · frequently sold
      </span>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {items.map(item => (
          <button key={item.id} onClick={() => onAdd(item.id)} disabled={item.quantityInCart >= item.stock}
            className="flex items-center gap-2 rounded-xl border border-line bg-surface pl-1.5 pr-3 py-1.5 hover:border-violet-400 hover:shadow-md transition-all shrink-0 disabled:opacity-50">
            <span className={`w-7 h-7 rounded-lg bg-gradient-to-br ${item.tint} text-white flex items-center justify-center`}><item.Icon size={13} /></span>
            <span className="text-left">
              <span className="block text-[11px] font-bold text-ink leading-tight max-w-[130px] truncate">{item.name}</span>
              <span className="block text-[10px] text-violet-500 font-bold num">{fmtRs(item.price, false)}</span>
            </span>
            {item.quantityInCart > 0 && <span className="min-w-4.5 w-[18px] h-[18px] rounded-full bg-violet-600 text-white text-[9px] font-bold flex items-center justify-center num">{item.quantityInCart}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
