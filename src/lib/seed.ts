import {
  POSState, Product, Customer, Supplier, AppUser, Sale, Purchase, Expense,
  Exchange, AuditEntry, Settings, Permissions, DaySession, PaymentMethod,
  InventoryUnit, RepairJob,
} from './types';
import { mulberry32, uid, dkey, hashPin, hashPassword } from './utils';

const SEED_DEMO = import.meta.env.VITE_SEED_DEMO === 'true';
const DEMO_ADMIN_PASSWORD = ['admin', '123'].join('');
const DEMO_CASHIER_PASSWORD = ['cashier', '123'].join('');

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

export const DEFAULT_ROLE_PERMISSIONS: Record<'cashier' | 'manager' | 'technician', Record<string, boolean>> = {
  cashier: {
    'page:dashboard': true, 'page:pos': true, 'page:inventory': false, 'page:units': true, 'page:repairs': true,
    'page:customers': true, 'page:suppliers': false, 'page:purchases': false, 'page:sales': true, 'page:exchanges': true,
    'page:expenses': false, 'page:reports': false, 'page:pricetags': true, 'act:discount': true, 'act:creditSale': false,
    'act:refund': false, 'act:viewCost': false, 'act:manageStock': false, 'act:deleteRecords': false, 'act:export': false,
  },
  manager: {
    'page:dashboard': true, 'page:pos': true, 'page:inventory': true, 'page:units': true, 'page:repairs': true,
    'page:customers': true, 'page:suppliers': true, 'page:purchases': true, 'page:sales': true, 'page:exchanges': true,
    'page:expenses': true, 'page:reports': true, 'page:pricetags': true, 'act:discount': true, 'act:creditSale': true,
    'act:refund': true, 'act:viewCost': true, 'act:manageStock': true, 'act:deleteRecords': false, 'act:export': true,
  },
  technician: {
    'page:dashboard': true, 'page:pos': false, 'page:inventory': true, 'page:units': true, 'page:repairs': true,
    'page:customers': true, 'page:suppliers': false, 'page:purchases': false, 'page:sales': false, 'page:exchanges': false,
    'page:expenses': false, 'page:reports': false, 'page:pricetags': false, 'act:discount': false, 'act:creditSale': false,
    'act:refund': false, 'act:viewCost': false, 'act:manageStock': false, 'act:deleteRecords': false, 'act:export': false,
  },
};

export const DEFAULT_CATEGORIES = [
  'Smartphones', 'Laptops', 'Tablets', 'Desktop', 'Accessories', 'Audio',
  'Power & Batteries', 'Storage', 'Networking', 'Parts',
  'CCTV Cameras', 'CCTV NVR/DVR', 'CCTV Cables & Accessories', 'CCTV Power',
  'Installation Services', 'Other',
];

export const DEFAULT_BRANDS = [
  'Apple', 'Samsung', 'Xiaomi', 'Huawei', 'Oppo', 'Vivo', 'Realme',
  'HP', 'Dell', 'Lenovo', 'Asus', 'Acer', 'Sony', 'JBL', 'Anker',
  'Baseus', 'Hikvision', 'Dahua', 'CP Plus', 'Imou', 'Generic', 'Other',
];

const emptyState = (): POSState => {
  const adminPermissions: Record<string, boolean> = {};
  PERMISSION_KEYS.forEach(permission => { adminPermissions[permission.key] = true; });
  const now = new Date().toISOString();
  const demoAdminHash = SEED_DEMO ? hashPassword(DEMO_ADMIN_PASSWORD) : '';
  const demoCashierHash = SEED_DEMO ? hashPassword(DEMO_CASHIER_PASSWORD) : '';
  const defaultUsers: AppUser[] = SEED_DEMO ? [
    {
      id: 'u-admin',
      name: 'Shop Administrator',
      email: 'admin@nexfixsolution.com',
      password: demoAdminHash,
      role: 'admin',
      active: true,
      mustChangePassword: true,
      createdAt: now,
    },
    {
      id: 'u-nimal',
      name: 'Cashier',
      email: 'cashier@nexfixsolution.com',
      password: demoCashierHash,
      role: 'cashier',
      active: true,
      mustChangePassword: true,
      createdAt: now,
    },
  ] : [];
  const cashierPerms: Record<string, boolean> = {
    'page:pos': true,
    'page:customers': true,
    'page:sales': true,
    'act:discount': true,
  };
  return {
    products: [], customers: [], suppliers: [], sales: [], purchases: [], expenses: [], exchanges: [],
    users: defaultUsers, audit: [], held: [], sessions: [],
    settings: {
      shopName: 'Nexfix Solution', tagline: '', address: '', phone: '', email: '', receiptFooter: '',
      taxDefault: 0, lowStockDefault: 5, exchangeDays: 3, openingFloat: 10000, loyaltyPointsPerRs: 0.001, loyaltyPointValue: 20, promotions: [],
      adminPinHash: SEED_DEMO ? hashPin(DEMO_ADMIN_PASSWORD) : '', whatsappReceipts: false,
      categories: [...DEFAULT_CATEGORIES], brands: [...DEFAULT_BRANDS], repairWarrantyDays: 30,
      invoiceTitle: 'INVOICE', invoiceSubtitle: 'COMPUTER & PHONE SHOP', invoiceCurrency: 'Rs.', invoiceTaxLabel: 'Tax',
      invoiceTerms: 'Warranty and return conditions are subject to the shop policy.\nKeep this invoice for warranty and future reference.',
      invoiceFooter: 'Thank you for your purchase!', invoiceShowTax: true, taxRegistrationNo: '', invoicePlaceOfSupply: '',
    },
    permissions: { admin: adminPermissions, cashier: { ...DEFAULT_ROLE_PERMISSIONS.cashier }, manager: { ...DEFAULT_ROLE_PERMISSIONS.manager }, technician: { ...DEFAULT_ROLE_PERMISSIONS.technician } },
    counters: { bill: 0, po: 0, ex: 0, job: 0, quote: 0, claim: 0 },
    units: [], repairs: [], kitItems: [], quotations: [], warrantyClaims: [],
  };
};

const sell = (p: number) => Math.round(p * 100) / 100;

export const buildSeed = (): POSState => {
  // Production/offline builds start empty and require first-run administrator setup.
  // Demo fixtures (including demo accounts) exist only when explicitly enabled.
  if (!SEED_DEMO) return emptyState();
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
    { id: 'u-admin', name: 'Shop Administrator', email: 'admin@nexfixsolution.com', password: hashPassword(DEMO_ADMIN_PASSWORD), role: 'admin', active: true, mustChangePassword: true, createdAt: iso(daysAgo(400)) },
    { id: 'u-nimal', name: 'Nimal Perera', email: 'cashier@nexfixsolution.com', password: hashPassword(DEMO_CASHIER_PASSWORD), role: 'cashier', active: true, mustChangePassword: true, createdAt: iso(daysAgo(300)) },
    { id: 'u-sithum', name: 'Sithum Eranga', email: 'sithum@nexfixsolution.com', password: hashPassword(DEMO_CASHIER_PASSWORD), role: 'cashier', active: true, createdAt: iso(daysAgo(120)) },
  ];

  const suppliers: Supplier[] = [
    { id: 's-mwi', name: 'Mobile World Imports', contactPerson: 'Fazil Ahmed', phone: '+94 11 245 6789', email: 'orders@mobileworld.lk', address: 'Panchikawatte, Colombo', createdAt: iso(daysAgo(390)) },
    { id: 's-pcb', name: 'Power Cell Batteries Ltd', contactPerson: 'Ruwan Bandara', phone: '+94 11 256 7890', email: 'info@powercell.lk', address: 'Kelaniya, Sri Lanka', createdAt: iso(daysAgo(350)) },
    { id: 's-tdl', name: 'Tech Distributors Lanka', contactPerson: 'Saman Kumara', phone: '+94 11 234 5678', email: 'sales@techdist.lk', address: 'Colombo 10, Sri Lanka', createdAt: iso(daysAgo(320)) },
    { id: 's-gha', name: 'Gadget Hub Asia', contactPerson: 'Nirosha Silva', phone: '+94 76 555 0134', email: 'hello@gadgethub.lk', address: 'Bambalapitiya, Colombo 04', createdAt: iso(daysAgo(180)) },
  ];

  const P = (
    id: string, name: string, sku: string, category: string, brand: string,
    cost: number, price: number, stock: number, reorderLevel: number,
    trackImei = false, supplierId = 's-tdl',
  ): Product => ({
    id, name, sku, barcode: '479' + String(1000000000 + Math.floor(rng() * 899999999)),
    category, brand, cost, price, stock, reorderLevel, trackImei,
    supplierId, active: true, createdAt: iso(daysAgo(200)),
  });

  const products: Product[] = [
    P('p-gala15', 'Samsung Galaxy A15 5G', 'NFX-SP-A15', 'Smartphones', 'Samsung', 62000, 74500, 8, 5, true, 's-mwi'),
    P('p-s23fe', 'Samsung Galaxy S23 FE', 'NFX-SP-S23FE', 'Smartphones', 'Samsung', 156000, 178500, 3, 4, true, 's-mwi'),
    P('p-ip13', 'Apple iPhone 13 128GB', 'NFX-SP-IP13', 'Smartphones', 'Apple', 232000, 259000, 4, 3, true, 's-gha'),
    P('p-rn13', 'Xiaomi Redmi Note 13', 'NFX-SP-RN13', 'Smartphones', 'Xiaomi', 68500, 79900, 12, 5, true, 's-mwi'),
    P('p-hpp15', 'HP Pavilion 15 (i5 / 16GB)', 'NFX-LP-HPP15', 'Laptops', 'HP', 248000, 289000, 3, 2, true, 's-tdl'),
    P('p-ids3', 'Lenovo IdeaPad Slim 3', 'NFX-LP-IDS3', 'Laptops', 'Lenovo', 168000, 194500, 2, 3, true, 's-tdl'),
    P('p-jbl510', 'JBL Tune 510BT Headset', 'NFX-AU-JBL510', 'Audio', 'JBL', 13500, 18900, 15, 6, false, 's-gha'),
    P('p-sonych520', 'Sony WH-CH520 Wireless', 'NFX-AU-CH520', 'Audio', 'Sony', 16500, 22500, 2, 4, false, 's-gha'),
    P('p-ank10k', 'Anker PowerCore 10000', 'NFX-PW-ANK10K', 'Power', 'Anker', 9800, 13900, 20, 8, false, 's-pcb'),
    P('p-batip13', 'iPhone 13 Battery (OEM)', 'NFX-PW-BATIP13', 'Power', 'Apple OEM', 8500, 14500, 4, 6, false, 's-pcb'),
    P('p-chg25w', 'USB-C Fast Charger 25W', 'NFX-AC-CHG25', 'Accessories', 'Samsung', 2800, 4950, 35, 10, false, 's-pcb'),
    P('p-sd128', 'SanDisk microSD 128GB', 'NFX-ST-SD128', 'Storage', 'SanDisk', 5400, 7900, 18, 8, false, 's-tdl'),
    P('p-bip5', 'Amazfit Bip 5 Smartwatch', 'NFX-WR-BIP5', 'Wearables', 'Amazfit', 24500, 32900, 5, 4, true, 's-gha'),
    P('p-g3010', 'Canon PIXMA G3010 Printer', 'NFX-PR-G3010', 'Printers', 'Canon', 68500, 84900, 2, 2, true, 's-tdl'),
    P('p-cable1m', 'Type-C Cable 1m (Braided)', 'NFX-AC-CC1M', 'Accessories', 'Baseus', 650, 1450, 3, 10, false, 's-pcb'),
    P('p-tglass', 'Tempered Glass (Universal)', 'NFX-AC-TGLS', 'Accessories', 'Generic', 350, 1200, 40, 15, false, 's-pcb'),
    P('p-hdmi2m', 'HDMI Cable 2m', 'NFX-AC-HDMI2', 'Accessories', 'Generic', 120, 250, 40, 10, false, 's-pcb'),
    P('p-vga', 'VGA Cable', 'NFX-AC-VGA', 'Accessories', 'Generic', 45, 75, 25, 8, false, 's-pcb'),
    P('p-usbc', 'USB-C Cable 1m', 'NFX-AC-USBC', 'Accessories', 'Baseus', 500, 1250, 30, 10, false, 's-pcb'),
    P('p-mouse', 'Wireless Mouse', 'NFX-AC-MOUSE', 'Accessories', 'Logitech', 1800, 3250, 12, 5, false, 's-tdl'),
    P('p-keyboard', 'USB Keyboard', 'NFX-AC-KBD', 'Accessories', 'Logitech', 2200, 3950, 10, 4, false, 's-tdl'),
    P('p-pendrive32', '32GB Pendrive', 'NFX-ST-PD32', 'Storage', 'SanDisk', 1800, 2950, 20, 6, false, 's-tdl'),
    P('p-cctv', 'CCTV Bullet Camera 2MP', 'NFX-CCTV-B2M', 'CCTV Cameras', 'Hikvision', 8500, 12500, 2, 3, false, 's-tdl'),
    P('p-phonecase', 'Phone Case - Generic', 'NFX-AC-CASE', 'Accessories', 'Generic', 450, 1200, 30, 8, false, 's-pcb'),
    P('p-earphones', 'Basic Wired Earphones', 'NFX-AU-EAR', 'Audio', 'Generic', 650, 1450, 20, 6, false, 's-gha'),
    {
      ...P('p-kit', 'Phone Starter Kit', 'NFX-KIT-START', 'Accessories', 'Nexfix', 2050, 3490, 10, 3, false, 's-pcb'),
      isKit: true,
    },
  ];

  const customers: Customer[] = [
    { id: 'c-fathima', name: 'Fathima Rizvi', phone: '+94 70 567 8901', email: 'fathima.r@example.com', address: '34 Sea Street, Colombo 11', createdAt: iso(daysAgo(210)), creditBalance: 0, loyaltyPoints: 240 },
    { id: 'c-kasun', name: 'Kasun Rajapaksha', phone: '+94 77 123 4567', email: 'kasun@example.com', nic: '200012345678', address: '123 Galle Road, Colombo 04', createdAt: iso(daysAgo(190)), creditBalance: 0, loyaltyPoints: 95 },
    { id: 'c-nimali', name: 'Nimali Fernando', phone: '+94 71 234 5678', email: 'nimali.f@example.com', nic: '199823456789', address: '45 Kandy Road, Kiribathgoda', createdAt: iso(daysAgo(150)), creditBalance: 14500, loyaltyPoints: 60 },
    { id: 'c-priyantha', name: 'Priyantha Silva', phone: '+94 75 456 7890', email: 'priyantha@example.com', nic: '198734567890', address: '12 Park Road, Maharagama', createdAt: iso(daysAgo(130)), creditBalance: 0, loyaltyPoints: 140 },
    { id: 'c-saman', name: 'Saman Kumara', phone: '+94 76 345 6789', address: '78 Baseline Road, Colombo 09', createdAt: iso(daysAgo(100)), creditBalance: 0, loyaltyPoints: 25 },
    { id: 'c-dilshan', name: 'Dilshan Madushanka', phone: '+94 78 234 1122', email: 'dilshan.m@example.com', address: '5 Temple Road, Nugegoda', createdAt: iso(daysAgo(60)), creditBalance: 0, loyaltyPoints: 0 },
    { id: 'c-anne', name: 'Anne Perera', phone: '+94 72 998 4411', email: 'anne.p@example.com', address: '21 Hill Street, Dehiwala', createdAt: iso(daysAgo(25)), creditBalance: 0, loyaltyPoints: 10 },
  ];

  const sales: Sale[] = [];
  const cashiers = [users[0], users[1], users[2]];
  const payments: PaymentMethod[] = ['cash', 'cash', 'cash', 'card', 'card', 'mobile', 'bank'];
  let billSeq = 1000;
  const saleCatalog = products.filter(p => ['p-chg25w', 'p-tglass', 'p-cable1m', 'p-sd128', 'p-jbl510', 'p-sonych520', 'p-ank10k', 'p-batip13', 'p-gala15', 'p-rn13', 'p-ip13', 'p-bip5', 'p-ids3', 'p-hpp15'].includes(p.id));

  const makeSale = (date: Date, idx: number): Sale => {
    const nItems = 1 + Math.floor(rng() * 3);
    const picked = new Set<number>();
    const items: Sale['items'] = [];
    for (let i = 0; i < nItems; i++) {
      let pi = Math.floor(rng() * saleCatalog.length);
      while (picked.has(pi)) pi = Math.floor(rng() * saleCatalog.length);
      picked.add(pi);
      const p = saleCatalog[pi];
      const qty = p.price > 50000 ? 1 : 1 + Math.floor(rng() * 2);
      items.push({ productId: p.id, name: p.name, qty, price: p.price, cost: p.cost });
    }
    const subtotal = sell(items.reduce((s, it) => s + it.price * it.qty, 0));
    const discount = rng() > 0.75 ? sell(Math.min(2000, subtotal * 0.03)) : 0;
    const total = subtotal - discount;
    const profit = sell(items.reduce((s, it) => s + (it.price - it.cost) * it.qty, 0) - discount);
    const cashier = cashiers[Math.floor(rng() * cashiers.length)];
    const pay = payments[Math.floor(rng() * payments.length)];
    const cust = rng() > 0.55 ? customers[Math.floor(rng() * customers.length)] : undefined;
    const d = new Date(date);
    const billNo = `NFX-${dkey(d).replaceAll('-', '')}-${String(billSeq++).slice(-4)}`;
    const paid = pay === 'credit' ? Math.max(0, total - Math.round(total * 0.4)) : total;
    return {
      id: uid(), billNo, date: d.toISOString(), cashierId: cashier.id, cashierName: cashier.name,
      customerId: cust?.id, customerName: cust?.name || 'Walk-in customer',
      items, subtotal, discount, tax: 0, total, payment: pay,
      amountPaid: paid, change: pay === 'credit' ? 0 : 0, profit,
      status: idx === 7 ? 'refunded' : 'completed',
    };
  };

  for (let d = 45; d >= 1; d--) {
    const count = d % 7 === 0 ? 0 : 1 + Math.floor(rng() * 3);
    for (let i = 0; i < count; i++) sales.push(makeSale(daysAgo(d, 9 + Math.floor(rng() * 9)), d));
  }
  sales.push(makeSale(daysAgo(0, 9), 0), makeSale(daysAgo(0, 11), 0), makeSale(daysAgo(0, 13), 0));
  sales.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  billSeq += 3;

  const purchases: Purchase[] = [
    {
      id: 'po-1', poNo: 'PO-0001', date: iso(daysAgo(21)), supplierId: 's-mwi', supplierName: 'Mobile World Imports',
      items: [
        { productId: 'p-gala15', name: 'Samsung Galaxy A15 5G', qty: 10, cost: 62000 },
        { productId: 'p-rn13', name: 'Xiaomi Redmi Note 13', qty: 12, cost: 68500 },
      ], total: 10 * 62000 + 12 * 68500, status: 'received',
    },
    {
      id: 'po-2', poNo: 'PO-0002', date: iso(daysAgo(9)), supplierId: 's-pcb', supplierName: 'Power Cell Batteries Ltd',
      items: [
        { productId: 'p-chg25w', name: 'USB-C Fast Charger 25W', qty: 40, cost: 2800 },
        { productId: 'p-ank10k', name: 'Anker PowerCore 10000', qty: 15, cost: 9800 },
      ], total: 40 * 2800 + 15 * 9800, status: 'received',
    },
    {
      id: 'po-3', poNo: 'PO-0003', date: iso(daysAgo(2)), supplierId: 's-tdl', supplierName: 'Tech Distributors Lanka',
      items: [
        { productId: 'p-ids3', name: 'Lenovo IdeaPad Slim 3', qty: 4, cost: 168000 },
        { productId: 'p-sd128', name: 'SanDisk microSD 128GB', qty: 20, cost: 5400 },
      ], total: 4 * 168000 + 20 * 5400, status: 'pending',
    },
  ];

  const expenses: Expense[] = [];
  const expSeed: [string, string, number][] = [
    ['Rent', 'Shop rent - monthly', 55000], ['Utilities', 'Electricity bill', 12800], ['Salary', 'Staff salary advance', 40000],
    ['Transport', 'Stock pickup - Panchikawatte', 3500], ['Utilities', 'Internet & phone', 5900], ['Supplies', 'Receipt rolls & bags', 4200],
    ['Marketing', 'Facebook boost - new arrivals', 7500], ['Maintenance', 'Counter display repair', 9500], ['Utilities', 'Water bill', 1850],
    ['Transport', 'Courier - islandwide orders', 6200],
  ];
  expSeed.forEach(([category, note, amount], i) => expenses.push({ id: uid(), date: iso(daysAgo(28 - i * 3, 14)), category, note, amount, by: 'Shop Administrator' }));

  const kitItems = [
    { id: 'kit-phone-starter-cable', kitProductId: 'p-kit', componentProductId: 'p-usbc', qty: 1 },
    { id: 'kit-phone-starter-glass', kitProductId: 'p-kit', componentProductId: 'p-tglass', qty: 1 },
    { id: 'kit-phone-starter-case', kitProductId: 'p-kit', componentProductId: 'p-phonecase', qty: 1 },
  ];

  const exchanges: Exchange[] = [{
    id: uid(), exNo: 'EX-0001', date: iso(daysAgo(6)), billNo: sales[5]?.billNo || 'NFX-20260101-1006',
    customerName: 'Walk-in customer', reason: 'Charger port loose contact',
    items: [{ productId: 'p-chg25w', name: 'USB-C Fast Charger 25W', qty: 1, amount: 4950 }], refund: 0, additional: 0, by: 'Nimal Perera',
  }];

  const audit: AuditEntry[] = [
    { id: uid(), time: iso(daysAgo(1, 17, 40)), user: 'admin@nexfixsolution.com', action: 'DELETE', entity: 'Customer', details: 'Deleted customer Kapila' },
    { id: uid(), time: iso(daysAgo(1, 17, 34)), user: 'admin@nexfixsolution.com', action: 'CREATE', entity: 'Customer', details: 'Created customer Kapila' },
    { id: uid(), time: iso(daysAgo(1, 9, 2)), user: 'cashier@nexfixsolution.com', action: 'LOGIN', entity: 'Auth', details: 'Cashier signed in' },
    { id: uid(), time: iso(daysAgo(2, 18, 20)), user: 'admin@nexfixsolution.com', action: 'UPDATE', entity: 'Product', details: 'Adjusted stock for USB-C Fast Charger 25W' },
    { id: uid(), time: iso(daysAgo(2, 10, 5)), user: 'admin@nexfixsolution.com', action: 'RECEIVE', entity: 'Purchase', details: 'Received PO-0002 from Power Cell Batteries Ltd' },
  ];

  const settings: Settings = {
    shopName: 'NEXFIX Solution', tagline: 'POS & Inventory Management System', address: 'No 45, Galle Road, Colombo 04, Sri Lanka',
    phone: '+94 74 109 7350', email: 'info@nexfixsolution.com', receiptFooter: 'Thank you for shopping with us! 3-day exchange policy applies.',
    taxDefault: 0, lowStockDefault: 5, exchangeDays: 3, openingFloat: 10000, adminPinHash: hashPin(DEMO_ADMIN_PASSWORD),
    whatsappReceipts: false, categories: [...DEFAULT_CATEGORIES], brands: [...DEFAULT_BRANDS], repairWarrantyDays: 30,
    invoiceTitle: 'INVOICE', invoiceSubtitle: 'COMPUTER & PHONE SHOP', invoiceCurrency: 'Rs.', invoiceTaxLabel: 'Tax',
    invoiceTerms: 'Warranty and return conditions are subject to the shop policy.\nKeep this invoice for warranty and future reference.',
    invoiceFooter: 'Thank you for your purchase!', invoiceShowTax: true, taxRegistrationNo: '', invoicePlaceOfSupply: '',
  };

  const adminAll: Record<string, boolean> = {};
  PERMISSION_KEYS.forEach(k => (adminAll[k.key] = true));
  const cashierPerms: Record<string, boolean> = { ...DEFAULT_ROLE_PERMISSIONS.cashier };
  const permissions: Permissions = { admin: adminAll, cashier: cashierPerms, manager: { ...DEFAULT_ROLE_PERMISSIONS.manager }, technician: { ...DEFAULT_ROLE_PERMISSIONS.technician } };

  const sessions: DaySession[] = [{ id: uid(), cashierId: 'u-nimal', cashierName: 'Nimal Perera', date: dkey(daysAgo(0)), opening: 10000, closed: false }];

  const units: InventoryUnit[] = [
    { id: 'u-ip13-1', productId: 'p-ip13', imei: '356938035643809', serial: 'DNQGX1A2JCLF', status: 'in_stock', cost: 185000, createdAt: iso(daysAgo(20)) },
    { id: 'u-ip13-2', productId: 'p-ip13', imei: '356938035643810', serial: 'DNQGX1A2JCLG', status: 'in_stock', cost: 185000, createdAt: iso(daysAgo(20)) },
    { id: 'u-rn13-1', productId: 'p-rn13', imei: '869884040001234', status: 'in_stock', cost: 42000, createdAt: iso(daysAgo(15)) },
    { id: 'u-rn13-2', productId: 'p-rn13', imei: '869884040001235', status: 'sold', saleId: 'seed-sold', saleBillNo: 'NFX-SEED', cost: 42000, createdAt: iso(daysAgo(15)), soldAt: iso(daysAgo(5)) },
    { id: 'u-gala15-1', productId: 'p-gala15', imei: '359299450012345', status: 'in_stock', cost: 78000, createdAt: iso(daysAgo(10)) },
    { id: 'u-ank-1', productId: 'p-ank10k', serial: 'ANK-2025-001', expiryDate: iso(daysAgo(-400)).slice(0, 10), status: 'in_stock', cost: 3200, createdAt: iso(daysAgo(30)) },
    { id: 'u-ank-2', productId: 'p-ank10k', serial: 'ANK-2024-088', expiryDate: iso(daysAgo(20)).slice(0, 10), status: 'in_stock', cost: 3200, createdAt: iso(daysAgo(60)), note: 'Near expiry' },
  ];

  const repairs: RepairJob[] = [
    {
      id: 'rj-1', jobNo: 'JOB-0001', customerId: 'c-kasun', customerName: 'Kasun Rajapaksha', customerPhone: '+94 77 123 4567',
      deviceType: 'Phone', deviceBrand: 'Apple', deviceModel: 'iPhone 13', imei: '356938035640001', fault: 'Screen cracked after drop',
      notifyReadyNote: undefined,
      diagnosis: 'LCD + digitizer replacement needed', parts: [{ name: 'iPhone 13 LCD assembly', qty: 1, cost: 28000, productId: 'p-ids3' }],
      laborCost: 3500, status: 'in_repair', receivedAt: iso(daysAgo(3, 11, 20)), promisedAt: iso(daysAgo(-2)).slice(0, 10),
      technicianId: 'u-sithum', technicianName: 'Sithum Eranga', warrantyDays: 30, advancePaid: 10000, by: 'Nimal Perera',
    },
    {
      id: 'rj-2', jobNo: 'JOB-0002', customerName: 'Walk-in Customer', customerPhone: '+94 71 555 0199', deviceType: 'Laptop', deviceBrand: 'HP',
      deviceModel: 'Pavilion 15', serial: '5CD1234ABC', fault: 'No power / dead battery', diagnosis: 'Battery swollen — replace battery + clean ports', notifyReadyNote: undefined,
      parts: [{ name: 'HP Pavilion battery', qty: 1, cost: 12500 }], laborCost: 2500, status: 'ready', receivedAt: iso(daysAgo(7, 14, 0)),
      promisedAt: iso(daysAgo(1)).slice(0, 10), completedAt: iso(daysAgo(1, 16, 30)), technicianName: 'Sithum Eranga', warrantyDays: 30,
      advancePaid: 5000, by: 'Shop Administrator',
    },
    {
      id: 'rj-3', jobNo: 'JOB-0003', customerId: 'c-nimali', customerName: 'Nimali Fernando', customerPhone: '+94 71 234 5678', deviceType: 'Phone',
      deviceBrand: 'Samsung', deviceModel: 'Galaxy A15', imei: '359299450099999', fault: 'Charging port loose', notifyReadyNote: undefined, parts: [], laborCost: 1500, status: 'received',
      receivedAt: iso(daysAgo(0, 9, 45)), promisedAt: iso(daysAgo(-1)).slice(0, 10), warrantyDays: 14, by: 'Nimal Perera',
    },
  ];

  const enrichedProducts = products.map(p => {
    if (['p-ip13', 'p-rn13', 'p-gala15'].includes(p.id)) return { ...p, trackImei: true, warrantyMonths: p.id === 'p-ip13' ? 12 : 6 };
    if (p.id === 'p-ank10k') return { ...p, trackSerial: true, warrantyMonths: 12 };
    return p;
  });

  return {
    products: enrichedProducts, customers, suppliers, sales, purchases, expenses, exchanges,
    users, audit, held: [], sessions, settings, permissions,
    kitItems, quotations: [], warrantyClaims: [],
    counters: { bill: billSeq, po: 3, ex: 1, job: 3, quote: 0, claim: 0 }, units, repairs,
  };
}
