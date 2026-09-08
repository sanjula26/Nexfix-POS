export const uid = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r=(Math.random()*16)|0; const v=c==='x'?r:(r&0x3)|0x8; return v.toString(16); });
};
export const fmtRs=(n:number,withCents=true)=>'Rs. '+(n||0).toLocaleString('en-US',{minimumFractionDigits:withCents?2:0,maximumFractionDigits:withCents?2:0});
export const fmtNum=(n:number)=>(n||0).toLocaleString('en-US');
export const dkey=(d:Date|string)=>{const dt=typeof d==='string'?new Date(d):d;return`${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;};
export const fmtDate=(iso:string)=>new Date(iso).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
export const fmtTime=(iso:string)=>new Date(iso).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
export const fmtDateTime=(iso:string)=>`${fmtDate(iso)} · ${fmtTime(iso)}`;
export const timeAgo=(iso:string)=>{const s=Math.floor((Date.now()-new Date(iso).getTime())/1000);if(s<60)return'just now';if(s<3600)return`${Math.floor(s/60)}m ago`;if(s<86400)return`${Math.floor(s/3600)}h ago`;const d=Math.floor(s/86400);return d===1?'yesterday':`${d}d ago`;};
export const startOfDay=(d:Date)=>new Date(d.getFullYear(),d.getMonth(),d.getDate());
export const startOfWeek=(d:Date)=>{const s=startOfDay(d);const dow=(s.getDay()+6)%7;s.setDate(s.getDate()-dow);return s;};
export const startOfMonth=(d:Date)=>new Date(d.getFullYear(),d.getMonth(),1);
export const startOfYear=(d:Date)=>new Date(d.getFullYear(),0,1);
export type PeriodKey='today'|'yesterday'|'week'|'lastweek'|'month'|'lastmonth'|'year'|'lastyear'|'all'|'custom';
export const periodRange=(key:PeriodKey,custom?:{from:string;to:string}):[Date,Date]=>{const now=new Date();const endOfDay=(d:Date)=>new Date(d.getFullYear(),d.getMonth(),d.getDate(),23,59,59,999);switch(key){case'today':return[startOfDay(now),endOfDay(now)];case'yesterday':{const y=new Date(now);y.setDate(y.getDate()-1);return[startOfDay(y),endOfDay(y)];}case'week':return[startOfWeek(now),endOfDay(now)];case'lastweek':{const s=startOfWeek(now);s.setDate(s.getDate()-7);const e=new Date(s);e.setDate(e.getDate()+6);return[s,endOfDay(e)];}case'month':return[startOfMonth(now),endOfDay(now)];case'lastmonth':{const s=new Date(now.getFullYear(),now.getMonth()-1,1);const e=new Date(now.getFullYear(),now.getMonth(),0);return[s,endOfDay(e)];}case'year':return[startOfYear(now),endOfDay(now)];case'lastyear':{const s=new Date(now.getFullYear()-1,0,1);const e=new Date(now.getFullYear()-1,11,31);return[s,endOfDay(e)];}case'custom':{const f=custom?.from?new Date(custom.from+'T00:00:00'):startOfMonth(now);const t=custom?.to?new Date(custom.to+'T23:59:59'):endOfDay(now);return[f,t];}default:return[new Date(2020,0,1),endOfDay(now)];}};
export const inRange=(iso:string,[a,b]:[Date,Date])=>{const t=new Date(iso).getTime();return t>=a.getTime()&&t<=b.getTime();};
export const PAYMENT_LABEL:Record<string,string>={cash:'CASH',card:'CARD',bank:'BANK',mobile:'MOBILE',credit:'CREDIT'};
export const POINT_VALUE=20;export const POINT_EARN_DIV=1000;export const pointsForRs=(rs:number)=>Math.floor(rs/POINT_EARN_DIV);
import type { Sale, PaymentLeg } from './types';
export const salePayments=(s:Sale):PaymentLeg[]=>s.payments&&s.payments.length>0?s.payments:[{method:s.payment,amount:s.total}];
export const salePaymentLabel=(s:Sale):string=>s.payments&&s.payments.length>1?'SPLIT':PAYMENT_LABEL[s.payment];
export function mulberry32(seed:number){return function(){let t=(seed+=0x6d2b79f5);t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}
export const downloadFile=(name:string,content:string,type='text/plain')=>{const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();URL.revokeObjectURL(url);};
export const waLink=(phone:string,text:string):string=>{let digits=phone.replace(/\D/g,'');if(digits.startsWith('0'))digits='94'+digits.slice(1);if(digits.length===9)digits='94'+digits;return`https://wa.me/${digits}?text=${encodeURIComponent(text)}`;};

const AUTH_SALT='nexfix::v2::auth::';
const PBKDF2_ITERATIONS=100_000;
const PBKDF2_SALT_BYTES=16;
const PBKDF2_KEY_BYTES=32;
const SHA256_K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c6c7c,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];

const rotr=(x:number,n:number)=>(x>>>n)|(x<<(32-n));
const sha256Bytes=(input:Uint8Array):Uint8Array=>{
  const bitLen=input.length*8;const total=((input.length+9+63)>>6)*64;const data=new Uint8Array(total);data.set(input);data[input.length]=0x80;
  const view=new DataView(data.buffer);view.setUint32(total-4,bitLen>>>0,false);view.setUint32(total-8,Math.floor(bitLen/0x100000000)>>>0,false);
  let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  const w=new Uint32Array(64);
  for(let off=0;off<total;off+=64){for(let i=0;i<16;i++)w[i]=view.getUint32(off+i*4,false);for(let i=16;i<64;i++){const s0=rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3);const s1=rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10);w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;}
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
    for(let i=0;i<64;i++){const S1=rotr(e,6)^rotr(e,11)^rotr(e,25);const ch=(e&f)^(~e&g);const t1=(h+S1+ch+SHA256_K[i]+w[i])>>>0;const S0=rotr(a,2)^rotr(a,13)^rotr(a,22);const maj=(a&b)^(a&c)^(b&c);const t2=(S0+maj)>>>0;h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
    h0=(h0+a)>>>0;h1=(h1+b)>>>0;h2=(h2+c)>>>0;h3=(h3+d)>>>0;h4=(h4+e)>>>0;h5=(h5+f)>>>0;h6=(h6+g)>>>0;h7=(h7+h)>>>0;
  }
  const out=new Uint8Array(32);const vals=[h0,h1,h2,h3,h4,h5,h6,h7];for(let i=0;i<8;i++)out.set([(vals[i]>>>24)&255,(vals[i]>>>16)&255,(vals[i]>>>8)&255,vals[i]&255],i*4);return out;
};
const utf8=(value:string)=>new TextEncoder().encode(value);
const hmacSha256=(key:Uint8Array,message:Uint8Array):Uint8Array=>{let k=key;if(k.length>64)k=sha256Bytes(k);const block=new Uint8Array(64);block.set(k);const inner=new Uint8Array(64);const outer=new Uint8Array(64);for(let i=0;i<64;i++){inner[i]=block[i]^0x36;outer[i]=block[i]^0x5c;}const innerInput=new Uint8Array(64+message.length);innerInput.set(inner);innerInput.set(message,64);const digest=sha256Bytes(innerInput);const outerInput=new Uint8Array(96);outerInput.set(outer);outerInput.set(digest,64);return sha256Bytes(outerInput);};
const pbkdf2Sha256=(password:string,salt:Uint8Array,iterations:number,keyLength:number):Uint8Array=>{const blocks=Math.ceil(keyLength/32);const result=new Uint8Array(blocks*32);const pass=utf8(password);for(let block=1;block<=blocks;block++){const saltBlock=new Uint8Array(salt.length+4);saltBlock.set(salt);saltBlock.set([(block>>>24)&255,(block>>>16)&255,(block>>>8)&255,block&255],salt.length);let u=hmacSha256(pass,saltBlock);const t=new Uint8Array(u);for(let i=1;i<iterations;i++){u=hmacSha256(pass,u);for(let j=0;j<32;j++)t[j]^=u[j];}result.set(t,(block-1)*32);}return result.slice(0,keyLength);};
const bytesToBase64=(bytes:Uint8Array):string=>{let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary);};
const base64ToBytes=(value:string):Uint8Array=>{const binary=atob(value);const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return bytes;};
const constantTimeEqual=(a:Uint8Array,b:Uint8Array):boolean=>{if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;};
const sha256Hex=(message:string)=>Array.from(sha256Bytes(utf8(message)),b=>b.toString(16).padStart(2,'0')).join('');

/** Password format: base64(random 16-byte salt):base64(PBKDF2-SHA-256 32-byte hash). */
export const hashPassword=(plain:string):string=>{const salt=new Uint8Array(PBKDF2_SALT_BYTES);crypto.getRandomValues(salt);return`${bytesToBase64(salt)}:${bytesToBase64(pbkdf2Sha256(plain,salt,PBKDF2_ITERATIONS,PBKDF2_KEY_BYTES))}`;};
export const verifyPassword=(plain:string,storedHash:string):boolean=>{try{const parts=storedHash.split(':');if(parts.length!==2)return false;const salt=base64ToBytes(parts[0]);const expected=base64ToBytes(parts[1]);if(salt.length!==PBKDF2_SALT_BYTES||expected.length!==PBKDF2_KEY_BYTES)return false;return constantTimeEqual(expected,pbkdf2Sha256(plain,salt,PBKDF2_ITERATIONS,PBKDF2_KEY_BYTES));}catch{return false;}};
export const verifyLegacyPassword=(plain:string,storedHash:string):boolean=>{if(!/^[0-9a-f]{64}$/i.test(storedHash||''))return false;const computed=sha256Hex(AUTH_SALT+plain);if(computed.length!==storedHash.length)return false;let diff=0;for(let i=0;i<computed.length;i++)diff|=computed.charCodeAt(i)^storedHash.charCodeAt(i);return diff===0;};
export const hashPin=(plain:string):string=>sha256Hex(AUTH_SALT+plain);
export const verifyPin=(plain:string,storedHash:string):boolean=>verifyLegacyPassword(plain,storedHash);
export const isPasswordHash=(value:string):boolean=>{const parts=(value||'').split(':');if(parts.length!==2)return false;try{return base64ToBytes(parts[0]).length===PBKDF2_SALT_BYTES&&base64ToBytes(parts[1]).length===PBKDF2_KEY_BYTES;}catch{return false;}};
export const isLegacyPasswordHash=(value:string):boolean=>/^[0-9a-f]{64}$/i.test(value||'');
export const isHashed=isPasswordHash;
export const SEED_HASH_ADMIN='71cd63403e798a4f2c7456cc278f0632667f317e0c33768b9f9ce719616f049e';
export const SEED_HASH_CASHIER='e8eaa8d06ea6763eede8d218c35e45858c699196ae13017493ecec2d97104072';
