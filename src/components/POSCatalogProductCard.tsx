import { motion } from 'framer-motion';
import type { ElementType } from 'react';
import type { Product } from '../lib/types';
import { fmtRs } from '../lib/utils';
import { Badge } from './ui';

export default function POSCatalogProductCard({
  product,
  icon: Icon,
  tint,
  inCart,
  onAdd,
}: {
  product: Product;
  icon: ElementType;
  tint: string;
  inCart: number;
  onAdd: () => void;
}) {
  const out = product.stock === 0;
  const low = !out && product.stock <= product.reorderLevel;

  return (
    <motion.button
      layout
      whileTap={{ scale: 0.97 }}
      disabled={out || inCart >= product.stock}
      onClick={onAdd}
      className={`relative text-left rounded-xl border p-3 transition-all group ${out ? 'bg-rose-500/[0.04] border-rose-300/60 opacity-70 cursor-not-allowed' : low ? 'bg-surface border-rose-300/80 dark:border-rose-500/40 hover:border-rose-400 hover:shadow-md cursor-pointer' : 'bg-surface border-line hover:border-violet-400 hover:shadow-lg hover:shadow-violet-500/10 cursor-pointer'}`}
    >
      <div className="flex items-start justify-between gap-1.5">
        <span className={`w-8 h-8 rounded-lg bg-gradient-to-br ${tint} text-white flex items-center justify-center shadow-sm shrink-0`}>
          <Icon size={14} strokeWidth={2.1} />
        </span>
        <Badge tone={out || low ? 'rose' : 'emerald'} className={`num !text-[9.5px] !px-1.5 !py-0.5 ${low ? 'blink' : ''}`}>
          {out ? 'OUT' : low ? `${product.stock} LOW` : product.stock}
        </Badge>
      </div>
      <div className={`mt-2.5 text-[12px] font-bold leading-snug line-clamp-2 min-h-[30px] ${out ? 'text-sub line-through' : 'text-ink'}`}>
        {product.name}
      </div>
      <div className="text-[10px] text-faint mt-0.5 num">{product.sku}</div>
      <div className="flex items-center justify-between mt-1.5">
        <span className="num text-[13.5px] font-extrabold text-violet-600 dark:text-violet-400">{fmtRs(product.price, false)}</span>
        {inCart > 0 && <span className="min-w-5 px-1 h-5 rounded-full bg-violet-600 text-white text-[10px] font-bold flex items-center justify-center num">{inCart}</span>}
      </div>
    </motion.button>
  );
}
