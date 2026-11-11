import { AnimatePresence, motion } from 'framer-motion';
import { Badge } from './ui';
import { ChevronDown, CheckCircle2, Search, UserPlus, UserRound } from 'lucide-react';
import POSRecentCustomers from './POSRecentCustomers';
import { fmtRs } from '../lib/utils';
import type { Customer } from '../lib/types';

export default function POSCustomerSearchPanel({
  containerRef,
  inputRef,
  query,
  open,
  results,
  recentCustomers,
  onFocus,
  onQueryChange,
  onAddNewCustomer,
  onChooseWalkIn,
  onChooseCustomer,
  onAddQueryAsCustomer,
  onSelectRecentCustomer,
}: {
  containerRef: React.Ref<HTMLDivElement>;
  inputRef: React.Ref<HTMLInputElement>;
  query: string;
  open: boolean;
  results: Customer[];
  recentCustomers: Customer[];
  onFocus: () => void;
  onQueryChange: (value: string) => void;
  onAddNewCustomer: () => void;
  onChooseWalkIn: () => void;
  onChooseCustomer: (customerId: string) => void;
  onAddQueryAsCustomer: () => void;
  onSelectRecentCustomer: (customerId: string) => void;
}) {
  return (
    <div ref={containerRef} className="relative">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
          <input
            ref={inputRef}
            className="input pl-9 pr-8 !py-2.5"
            inputMode="tel"
            autoComplete="off"
            placeholder="Search customer by name or phone... (F2)"
            value={query}
            onFocus={onFocus}
            onChange={event => onQueryChange(event.target.value)}
          />
          <ChevronDown size={13} className="absolute right-3 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
        </div>
        <button
          type="button"
          className="btn btn-soft !border-emerald-300/60 !text-emerald-600 dark:!text-emerald-400 hover:!bg-emerald-500/10 shrink-0"
          onClick={onAddNewCustomer}
        >
          <UserPlus size={15} /> <span className="hidden sm:inline">Add New Customer</span>
        </button>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.14 }}
            className="absolute left-0 right-0 top-full mt-1.5 z-30 card !rounded-xl overflow-hidden shadow-xl"
          >
            <button
              type="button"
              className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-raised/60 transition-colors border-b border-line"
              onClick={onChooseWalkIn}
            >
              <span className="w-8 h-8 rounded-full bg-raised flex items-center justify-center text-sub"><UserRound size={15} /></span>
              <span>
                <span className="block text-[13px] font-bold text-ink">Walk-in customer</span>
                <span className="block text-[10.5px] text-faint">No profile · quick sale</span>
              </span>
              <span className="ml-auto"><CheckCircle2 size={15} className="text-emerald-500" /></span>
            </button>
            <div className="max-h-56 overflow-y-auto">
              {results.map(customer => (
                <button
                  key={customer.id}
                  type="button"
                  className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-raised/60 transition-colors"
                  onClick={() => onChooseCustomer(customer.id)}
                >
                  <span className="w-8 h-8 rounded-full bg-violet-500/12 text-violet-500 flex items-center justify-center text-xs font-bold border border-violet-500/20">
                    {customer.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold text-ink truncate">{customer.name}{customer.nic ? <span className="text-faint font-normal"> · {customer.nic}</span> : ''}</span>
                    <span className="block text-[10.5px] text-faint num">{customer.phone}</span>
                  </span>
                  {customer.creditBalance > 0 && (
                    <Badge tone="rose" className="num !text-[9px] shrink-0">owes {fmtRs(customer.creditBalance, false)}</Badge>
                  )}
                  {customer.loyaltyPoints > 0 && <Badge tone="amber" className="num !text-[9px] shrink-0">{customer.loyaltyPoints} pts</Badge>}
                </button>
              ))}
              {results.length === 0 && (
                <div className="px-4 py-4 text-center">
                  <p className="text-xs text-faint">No customer found for “{query}”</p>
                  <button type="button" className="btn btn-soft !text-xs mt-2.5" onClick={onAddQueryAsCustomer}>
                    <UserPlus size={13} /> Add this number as customer
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <POSRecentCustomers customers={recentCustomers} onSelect={onSelectRecentCustomer} />
    </div>
  );
}
