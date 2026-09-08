export const uid = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // fallback for very old environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

export const fmtRs = (n: number, withCents = true) =>
  'Rs. ' +
  (n || 0).toLocaleString('en-US', {
    minimumFractionDigits: withCents ? 2 : 0,
    maximumFractionDigits: withCents ? 2 : 0,
  });

export const fmtNum = (n: number) => (n || 0).toLocaleString('en-US');

export const dkey = (d: Date | string) => {
  const dt = typeof d === 'string' ? new Date(d) : d;
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

export const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

export const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};

export const fmtDateTime = (iso: string) => `${fmtDate(iso)} · ${fmtTime(iso)}`;

export const timeAgo = (iso: string) => {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d}d ago`;
};

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const startOfWeek = (d: Date) => {
  const s = startOfDay(d);
  const dow = (s.getDay() + 6) % 7; // Monday start
  s.setDate(s.getDate() - dow);
  return s;
};
export const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
export const startOfYear = (d: Date) => new Date(d.getFullYear(), 0, 1);

export type PeriodKey =
  | 'today' | 'yesterday' | 'week' | 'lastweek' | 'month' | 'lastmonth'
  | 'year' | 'lastyear' | 'all' | 'custom';

export const periodRange = (key: PeriodKey, custom?: { from: string; to: string }): [Date, Date] => {
  const now = new Date();
  const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  switch (key) {
    case 'today': return [startOfDay(now), endOfDay(now)];
    case 'yesterday': {
      const y = new Date(now); y.setDate(y.getDate() - 1);
      return [startOfDay(y), endOfDay(y)];
    }
    case 'week': return [startOfWeek(now), endOfDay(now)];
    case 'lastweek': {
      const s = startOfWeek(now); s.setDate(s.getDate() - 7);
      const e = new Date(s); e.setDate(e.getDate() + 6);
      return [s, endOfDay(e)];
    }
    case 'month': return [startOfMonth(now), endOfDay(now)];
    case 'lastmonth': {
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const e = new Date(now.getFullYear(), now.getMonth(), 0);
      return [s, endOfDay(e)];
    }
    case 'year': return [startOfYear(now), endOfDay(now)];
    case 'lastyear': {
      const s = new Date(now.getFullYear() - 1, 0, 1);
      const e = new Date(now.getFullYear() - 1, 11, 31);
      return [s, endOfDay(e)];
    }
    case 'custom': {
      const f = custom?.from ? new Date(custom.from + 'T00:00:00') : startOfMonth(now);
      const t = custom?.to ? new Date(custom.to + 'T23:59:59') : endOfDay(now);
      return [f, t];
    }
    case 'all':
    default:
      return [new Date(2020, 0, 1), endOfDay(now)];
  }
};

export const inRange = (iso: string, [a, b]: [Date, Date]) => {
  const t = new Date(iso).getTime();
  return t >= a.getTime() && t <= b.getTime();
};

export const PAYMENT_LABEL: Record<string, string> = {
  cash: 'CASH', card: 'CARD', bank: 'BANK', mobile: 'MOBILE', credit: 'CREDIT',
};

/** loyalty program: earn 1 point per Rs. 1,000 spent · 1 point = Rs. 20 when redeemed */
export const POINT_VALUE = 20;
export const POINT_EARN_DIV = 1000;
export const pointsForRs = (rs: number) => Math.floor(rs / POINT_EARN_DIV);

import type { Sale, PaymentLeg } from './types';

/** normalized payment legs for any sale (split or single) */
export const salePayments = (s: Sale): PaymentLeg[] =>
  s.payments && s.payments.length > 0 ? s.payments : [{ method: s.payment, amount: s.total }];

export const salePaymentLabel = (s: Sale): string =>
  s.payments && s.payments.length > 1 ? 'SPLIT' : PAYMENT_LABEL[s.payment];

// deterministic pseudo-random for stable seeds
export function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const downloadFile = (name: string, content: string, type = 'text/plain') => {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
};

/** build a WhatsApp share link for a receipt/message (Sri Lanka aware) */
export const waLink = (phone: string, text: string): string => {
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0')) digits = '94' + digits.slice(1);
  if (digits.length === 9) digits = '94' + digits;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
};

/* ------------------------------------------------------------------ */
/*  Security: SHA-256 password / PIN hashing (sync pure-JS + WebCrypto) */
/* ------------------------------------------------------------------ */

const AUTH_SALT = 'nexfix::v2::auth::';

/** Minimal synchronous SHA-256 (UTF-8) — no external deps */
function sha256Sync(message: string): string {
  // Convert string to UTF-8 bytes
  const msg = unescape(encodeURIComponent(message));
  const msgLen = msg.length;
  const words: number[] = [];
  for (let i = 0; i < msgLen; i++) {
    words[i >> 2] |= (msg.charCodeAt(i) & 0xff) << (24 - (i % 4) * 8);
  }
  // Append padding
  words[msgLen >> 2] |= 0x80 << (24 - (msgLen % 4) * 8);
  const bitLen = msgLen * 8;
  const wordsLen = ((msgLen + 8) >> 6) + 1;
  words[wordsLen * 16 - 1] = bitLen;

  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c6c7c,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const w = new Array<number>(64);
  for (let i = 0; i < wordsLen; i++) {
    for (let j = 0; j < 16; j++) w[j] = words[i * 16 + j] | 0;
    for (let j = 16; j < 64; j++) {
      const s0 = ((w[j - 15] >>> 7) | (w[j - 15] << 25)) ^ ((w[j - 15] >>> 18) | (w[j - 15] << 14)) ^ (w[j - 15] >>> 3);
      const s1 = ((w[j - 2] >>> 17) | (w[j - 2] << 15)) ^ ((w[j - 2] >>> 19) | (w[j - 2] << 13)) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let j = 0; j < 64; j++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[j] + w[j]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  const toHex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4) + toHex(h5) + toHex(h6) + toHex(h7);
}

/** Hash a password or PIN (SHA-256 with app salt). Result is 64-char hex. */
export const hashPassword = (plain: string): string => sha256Sync(AUTH_SALT + plain);

/** Alias kept for admin PIN compatibility */
export const hashPin = hashPassword;

/** Constant-time-ish compare of two hex hashes */
export const verifyPassword = (plain: string, storedHash: string): boolean => {
  if (!storedHash || storedHash.length < 32) return false;
  const computed = hashPassword(plain);
  if (computed.length !== storedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ storedHash.charCodeAt(i);
  return diff === 0;
};

/** Detect whether a stored value looks like a SHA-256 hex hash (already hashed) */
export const isHashed = (value: string): boolean => /^[0-9a-f]{64}$/i.test(value || '');

/** Precomputed seed hashes (admin123 / cashier123) — SHA-256 with AUTH_SALT */
export const SEED_HASH_ADMIN = '71cd63403e798a4f2c7456cc278f0632667f317e0c33768b9f9ce719616f049e';
export const SEED_HASH_CASHIER = 'e8eaa8d06ea6763eede8d218c35e45858c699196ae13017493ecec2d97104072';
