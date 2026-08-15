export type Role = 'admin' | 'cashier' | 'technician' | 'manager';

export interface AppUser {
  id: string;
  name: string;
  email: string;
  password: string;
  role: Role;
  active: boolean;
  createdAt: string;
  commissionPct?: number;
}

/** CCTV / custom product attributes */
export interface ProductAttributes {
  resolution?: string;
  lens?: string;
  poe?: boolean;
  nightVision?: string;
  weatherproof?: string;
  power?: string;
  channels?: number;
  storage?: string;
  [key: string]: string | number | boolean | undefined;
}

export interface Product {
  id: string;
  name: string;
  sku: string;
  barcode: string;
  category: string;
  brand: string;
  cost: number;
  price: number;
  stock: number;
  reorderLevel: number;
  trackImei: boolean;
  /** track serial numbers (laptops, etc.) even without full IMEI */
  trackSerial?: boolean;
  trackExpiry?: boolean;
  /** default warranty in months for this product */
  warrantyMonths?: number;
  /** Kit / Bundle product (BOM components in kitItems) */
  isKit?: boolean;
  isService?: boolean;
  attributes?: ProductAttributes;
  supplierId?: string;
  active: boolean;
  createdAt: string;
}

/** Bill of Materials line for kit products */
export interface KitItem {
  id: string;
  kitProductId: string;
  componentProductId: string;
  qty: number;
}

/** Individual sellable unit with IMEI / serial / expiry */
export type UnitStatus = 'in_stock' | 'sold' | 'returned' | 'reserved' | 'defective' | 'in_repair';

export interface InventoryUnit {
  id: string;
  productId: string;
  imei?: string;
  serial?: string;
  /** ISO date — for batteries, accessories with shelf life */
  expiryDate?: string;
  status: UnitStatus;
  purchaseId?: string;
  saleId?: string;
  saleBillNo?: string;
  cost?: number;
  note?: string;
  createdAt: string;
  soldAt?: string;
  /** warranty end date calculated at sale */
  warrantyExpiresAt?: string;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email?: string;
  nic?: string;
  address?: string;
  createdAt: string;
  creditBalance: number;
  loyaltyPoints: number;
}

export interface Supplier {
  id: string;
  name: string;
  contactPerson?: string;
  phone: string;
  email?: string;
  address?: string;
  createdAt: string;
}

export interface SaleItem {
  productId: string;
  name: string;
  qty: number;
  price: number;
  cost: number;
  /** flat Rs discount applied to this line */
  discount?: number;
  /** true when the unit price was manually overridden */
  priceOverridden?: boolean;
  /** IMEI/serial of units sold on this line */
  unitIds?: string[];
  imeis?: string[];
  serials?: string[];
  warrantyMonths?: number;
}

export type PaymentMethod = 'cash' | 'card' | 'bank' | 'mobile' | 'credit';

export interface PaymentLeg { method: PaymentMethod; amount: number }

export interface Sale {
  id: string;
  billNo: string;
  date: string; // ISO
  cashierId: string;
  cashierName: string;
  customerId?: string;
  customerName: string;
  items: SaleItem[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  payment: PaymentMethod;
  /** present when the bill was paid with multiple methods */
  payments?: PaymentLeg[];
  shipping?: number;
  /** loyalty points (not Rs) redeemed on this bill */
  pointsRedeemed?: number;
  pointsEarned?: number;
  /** free-text bill note (gift packing, delivery instructions...) */
  note?: string;
  amountPaid: number;
  change: number;
  profit: number;
  status: 'completed' | 'refunded' | 'exchanged';
}

export interface PurchaseItem {
  productId: string;
  name: string;
  qty: number;
  cost: number;
  /** optional bulk expiry for this line */
  expiryDate?: string;
}

export interface Purchase {
  id: string;
  poNo: string;
  date: string;
  supplierId: string;
  supplierName: string;
  items: PurchaseItem[];
  total: number;
  status: 'pending' | 'received';
}

export interface Expense {
  id: string;
  date: string;
  category: string;
  note: string;
  amount: number;
  by: string;
}

export interface ExchangeItem { productId: string; name: string; qty: number; amount: number }

export interface Exchange {
  id: string;
  exNo: string;
  date: string;
  billNo: string;
  customerName: string;
  reason: string;
  items: ExchangeItem[];
  refund: number;
  additional: number;
  by: string;
}

export interface AuditEntry {
  id: string;
  time: string;
  user: string;
  action: string;
  entity: string;
  details: string;
}

export interface HeldLine { productId: string; qty: number; unitIds?: string[] }

export interface HeldSale {
  id: string;
  label: string;
  heldAt: string;
  customerId?: string;
  lines: HeldLine[];
  discount: number;
  taxPct: number;
}

export interface DaySession {
  id: string;
  cashierId: string;
  cashierName: string;
  date: string; // yyyy-mm-dd
  opening: number;
  closed: boolean;
  closing?: number;
  note?: string;
}

/* -------------------- Repairs / Service Jobs -------------------- */

export type RepairStatus =
  | 'received'
  | 'diagnosed'
  | 'waiting_parts'
  | 'in_repair'
  | 'ready'
  | 'delivered'
  | 'cancelled';

export interface RepairPart {
  productId?: string;
  name: string;
  qty: number;
  cost: number;
}

export interface RepairJob {
  id: string;
  jobNo: string;
  customerId?: string;
  customerName: string;
  customerPhone?: string;
  deviceType: string; // Phone / Laptop / Desktop / Tablet / CCTV / Other
  deviceBrand: string;
  deviceModel: string;
  imei?: string;
  serial?: string;
  fault: string;
  diagnosis?: string;
  parts: RepairPart[];
  laborCost: number;
  status: RepairStatus;
  receivedAt: string;
  promisedAt?: string;
  completedAt?: string;
  deliveredAt?: string;
  technicianId?: string;
  technicianName?: string;
  warrantyDays?: number;
  note?: string;
  advancePaid?: number;
  by: string;
}

/* -------------------- Quotations -------------------- */
export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired' | 'converted';

export interface QuotationItem {
  productId?: string;
  name: string;
  qty: number;
  price: number;
  discount?: number;
}

export interface Quotation {
  id: string;
  quoteNo: string;
  customerId?: string;
  customerName: string;
  customerPhone?: string;
  status: QuoteStatus;
  items: QuotationItem[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  validUntil?: string;
  notes?: string;
  convertedSaleId?: string;
  createdAt: string;
  by: string;
}

/* -------------------- Warranty Claims -------------------- */
export type ClaimStatus = 'open' | 'approved' | 'rejected' | 'replaced' | 'repaired' | 'closed';

export interface WarrantyClaim {
  id: string;
  claimNo: string;
  unitId?: string;
  saleId?: string;
  saleBillNo?: string;
  customerId?: string;
  customerName?: string;
  productName: string;
  imeiOrSerial?: string;
  issueDescription: string;
  status: ClaimStatus;
  resolutionNotes?: string;
  createdAt: string;
  closedAt?: string;
  by: string;
}

export interface Settings {
  shopName: string;
  tagline: string;
  address: string;
  phone: string;
  email: string;
  receiptFooter: string;
  taxDefault: number;
  lowStockDefault: number;
  exchangeDays: number;
  openingFloat: number;
  /** hashed password for the CASHIER → ADMIN role switch */
  adminPinHash: string;
  /** auto-open WhatsApp with the receipt text after checkout */
  whatsappReceipts: boolean;
  /** managed product categories */
  categories?: string[];
  /** managed brands */
  brands?: string[];
  /** default repair warranty days */
  repairWarrantyDays?: number;
}

export interface Permissions {
  admin: Record<string, boolean>;
  cashier: Record<string, boolean>;
}

export interface Counters {
  bill: number;
  po: number;
  ex: number;
  job: number;
  quote: number;
  claim: number;
}

export interface POSState {
  products: Product[];
  customers: Customer[];
  suppliers: Supplier[];
  sales: Sale[];
  purchases: Purchase[];
  expenses: Expense[];
  exchanges: Exchange[];
  users: AppUser[];
  audit: AuditEntry[];
  held: HeldSale[];
  sessions: DaySession[];
  settings: Settings;
  permissions: Permissions;
  kitItems?: KitItem[];
  quotations?: Quotation[];
  warrantyClaims?: WarrantyClaim[];
  counters: Counters;
  /** Phase 3 */
  units: InventoryUnit[];
  repairs: RepairJob[];
}
