export default function POSCashAmountPresets({
  amounts,
  onExact,
}: {
  amounts: Array<{ value: number; label: string; onSelect: () => void }>;
  onExact: () => void;
}) {
  return (
    <div className="flex gap-1.5 mt-2">
      {amounts.map(amount => (
        <button
          key={amount.value}
          type="button"
          className="btn btn-soft !px-2 !py-1 !text-[11px] flex-1 num"
          onClick={amount.onSelect}
        >
          {amount.label}
        </button>
      ))}
      <button
        type="button"
        className="btn btn-soft !px-2 !py-1 !text-[11px] flex-1 text-violet-500 font-bold"
        onClick={onExact}
      >
        Exact
      </button>
    </div>
  );
}
