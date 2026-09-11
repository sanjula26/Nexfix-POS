import {
  POSState, Product, Customer, Supplier, AppUser, Sale, Purchase, Expense,
  Exchange, AuditEntry, Settings, Permissions, DaySession, PaymentMethod,
  InventoryUnit, RepairJob,
} from './types';
import { mulberry32, uid, dkey, hashPin, SEED_HASH_ADMIN, SEED_HASH_CASHIER } from './utils';

export const PERMISSION_KEYS: { key: string; label: string; group: string }[] = [
  { key: 'page:dashboard', label: 'Dashboard', group: 'Pages' },
  { key: 'page:pos', label: 'POS / Sales', group: 'Pages' },
  { key: 'page:inventory', label: 'Inventory', group: 'Pages' },
  { key: 'page:units', label: 'IMEI / Serial Units', group: 'Pages' },
  { key: 'page:repairs', label: 'Repairs / Service', group: 'Pages' },
  { key: 'page:customers', label: 'Customers', group: 'Pages' },
  { key: 'page:suppliers', label: 'Suppliers', group: 'Pages' },
  { key: 'page:purchases', label: 'Purchases', group: 'Pages' },
  { key: 'page:sales', label: 'Sales History', group: 'Pages' },
  { key: 'page:exchanges', label: 'Exchanges', group: 'Pages' },
  { key: 'page:expenses', label: 'Expenses', group: 'Pages' },
  { key: 'page:reports', label: 'Reports', group: 'Pages' },
  { key: 'page:pricetags', label: 'Price Tags', group: 'Pages' },
  { key: 'act:discount', label: 'Apply discounts', group: 'Actions' },
  { key: 'act:creditSale', label: 'Credit sales', group: 'Actions' },
  { key: 'act:refund', label: 'Refunds & returns', group: 'Actions' },
  { key: 'act:viewCost', label: 'View cost & profit', group: 'Actions' },
  { key: 'act:manageStock', label: 'Edit products & stock', group: 'Actions' },
  { key: 'act:deleteRecords', label: 'Delete records', group: 'Actions' },
  { key: 'act:export', label: 'Export data', group: 'Actions' },
];

export const DEFAULT_CATEGORIES = [
  'Smartphones', 'Laptops', 'Tablets', 'Desktop', 'Accessories', 'Audio', 'Power & Batteries', 'Storage', 'Networking', 'Parts',
  'CCTV Cameras', 'CCTV NVR/DVR', 'CCTV Cables & Accessories', 'CCTV Power', 'Installation Services', 'Other',
];

export const DEFAULT_BRANDS = [
  'Apple', 'Samsung', 'Xiaomi', 'Huawei', 'Oppo', 'Vivo', 'Realme', 'HP', 'Dell', 'Lenovo', 'Asus', 'Acer', 'Sony', 'JBL', 'Anker',
  'Baseus', 'Hikvision', 'Dahua', 'CP Plus', 'Imou', 'Generic', 'Other',
];

const DEMO_SEED_ENABLED = import.meta.env.VITE_SEED_DEMO === 'true';

const emptyState = (): POSState => {
  const adminPermissions: Record<string, boolean> = {};
  PERMISSION_KEYS.forEach(permission => { adminPermissions[permission.key] = true; });
  return {
    products: [], customers: [], suppliers: [], sales: [], purchases: [], expenses: [], exchanges: [],
    users: [], audit: [], held: [], sessions: [],
    settings: {
      shopName: '', tagline: '', address: '', phone: '', email: '', receiptFooter: '',
      taxDefault: 0, lowStockDefault: 5, exchangeDays: 3, openingFloat: 0,
      adminPinHash: hashPin('admin123'), whatsappReceipts: false,
      categories: [...DEFAULT_CATEGORIES], brands: [...DEFAULT_BRANDS], repairWarrantyDays: 30,
      invoiceTitle: 'INVOICE', invoiceSubtitle: 'COMPUTER & PHONE SHOP', invoiceCurrency: 'Rs.', invoiceTaxLabel: 'Tax',
      invoiceTerms: 'Warranty and return conditions are subject to the shop policy.\nKeep this invoice for warranty and future reference.',
      invoiceFooter: 'Thank you for your purchase!', invoiceShowTax: true,
      taxRegistrationNo: '', invoicePlaceOfSupply: '',
    },
    permissions: { admin: adminPermissions, cashier: {} },
    counters: { bill: 0, po: 0, ex: 0, job: 0, quote: 0, claim: 0 },
    units: [], repairs: [], kitItems: [], quotations: [], warrantyClaims: [],
  };
};

const sell = (p: number) => Math.round(p * 100) / 100;

export function buildSeed(): POSState {
  if (!DEMO_SEED_ENABLED) return emptyState();

  const rng = mulberry32(20260813);
  const now = new Date();
  const iso = (d: Date) => d.toISOString();
  const daysAgo = (n: number, h = 10, m = 15) => {
    const d = new Date(now);
    d.setDate(d.getDate() - n);
    d.setHours(h, m + Math.floor(rng() * 40), Math.floor(rng() * 60), 0);
    return d;
  };

  const users: AppUser[] = [
    { id: 'u-admin', name: 'Shop Administrator', email: 'admin@nexfixsolution.com', password: SEED_HASH_ADMIN, role: 'admin', active: true, createdAt: iso(daysAgo(400)) },
    { id: 'u-nimal', name: 'Nimal Perera', email: 'cashier@nexfixsolution.com', password: SEED_HASH_CASHIER, role: 'cashier', active: true, createdAt: iso(daysAgo(300)) },
    { id: 'u-sithum', name: 'Sithum Eranga', email: 'sithum@nexfixsolution.com', password: SEED_HASH_CASHIER, role: 'cashier', active: true, createdAt: iso(daysAgo(120)) },
  ];

  const suppliers: Supplier[] = [
    { id: 's-mwi', name: 'Mobile World Imports', contactPerson: 'Fazil Ahmed', phone: '+94 11 245 6789', email: 'orders@mobileworld.lk', address: 'Panchikawatte, Colombo', createdAt: iso(daysAgo(390)) },
    { id: 's-pcb', name: 'Power Cell Batteries Ltd', contactPerson: 'Ruwan Bandara', phone: '+94 11 256 7890', email: 'info@powercell.lk', address: 'Kelaniya, Sri Lanka', createdAt: iso(daysAgo(350)) },
    { id: 's-tdl', name: 'Tech Distributors Lanka', contactPerson: 'Saman Kumara', phone: '+94 11 234 5678', email: 'sales@techdist.lk', address: 'Colombo 10, Sri Lanka', createdAt: iso(daysAgo(320)) },
    { id: 's-gha', name: 'Gadget Hub Asia', contactPerson: 'Nirosha Silva', phone: '+94 76 555 0134', email: 'hello@gadgethub.lk', address: 'Bambalapitiya, Colombo 04', createdAt: iso(daysAgo(180)) },
  ];