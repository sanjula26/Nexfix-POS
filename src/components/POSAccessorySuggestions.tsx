import { Sparkles } from 'lucide-react';
import { fmtRs } from '../lib/utils';

interface POSAccessorySuggestion {
  id: string;
  name: string;
  price: number;
  stock: number;
}

interface POSAccessorySuggestionsProps {
  items: POSAccessorySuggestion[];
  onAdd: (productId: string) => void;
}

export default function POSAccessorySuggestions({ items, onAdd }: POSAccessorySuggestionsProps) {
  if (items.length === 0) return null;

  return (
    <div className="px-5 sm:px-6 py-3 border-t border-line bg-emerald-500/[0.035]">
      <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-wider text-sub mb-2">
        <Sparkles size={12} className="text-emerald-600" /> Helpful accessories in stock
      </div>
      <div className="flex flex-wrap gap-2">
        {items.map(product => (
          <button
            key={product.id}
            type="button"
            onClick={() => onAdd(product.id)}
            className="min-w-0 max-w-full rounded-lg border border-line bg-surface px-3 py-2 text-left hover:border-emerald-500/50 transition-colors"
          >
            <span className="block text-xs font-semibold truncate">{product.name}</span>
            <span className="block text-[10px] text-sub mt-0.5">{fmtRs(product.price, false)} · stock {product.stock}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
