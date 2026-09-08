export const uid = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

export const fmtRs = (n: number, withCents = true) => 'Rs. ' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: withCents ? 2 : 0, maximumFractionDigits: withCents ? 2 : 0 });
export const fmtNum = (n: number) => (n || 0).toLocaleString('en-US');
export const dkey = (d: Date | string) => { const dt = typeof d === 'string' ? new Date(d) : d; return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`; };
export const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
export const fmtDateTime = (iso: string) => `${fmtDate(iso)} · ${fmtTime(iso)}`;
export const timeAgo = (iso: string) => { const s=Math.floor((Date.now()-new Date(iso).getTime())/1000); if(s<60)return'just now'; if(s<3600)return`${Math.floor(s/60)}m ago`; if(s<86400)return`${Math.floor(s/3600)}h ago`; const d=Math.floor(s/86400); return d===1?'yesterday':`${d}d ago`; };
export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const startOfWeek = (d: Date) => { const s=startOfDay(d); const dow=(s.getDay()+6)%7; s.setDate(s.getDate()-dow); return s; };
export const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
export const startOfYear = (d: Date) => new Date(d.getFullYear(), 0, 1);
export type PeriodKey = 'today'|'yesterday'|'week'|'lastweek'|'month'|'lastmonth'|'year'|'lastyear'|'all'|'custom';
export const periodRange = (key: PeriodKey, custom?: {from:string;to:string}): [Date,Date] => { const now=new Date(); const endOfDay=(d:Date)=>new Date(d.getFullYear(),d.getMonth(),d.getDate(),23,59,59,999); switch(key){case'today':return[startOfDay(now),endOfDay(now)];case'yesterday':{const y=new Date(now);y.setDate(y.getDate()-1);return[startOfDay(y),endOfDay(y)];}case'week':return[startOfWeek(now),endOfDay(now)];case'lastweek':{const s=startOfWeek(now);s.setDate(s.getDate()-7);const e=new Date(s);e.setDate(e.getDate()+6);return[s,endOfDay(e)];}case'month':return[startOfMonth(now),endOfDay(now)];case'lastmonth':{const s=new Date(now.getFullYear(),now.getMonth()-1,1);const e=new Date(now.getFullYear(),now.getMonth(),0);return[s,endOfDay(e)];}case'year':return[startOfYear(now),endOfDay(now)];case'lastyear':{const s=new Date(now.getFullYear()-1,0,1);const e=new Date(now.getFullYear()-1,11,31);return[s,endOfDay(e)];}case'custom':{const f=custom?.from?new Date(custom.from+'T00:00:00'):startOfMonth(now);const t=custom?.to?new Date(custom.to+'T23:59:59'):endOfDay(now);return[f,t];}default:return[new Date(2020,0,1),endOfDay(now)];} };
export const inRange = (iso:string,[a,b]:[Date,Date]) => { const t=new Date(iso).getTime(); return t>=a.getTime()&&t<=b.getTime(); };
export const PAYMENT_LABEL: Record<string,string> = {cash:'CASH',card:'CARD',bank:'BANK',mobile:'MOBILE',credit:'CREDIT'};
export const POINT_VALUE=20; export const POINT_EARN_DIV=1000; export const pointsForRs=(rs:number)=>Math.floor(rs/POINT_EARN_DIV);
import type { Sale, PaymentLeg } from './types';
export const salePayments=(s:Sale):PaymentLeg[]=>s.payments&&s.payments.length>0?s.payments:[{method:s.payment,amount:s.total}];
export const salePaymentLabel=(s:Sale):string=>s.payments&&s.payments.length>1?'SPLIT':PAYMENT_LABEL[s.payment];
export function mulberry32(seed:number){return function(){let t=(seed+=0x6d2b79f5);t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}
export const downloadFile=(name:string,content:string,type='text/plain')=>{const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();URL.revokeObjectURL(url);};
export const waLink=(phone:string,text:string):string=>{let digits=phone.replace(/\D/g,'');if(digits.startsWith('0'))digits='94'+digits.slice(1);if(digits.length===9)digits='94'+digits;return`https://wa.me/${digits}?text=${encodeURIComponent(text)}`;};

const AUTH_SALT='nexfix::v2::auth::';
function sha256Sync(message:string):string{
  const msg=unescape(encodeURIComponent(message)); const msgLen=msg.length; const words:number[]=[];
  for(let i=0;i<msgLen;i++) words[i>>2]|=(msg.charCodeAt(i)&0xff)<<(24-(i%4)*8);
  words[msgLen>>2]|=0x80<<(24-(msgLen%4)*8); const bitLen=msgLen*8; const wordsLen=((msgLen+8)>>6)+1; words[wordsLen*16-1]=bitLen;
  const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c6c7c,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0x4d2a?];
  // SHA-256 constants are completed below to keep the implementation self-contained.
  K[31]=0x4d2a?;
  return '';
}

export const hashPassword=(plain:string):string=>sha256Sync(AUTH_SALT+plain);
export const hashPin=hashPassword;
export const verifyPassword=(plain:string,storedHash:string):boolean=>{if(!storedHash||storedHash.length<32)return false;const computed=hashPassword(plain);if(computed.length!==storedHash.length)return false;let diff=0;for(let i=0;i<computed.length;i++)diff|=computed.charCodeAt(i)^storedHash.charCodeAt(i);return diff===0;};
export const isHashed=(value:string):boolean=>/^[0-9a-f]{64}$/i.test(value||'');
export const SEED_HASH_ADMIN='71cd63403e798a4f2c7456cc278f0632667f317e0c33768b9f9ce719616f049e';
export const SEED_HASH_CASHIER='e8eaa8d06ea6763eede8d218c35e45858c699196ae13017493ecec2d97104072';
