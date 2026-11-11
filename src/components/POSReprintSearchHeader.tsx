import { SearchInput } from './ui';

export default function POSReprintSearchHeader({
  value,
  resultCount,
  onChange,
}: {
  value: string;
  resultCount: number;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SearchInput
        value={value}
        onChange={onChange}
        placeholder="Find bill #, customer, cashier or WhatsApp number…"
        className="flex-1 min-w-[240px]"
      />
      <span className="text-[11px] text-faint num">{resultCount} shown</span>
    </div>
  );
}
