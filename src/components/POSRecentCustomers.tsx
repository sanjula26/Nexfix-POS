import type { Customer } from '../lib/types';

export default function POSRecentCustomers({
  customers,
  onSelect,
}: {
  customers: Customer[];
  onSelect: (customerId: string) => void;
}) {
  if (customers.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
      <span className="text-[9.5px] font-bold tracking-wider uppercase text-faint">Recent</span>
      {customers.map(customer => (
        <button
          key={customer.id}
          type="button"
          onClick={() => onSelect(customer.id)}
          className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-sub bg-raised border border-line rounded-full pl-0.5 pr-2.5 py-0.5 hover:border-violet-400 hover:text-violet-500 transition-colors"
        >
          <span className="w-[18px] h-[18px] rounded-full bg-violet-500/15 text-violet-500 flex items-center justify-center text-[9px] font-bold">
            {customer.name.charAt(0).toUpperCase()}
          </span>
          {customer.name.split(' ')[0]}
        </button>
      ))}
    </div>
  );
}
