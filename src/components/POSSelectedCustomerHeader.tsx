import { Coins, X } from 'lucide-react';
import { Badge } from './ui';
import type { Customer } from '../lib/types';

export default function POSSelectedCustomerHeader({
  customer,
  onChangeCustomer,
}: {
  customer: Customer;
  onChangeCustomer: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-10 h-10 rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 text-white flex items-center justify-center font-bold shrink-0">
        {customer.name.charAt(0).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-bold text-ink truncate">{customer.name}</div>
        <div className="text-[11px] text-sub num">{customer.phone}</div>
      </div>
      <Badge tone="amber" className="num shrink-0"><Coins size={11} /> {customer.loyaltyPoints} pts</Badge>
      <button className="icon-btn !w-7 !h-7" onClick={onChangeCustomer} title="Change customer">
        <X size={13} />
      </button>
    </div>
  );
}
