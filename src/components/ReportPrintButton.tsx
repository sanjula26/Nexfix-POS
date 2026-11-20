import { FileDown } from 'lucide-react';
import { usePOS } from '../lib/store';

/**
 * Opens the native print dialog for the currently filtered report.
 * In the browser choose "Save as PDF"; in Windows desktop choose
 * "Microsoft Print to PDF" (or another installed PDF printer).
 */
export default function ReportPrintButton() {
  const { state } = usePOS();
  const printedAt = new Date().toLocaleString();

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn btn-outline no-print"
        onClick={() => window.print()}
        title="Print this report or save it as a PDF"
      >
        <FileDown size={14} /> Print / Save PDF
      </button>
      <span className="hidden print:block text-xs text-slate-700">
        {state.settings.shopName || 'NexFix POS'} · Generated {printedAt}
      </span>
    </span>
  );
}
