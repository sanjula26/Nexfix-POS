import { AnimatePresence, motion } from 'framer-motion';
import { Smartphone } from 'lucide-react';
import { fmtRs } from '../lib/utils';
import type { InventoryUnit, Product } from '../lib/types';

type ItemSuggestion = {
  product: Product;
  Icon: React.ElementType;
  inCart: number;
};

type UnitSuggestion = {
  unit: InventoryUnit;
  productName: string;
};

export default function POSItemSearchSuggestions({
  visible,
  unitSuggestion,
  items,
  onAddUnit,
  onAddProduct,
}: {
  visible: boolean;
  unitSuggestion?: UnitSuggestion;
  items: ItemSuggestion[];
  onAddUnit: (unit: InventoryUnit) => void;
  onAddProduct: (productId: string) => void;
}) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
          className="absolute left-0 right-0 top-full mt-1.5 z-40 card !rounded-xl overflow-hidden shadow-2xl"
        >
          {unitSuggestion && (
            <button type="button" className="w-full flex items-center gap-3 px-3.5 py-2.5 text-left bg-amber-500/[0.06] hover:bg-amber-500/[0.1] border-b border-line"
              onMouseDown={event => event.preventDefault()}
              onClick={() => onAddUnit(unitSuggestion.unit)}>
              <span className="w-8 h-8 rounded-lg bg-amber-500/10 text-amber-600 flex items-center justify-center shrink-0"><Smartphone size={14} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-bold text-ink truncate">{unitSuggestion.productName} · IMEI / Serial</span>
                <span className="block text-[10px] text-faint num">{unitSuggestion.unit.imei || unitSuggestion.unit.serial} · Unit available</span>
              </span>
              <span className="text-[10px] font-extrabold text-amber-600">ADD UNIT</span>
            </button>
          )}
          {items.map(({ product, Icon, inCart }) => (
            <button
              key={product.id}
              type="button"
              className="w-full flex items-center gap-3 px-3.5 py-2.5 text-left hover:bg-raised/70 border-b border-line last:border-b-0"
              onMouseDown={event => event.preventDefault()}
              onClick={() => onAddProduct(product.id)}
            >
              <span className="w-8 h-8 rounded-lg bg-violet-500/10 text-violet-500 flex items-center justify-center shrink-0"><Icon size={14} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-bold text-ink truncate">{product.name}</span>
                <span className="block text-[10px] text-faint num">{product.sku} · {product.barcode || 'No barcode'} · {product.stock} in stock</span>
              </span>
              {inCart > 0 && <span className="num text-[10px] font-bold text-violet-500">×{inCart}</span>}
              <span className="num text-[12px] font-extrabold text-violet-600 dark:text-violet-400">{fmtRs(product.price, false)}</span>
            </button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
