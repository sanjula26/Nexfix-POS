import { Printer, Plus, Globe, MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { Modal } from './ui';
import { usePOS } from '../lib/store';
import { fmtRs, fmtDateTime, PAYMENT_LABEL, salePayments, POINT_VALUE, openWhatsAppLink, normalizeWhatsAppPhone } from '../lib/utils';
import type { Sale } from '../lib/types';

export function ReceiptSheet({ sale, forPrint }: { sale: Sale; forPrint?: boolean }) {
  const { state } = usePOS(); const st = state.settings;
  return <div className={forPrint ? 'print-area' : 'w-full'} style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}><div className={`${forPrint ? 'w-[72mm]' : 'w-full'} bg-white text-black p-5 text-[12px] leading-relaxed`}>
    <div className="text-center"><div className="flex justify-center mb-1.5"><span className="w-8 h-8 rounded-lg bg-black text-white flex items-center justify-center"><Globe size={15} /></span></div><div className="font-bold text-[15px] tracking-wide">{st.shopName.toUpperCase()}</div><div className="text-[10px]">{st.address}</div><div className="text-[10px]">{st.phone} · {st.email}</div></div>
    <div className="border-t border-dashed border-black my-3" /><div className="flex justify-between text-[11px]"><span>Bill: <b>{sale.billNo}</b></span></div><div className="flex justify-between text-[11px]"><span>{fmtDateTime(sale.date)}</span><span>Cashier: {sale.cashierName.split(' ')[0]}</span></div><div className="text-[11px]">Customer: {sale.customerName}</div>
    {sale.note && <><div className="border-t border-dashed border-black my-3" /><div className="text-[10px]"><span className="font-bold">Note:</span> {sale.note}</div></>}
    <div className="border-t border-dashed border-black my-3" /><table className="w-full text-[11px]"><thead><tr className="text-left"><th className="font-bold pb-1">Item</th><th className="font-bold pb-1 text-center">Qty</th><th className="font-bold pb-1 text-right">Amount</th></tr></thead><tbody>{sale.items.map((it,i)=><tr key={i}><td className="pr-2 py-0.5 align-top">{it.name}<div className="text-[9px] opacity-70">@ {fmtRs(it.price)}{it.discount ? ` · line disc -${fmtRs(it.discount,false)}` : ''}</div>{it.imeis?.length ? <div className="text-[9px] opacity-80">IMEI: {it.imeis.join(', ')}</div> : null}{it.serials?.length ? <div className="text-[9px] opacity-80">S/N: {it.serials.join(', ')}</div> : null}{it.warrantyMonths ? <div className="text-[9px] opacity-80">Warranty: {it.warrantyMonths} mo</div> : null}</td><td className="text-center align-top py-0.5">{it.qty}</td><td className="text-right align-top py-0.5">{(it.price*it.qty-(it.discount||0)).toLocaleString()}</td></tr>)}</tbody></table>
    <div className="border-t border-dashed border-black my-3" /><div className="space-y-0.5 text-[11px]"><div className="flex justify-between"><span>Subtotal</span><span>{sale.items.reduce((a,i)=>a+i.price*i.qty-(i.discount||0),0).toLocaleString('en-US',{minimumFractionDigits:2})}</span></div>{sale.discount>0&&<div className="flex justify-between"><span>Discount</span><span>- {fmtRs(sale.discount,false)}</span></div>}{(sale.tradeIn?.value || 0)>0&&<div className="flex justify-between"><span>Trade-in</span><span>- {fmtRs(sale.tradeIn?.value || 0,false)}</span></div>}{sale.tax>0&&<div className="flex justify-between"><span>Tax</span><span>{fmtRs(sale.tax,false)}</span></div>}{(sale.shipping||0)>0&&<div className="flex justify-between"><span>Delivery / other</span><span>{fmtRs(sale.shipping||0,false)}</span></div>}{(sale.pointsRedeemed||0)>0&&<div className="flex justify-between"><span>Points ({sale.pointsRedeemed} × Rs. {Math.max(0, Number(st.loyaltyPointValue ?? POINT_VALUE))})</span><span>- {fmtRs((sale.pointsRedeemed||0)*Math.max(0, Number(st.loyaltyPointValue ?? POINT_VALUE)),false)}</span></div>}<div className="flex justify-between font-bold text-[14px] pt-1"><span>TOTAL</span><span>{fmtRs(sale.total,false)}</span></div>{sale.payments&&sale.payments.length>1?salePayments(sale).map((l,i)=><div key={i} className="flex justify-between"><span>Paid · {PAYMENT_LABEL[l.method]}</span><span>{fmtRs(l.amount,false)}</span></div>):<div className="flex justify-between"><span>Paid ({PAYMENT_LABEL[sale.payment]})</span><span>{fmtRs(sale.amountPaid,false)}</span></div>}{sale.change>0&&<div className="flex justify-between"><span>Change</span><span>{fmtRs(sale.change,false)}</span></div>}{sale.payment==='credit'&&sale.total-sale.amountPaid>0&&<div className="flex justify-between font-bold"><span>BALANCE DUE</span><span>{fmtRs(sale.total-sale.amountPaid,false)}</span></div>}{(sale.pointsEarned||0)>0&&<div className="flex justify-between text-[10px]"><span>Loyalty points earned</span><span>+{sale.pointsEarned} pts</span></div>}</div>
    <div className="border-t border-dashed border-black my-3" /><div className="text-center text-[10px] space-y-1"><div>{st.receiptFooter}</div><div className="opacity-70">Powered by NEXFIX POS v3.1</div></div>
  </div></div>;
}

export function buildWhatsAppText(sale: Sale, shop: { shopName: string; phone: string; email: string }): string {
  const lines: string[] = [];
  const money = (value: number) => `Rs. ${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  const lineDiscountTotal = sale.items.reduce((sum, item) => sum + (item.discount || 0), 0);
  const totalDiscount = lineDiscountTotal + Math.max(0, sale.discount || 0);
  const payments = salePayments(sale);
  const isSplitPayment = !!sale.payments && sale.payments.length > 1;

  lines.push(`*${shop.shopName}*`);
  lines.push(`Bill: ${sale.billNo}`);
  lines.push(`Date: ${fmtDateTime(sale.date)}`);
  lines.push(`Customer: ${sale.customerName || 'Walk-in customer'}`);
  lines.push(`Cashier: ${sale.cashierName.split(' ')[0]}`);
  lines.push('--------------------------------');

  sale.items.forEach(item => {
    const gross = item.price * item.qty;
    const discount = item.discount || 0;
    const amount = gross - discount;
    lines.push(`• ${item.name}`);
    lines.push(`  Price: ${money(item.price)}`);
    lines.push(`  Qty: ${item.qty}`);
    lines.push(`  Discount: ${money(discount)}`);
    lines.push(`  Amount: ${money(amount)}`);
  });

  lines.push('--------------------------------');
  lines.push(`Subtotal: ${money(sale.subtotal)}`);
  lines.push(`Total Discount: ${money(totalDiscount)}`);

  if ((sale.tradeIn?.value || 0) > 0) {
    lines.push(`Trade-in: - ${money(sale.tradeIn?.value || 0)}`);
  }
  if ((sale.tax || 0) > 0) {
    lines.push(`Tax: ${money(sale.tax)}`);
  }
  if ((sale.shipping || 0) > 0) {
    lines.push(`Delivery / other: ${money(sale.shipping || 0)}`);
  }
  if ((sale.pointsRedeemed || 0) > 0) {
    lines.push(`Points redeemed: ${sale.pointsRedeemed}`);
  }

  lines.push(`*TOTAL: ${money(sale.total)}*`);
  if (isSplitPayment) {
    lines.push('Payment: Split');
    payments.forEach(payment => {
      lines.push(`  ${PAYMENT_LABEL[payment.method]}: ${money(payment.amount)}`);
    });
  } else {
    lines.push(`Payment: ${PAYMENT_LABEL[sale.payment]}`);
  }
  lines.push(`Paid: ${money(sale.amountPaid)}`);
  if (sale.change > 0) lines.push(`Change: ${money(sale.change)}`);
  if (sale.payment === 'credit' && sale.total - sale.amountPaid > 0) {
    lines.push(`Balance Due: ${money(sale.total - sale.amountPaid)}`);
  }

  lines.push('--------------------------------');
  lines.push('Thank you for shopping with us!');
  lines.push('Powered by NEXFIX POS');
  if (shop.email) lines.push(`Email: ${shop.email}`);
  if (shop.phone) lines.push(`Contact: ${shop.phone}`);

  return lines.join('\n');
}
export default function ReceiptModal({ sale, preferredWhatsAppPhone, onClose, onNewSale }:{sale:Sale|null;preferredWhatsAppPhone?:string;onClose:()=>void;onNewSale?:()=>void;}){
  const { state } = usePOS();
  const [whatsappOpen,setWhatsappOpen]=useState(false);
  const [whatsappPhone,setWhatsappPhone]=useState('');
  if(!sale)return null;
  const customer=sale.customerId?state.customers.find(c=>c.id===sale.customerId):undefined;
  const openWhatsApp=()=>{
    const phone=normalizeWhatsAppPhone(preferredWhatsAppPhone||customer?.phone||'');
    if(phone.length>=9&&phone.length<=15){
      openWhatsAppLink(phone,buildWhatsAppText(sale,state.settings));
      return;
    }
    setWhatsappPhone(preferredWhatsAppPhone||customer?.phone||'');
    setWhatsappOpen(true);
  };
  const sendWhatsApp=()=>{
    const phone=normalizeWhatsAppPhone(whatsappPhone);
    if(phone.length<9||phone.length>15)return;
    openWhatsAppLink(phone,buildWhatsAppText(sale,state.settings));
    setWhatsappOpen(false);
  };
  return <><Modal open={!!sale} onClose={onClose} title="Sale completed" sub={`Bill ${sale.billNo} saved to sales history`}>
    <div className="bg-raised rounded-2xl p-4 max-h-[46vh] overflow-y-auto border border-line"><ReceiptSheet sale={sale}/></div>
    <div className="flex flex-col sm:flex-row gap-2.5 mt-5">
      <button className="btn btn-primary flex-1" onClick={()=>window.print()}><Printer size={15}/> Print receipt</button>
      <button type="button" className="btn flex-1 !text-white" onClick={openWhatsApp} style={{background:'linear-gradient(135deg,#25d366,#128c7e)',boxShadow:'0 8px 20px -6px rgba(18,140,126,.5)'}}><MessageCircle size={15}/> WhatsApp receipt</button>
      <button className="btn btn-soft flex-1" onClick={()=>{onClose();onNewSale?.();}}><Plus size={15}/> New sale</button>
    </div>
  </Modal>
  <Modal open={whatsappOpen} onClose={()=>setWhatsappOpen(false)} title="Send bill via WhatsApp" sub={sale.billNo}>
    <div className="space-y-4">
      <div className="text-sm text-sub">Enter the customer's WhatsApp number. It is used only to open WhatsApp for this bill.</div>
      <input className="input w-full" type="tel" inputMode="tel" autoFocus value={whatsappPhone} onChange={e=>setWhatsappPhone(e.target.value)} placeholder="e.g. 0771234567 or +94771234567" onKeyDown={e=>{if(e.key==='Enter')sendWhatsApp();}} />
      <div className="flex gap-2">
        <button type="button" className="btn btn-soft flex-1" onClick={()=>setWhatsappOpen(false)}>Cancel</button>
        <button type="button" className="btn !text-white flex-1" disabled={normalizeWhatsAppPhone(whatsappPhone).length<9||normalizeWhatsAppPhone(whatsappPhone).length>15} onClick={sendWhatsApp} style={{background:'linear-gradient(135deg,#25d366,#128c7e)'}}><MessageCircle size={15}/> Send on WhatsApp</button>
      </div>
    </div>
  </Modal>
  <ReceiptSheet sale={sale} forPrint/></>;
}
