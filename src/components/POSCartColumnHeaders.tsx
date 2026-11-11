export default function POSCartColumnHeaders() {
  return (
    <div className="hidden md:grid grid-cols-[minmax(0,1fr)_92px_104px_86px_38px] gap-3 items-center px-5 sm:px-6 py-2 bg-violet-500/[0.055] border-b border-line text-[9.5px] font-extrabold uppercase tracking-wider text-faint">
      <span>Item / code · price</span>
      <span className="text-center">Qty</span>
      <span className="text-right">Discount</span>
      <span className="text-right">Amount</span>
      <span className="text-center">Action</span>
    </div>
  );
}
