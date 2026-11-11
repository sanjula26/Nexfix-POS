import { MessageCircle, Printer } from 'lucide-react';
import type { Sale } from '../lib/types';
import { fmtRs, timeAgo } from '../lib/utils';

export default function POSReprintBillRow({
  sale,
  index,
  customerPhone,
  onPrint,
  onWhatsApp,
}: {
  sale: Sale;
  index: number;
  customerPhone: string;
  onPrint: () => void;
  onWhatsApp: () => void;
}) {
  const itemCount = sale.items.reduce((count, item) => count + item.qty, 0);

  return (
    <div className="rounded-xl border border-line bg-raised/40 p-3 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className="w-8 h-8 rounded-lg bg-violet-500/10 text-violet-600 flex items-center justify-center text-[11px] font-extrabold num">{index + 1}</div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><span className="font-extrabold text-violet-600">{sale.billNo}</span><span className="text-[11px] text-faint">{timeAgo(sale.date)}</span></div>
          <div className="text-[11px] text-sub truncate">{sale.customerName || 'Walk-in customer'} · {itemCount} item{itemCount === 1 ? '' : 's'}</div>
          <div className="text-sm font-extrabold text-ink num mt-0.5">{fmtRs(sale.total)}</div>
        </div>
      </div>
      <div className="flex gap-1.5 shrink-0">
        <button type="button" className="btn btn-primary !py-2 !px-3 !text-xs" onClick={onPrint}><Printer size={13} /> Print</button>
        <button type="button" className="btn !py-2 !px-3 !text-xs !text-white" style={{ background: 'linear-gradient(135deg,#25d366,#128c7e)' }} onClick={onWhatsApp}><MessageCircle size={13} /> WhatsApp</button>
        {!customerPhone && <span className="self-center text-[10px] text-faint">number will be requested</span>}
      </div>
    </div>
  );
}
