import { Boxes, ChevronDown, Grid3X3 } from 'lucide-react';
import type { ElementType } from 'react';
import type { Product } from '../lib/types';
import POSCatalogProductCard from './POSCatalogProductCard';

type CatalogItem = {
  product: Product;
  icon: ElementType;
  tint: string;
  inCart: number;
};

export default function POSProductCatalogBrowser({
  categories,
  selectedCategory,
  items,
  totalProducts,
  onCategoryChange,
  onAdd,
}: {
  categories: string[];
  selectedCategory: string;
  items: CatalogItem[];
  totalProducts: number;
  onCategoryChange: (category: string) => void;
  onAdd: (productId: string) => void;
}) {
  return (
    <details className="group">
      <summary className="list-none cursor-pointer flex items-center justify-between gap-3 rounded-xl border border-line bg-raised/45 px-3.5 py-3 hover:border-violet-300 transition-colors">
        <span className="flex items-center gap-2.5">
          <span className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white flex items-center justify-center shadow-md shadow-violet-600/25">
            <Grid3X3 size={16} />
          </span>
          <span>
            <span className="block font-display font-extrabold text-ink text-[14px]">Product Catalog</span>
            <span className="block text-[10.5px] text-faint num">{items.length} of {totalProducts} items · optional browse mode</span>
          </span>
        </span>
        <ChevronDown size={17} className="text-faint transition-transform group-open:rotate-180" />
      </summary>

      <div className="pt-3">
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {categories.map(category => (
            <button
              key={category}
              type="button"
              onClick={() => onCategoryChange(category)}
              className={`px-3 py-1.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap transition-all border ${selectedCategory === category ? 'bg-violet-600 text-white border-violet-600 shadow-md shadow-violet-600/30' : 'bg-raised text-sub border-line hover:text-ink'}`}
            >
              {category === 'all' ? 'All' : category}
            </button>
          ))}
        </div>

        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <span className="w-14 h-14 rounded-2xl bg-raised flex items-center justify-center text-faint mb-3"><Boxes size={24} /></span>
            <p className="font-semibold text-ink text-sm">No products found</p>
            <p className="text-xs text-faint mt-1">Use the main item search above or choose another category</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-2.5 mt-3">
            {items.map(({ product, icon, tint, inCart }) => (
              <POSCatalogProductCard
                key={product.id}
                product={product}
                icon={icon}
                tint={tint}
                inCart={inCart}
                onAdd={() => onAdd(product.id)}
              />
            ))}
          </div>
        )}
      </div>
    </details>
  );
}
