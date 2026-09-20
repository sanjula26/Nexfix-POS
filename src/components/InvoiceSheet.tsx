import { FileText, MapPin, Phone, Mail, Globe2, CheckCircle2 } from 'lucide-react';
import { usePOS } from '../lib/store';
import { fmtRs, fmtDateTime, PAYMENT_LABEL, salePayments, POINT_VALUE } from '../lib/utils';
import type { Sale } from '../lib/types';

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const TEENS = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function underThousand(n: number): string { const parts: string[] = []; if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} Hundred`); n %= 100; } if (n >= 20) { parts.push(TENS[Math.floor(n / 10)]); n %= 10; } if (n >= 10) { parts.push(TEENS[n - 10]); n = 0; } if (n > 0) parts.push(ONES[n]); return parts.join(' '); }
function amountInWords(value: number): string { const whole = Math.max(0, Math.floor(value)); if (whole === 0) return 'Zero Rupees Only.'; const groups: Array<[number, string]> = [[1_000_000_000, 'Billion'], [1_000_000, 'Million'], [1_000, 'Thousand']]; let n = whole; const parts: string[] = []; for (const [divisor, label] of groups) { if (n >= divisor) { const q = Math.floor(n / divisor); parts.push(`${underThousand(q)} ${label}`); n %= divisor; } } if (n > 0) parts.push(underThousand(n)); return `${parts.join(' ')} Rupees Only.`; }
function paymentStatus(sale: Sale): string { if (sale.payment === 'credit' && sale.total > sale.amountPaid) return 'CREDIT / BALANCE DUE'; if (sale.amountPaid >= sale.total) return 'PAID'; return 'PARTIALLY PAID'; }

export default function InvoiceSheet({ sale }: { sale: Sale }) {
  const { state } = usePOS();
  const st = state.settings;
  const currency = st.invoiceCurrency || 'Rs.';
  const invoiceTitle = st.invoiceTitle || 'INVOICE';
  const invoiceSubtitle = st.invoiceSubtitle || st.tagline || 'COMPUTER & PHONE SHOP';
  const taxLabel = st.invoiceTaxLabel || 'Tax';
  const terms = st.invoiceTerms?.trim();
  const footer = st.invoiceFooter || st.receiptFooter || 'Thank you for your purchase!';
  const customer = sale.customerId ? state.customers.find(c => c.id === sale.customerId) : undefined;
  const itemSubtotal = sale.items.reduce((a, i) => a + i.price * i.qty, 0);
  const lineDiscount = sale.items.reduce((a, i) => a + (i.discount || 0), 0);
  const paid = sale.amountPaid;
  return (
    <div className="invoice-print-area bg-white text-slate-900"><div className="invoice-page">
      <header className="invoice-header"><div className="invoice-brand"><div className="invoice-logo" aria-hidden="true"><span>NF</span></div><div><div className="invoice-shop-name">{st.shopName || 'YOUR SHOP NAME'}</div><div className="invoice-shop-subtitle">{invoiceSubtitle}</div><div className="invoice-tagline">{st.tagline || 'Buy · Sell · Repair · Support'}</div></div></div><div className="invoice-contact">{st.address && <div><MapPin size={13} /><span>{st.address}</span></div>}{st.phone && <div><Phone size={13} /><span>{st.phone}</span></div>}{st.email && <div><Mail size={13} /><span>{st.email}</span></div>}{st.taxRegistrationNo && <div><span><b>TIN:</b> {st.taxRegistrationNo}</span></div>}{st.invoicePlaceOfSupply && <div><span><b>Place:</b> {st.invoicePlaceOfSupply}</span></div>}{<div><Globe2 size={13} /><span>Computer &amp; Phone POS</span></div>}</div></header>

      <div className="invoice-title-row"><div className="invoice-customer-card"><div className="invoice-section-title">CUSTOMER DETAILS</div><div className="invoice-detail-grid"><span>Name</span><b>{sale.customerName || 'Walk-in Customer'}</b><span>Phone</span><b>{customer?.phone || '—'}</b><span>Address</span><b>{customer?.address || '—'}</b><span>Email</span><b>{customer?.email || '—'}</b>{customer?.tin && <><span>TIN</span><b>{customer.tin}</b></>}</div></div><div className="invoice-meta-card"><div className="invoice-title"><FileText size={30} /> {invoiceTitle}</div><div className="invoice-meta-grid"><span>Invoice No</span><b>{sale.billNo}</b><span>Date</span><b>{fmtDateTime(sale.date)}</b><span>Payment</span><b>{salePayments(sale).map(p => PAYMENT_LABEL[p.method]).join(' + ')}</b><span>Sales Person</span><b>{sale.cashierName}</b></div></div></div>

      <table className="invoice-table"><thead><tr><th>#</th><th>Item Description</th><th>Qty</th><th>Unit Price</th><th>Discount</th><th>Amount</th></tr></thead><tbody>{sale.items.map((it, i) => <tr key={`${it.productId}-${i}`}><td>{i + 1}</td><td><strong>{it.name}</strong>{(it.imeis?.length || it.serials?.length) ? <small>{it.imeis?.length ? `IMEI: ${it.imeis.join(', ')}` : `S/N: ${it.serials?.join(', ')}`}</small> : null}{it.warrantyMonths ? <small>Warranty: {it.warrantyMonths} months</small> : null}</td><td>{it.qty}</td><td>{currency} {fmtRs(it.price, false)}</td><td>{it.discount ? `${currency} ${fmtRs(it.discount, false)}` : '—'}</td><td>{currency} {fmtRs(it.price * it.qty - (it.discount || 0), false)}</td></tr>)}{Array.from({ length: Math.max(0, 8 - sale.items.length) }).map((_, i) => <tr className="invoice-empty-row" key={`empty-${i}`}><td></td><td></td><td></td><td></td><td></td><td></td></tr>)}</tbody></table>

      <div className="invoice-summary-row"><div className="invoice-words-box"><div className="invoice-section-title">AMOUNT IN WORDS</div><p>{amountInWords(sale.total)}</p>{sale.note && <><div className="invoice-section-title invoice-note-title">NOTE</div><p>{sale.note}</p></>}</div><div className="invoice-total-box"><div><span>Sub Total</span><b>{currency} {fmtRs(itemSubtotal, false)}</b></div>{lineDiscount + sale.discount > 0 && <div><span>Discount</span><b>- {currency} {fmtRs(lineDiscount + sale.discount, false)}</b></div>}{(sale.tradeIn?.value || 0)>0 && <div><span>Trade-in</span><b>- {currency} {fmtRs(sale.tradeIn?.value || 0, false)}</b></div>}{st.invoiceShowTax !== false && sale.tax > 0 && <div><span>{taxLabel}</span><b>{currency} {fmtRs(sale.tax, false)}</b></div>}{(sale.shipping || 0) > 0 && <div><span>Delivery / Other</span><b>{currency} {fmtRs(sale.shipping || 0, false)}</b></div>}{(sale.pointsRedeemed || 0) > 0 && <div><span>Points ({sale.pointsRedeemed} × {currency} {POINT_VALUE})</span><b>- {currency} {fmtRs((sale.pointsRedeemed || 0) * Math.max(0, Number(state.settings.loyaltyPointValue ?? POINT_VALUE)), false)}</b></div>}<div className="invoice-grand-total"><span>Total Amount</span><b>{currency} {fmtRs(sale.total, false)}</b></div></div></div>

      <div className="invoice-bottom-grid"><div className="invoice-terms"><div className="invoice-section-title">TERMS &amp; CONDITIONS</div>{(terms || 'Warranty and return conditions are subject to the shop policy.\nKeep this invoice for warranty and future reference.').split('\n').filter(Boolean).map((line, i) => <div key={i}>• {line}</div>)}</div><div className="invoice-status"><div className="invoice-section-title">PAYMENT STATUS</div><div className="invoice-paid"><CheckCircle2 size={20} /> {paymentStatus(sale)}</div>{sale.payment === 'credit' && sale.total > paid && <div className="invoice-balance">Balance Due: {currency} {fmtRs(sale.total - paid, false)}</div>}</div></div>

      <div className="invoice-signatures"><div><div className="signature-line"></div><strong>Authorised Signature</strong><small>Sign when required</small></div><div><div className="signature-line"></div><strong>Customer Signature</strong><small>Customer acknowledgement</small></div></div>
      <footer className="invoice-footer"><strong>{footer}</strong><span>Thank you for your business!</span></footer>
    </div></div>
  );
}
export { amountInWords };
