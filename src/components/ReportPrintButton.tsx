import { FileDown } from 'lucide-react';

/**
 * Opens the native print dialog for the currently filtered report.
 * In the browser choose "Save as PDF"; in Windows desktop choose
 * "Microsoft Print to PDF" (or another installed PDF printer).
 */
export default function ReportPrintButton() {
  return (
    <button
      type="button"
      className="btn btn-outline no-print"
      onClick={() => window.print()}
      title="Print this report or save it as a PDF"
    >
      <FileDown size={14} /> Print / Save PDF
    </button>
  );
}
