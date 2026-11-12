interface POSCheckoutWhatsAppFieldProps {
  value: string;
  customerMatched: boolean;
  onChange: (value: string) => void;
}

export default function POSCheckoutWhatsAppField({
  value,
  customerMatched,
  onChange,
}: POSCheckoutWhatsAppFieldProps) {
  return (
    <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[10px] font-bold tracking-wider uppercase text-faint">WhatsApp number</span>
        {customerMatched && (
          <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
            Customer matched
          </span>
        )}
      </div>
      <input
        className="input num !py-2.5"
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder="+94 77 000 0000"
        inputMode="tel"
        autoComplete="tel"
      />
      <div className="text-[10px] text-faint mt-1">
        Enter the customer's WhatsApp number here for the receipt. Existing customers are matched automatically.
      </div>
    </div>
  );
}
