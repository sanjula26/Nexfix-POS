export default function POSAmountPaidField({
  label,
  value,
  onChange,
  onEnter,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
}) {
  return (
    <>
      <span className="block text-[10px] font-bold tracking-wider uppercase text-faint mb-1.5">{label}</span>
      <input
        className="input num !text-xl !font-extrabold !py-2.5 text-right"
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder="0.00" inputMode="decimal"
        onKeyDown={event => { if (event.key === 'Enter') onEnter(); }}
      />
    </>
  );
}
