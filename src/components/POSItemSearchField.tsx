import { Search } from 'lucide-react';
import { SearchInput } from './ui';

export default function POSItemSearchField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative">
      <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-violet-500 pointer-events-none" />
      <SearchInput
        value={value}
        onChange={onChange}
        placeholder="Scan barcode, SKU, name or IMEI…"
        className="w-full !pl-11 !pr-4 !py-3.5 !text-[15px] !rounded-xl !border-violet-300/70 dark:!border-violet-500/30 !bg-surface shadow-[0_8px_28px_-16px_rgba(124,58,237,.5)]"
      />
    </div>
  );
}
