import { ShoppingBag } from 'lucide-react';

export default function POSCartEmptyState() {
  return (
    <div className="flex flex-col items-center py-12 text-center px-6">
      <div className="relative w-24 h-24 mb-4">
        <span className="absolute inset-0 rounded-[1.6rem] bg-gradient-to-br from-violet-500/12 to-indigo-500/12 border border-violet-500/15" />
        <span className="absolute -top-2 -right-2 w-7 h-7 rounded-full bg-amber-400/20 border border-amber-400/30" />
        <span className="absolute -bottom-1.5 -left-2.5 w-5 h-5 rounded-full bg-sky-400/20 border border-sky-400/30" />
        <span className="absolute inset-0 flex items-center justify-center text-violet-400"><ShoppingBag size={36} strokeWidth={1.5} /></span>
      </div>
      <p className="font-bold text-ink">Ready to bill</p>
      <p className="text-xs text-faint mt-1">Scan a barcode, press <b className="text-sub">F3</b> to search, or tap products below</p>
    </div>
  );
}
