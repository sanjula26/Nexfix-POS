import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const uid = (): string => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

export const fmtRs = (n: number, withCents = true) =>
  'Rs. ' +
  (n || 0).toLocaleString('en-LK', {
    minimumFractionDigits: withCents ? 2 : 0,
    maximumFractionDigits: withCents ? 2 : 0,
  });

export const fmtNum = (n: number) => (n || 0).toLocaleString('en-LK');

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

export const PAYMENT_LABEL: Record<string, string> = {
  cash: 'CASH',
  card: 'CARD',
  bank: 'BANK',
  mobile: 'MOBILE',
  credit: 'CREDIT',
  points: 'POINTS',
};

export const POINT_VALUE = 20;
export const POINT_EARN_DIV = 1000;
export const pointsForRs = (rs: number, div = POINT_EARN_DIV) => Math.floor(rs / div);

export const waLink = (phone: string, text: string): string => {
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0')) digits = '94' + digits.slice(1);
  if (digits.length === 9) digits = '94' + digits;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
};

export const DEFAULT_CATEGORIES = [
  'Smartphones',
  'Laptops',
  'Tablets',
  'Desktop',
  'Accessories',
  'Audio',
  'Power & Batteries',
  'Storage',
  'Networking',
  'Parts',
  'CCTV Cameras',
  'CCTV NVR/DVR',
  'CCTV Cables & Accessories',
  'CCTV Power',
  'Installation Services',
  'Other',
];

export const DEFAULT_BRANDS = [
  'Apple', 'Samsung', 'Xiaomi', 'Huawei', 'Oppo', 'Vivo', 'Realme',
  'HP', 'Dell', 'Lenovo', 'Asus', 'Acer', 'Sony', 'JBL', 'Anker',
  'Baseus', 'Hikvision', 'Dahua', 'CP Plus', 'Imou', 'Generic', 'Other',
];
