// ElectroPOS Pro — Core Types

export type Role = 'admin' | 'manager' | 'cashier' | 'technician';
export type UnitStatus = 'in_stock' | 'sold' | 'returned' | 'reserved' | 'defective' | 'in_repair';
export type SaleStatus = 'completed' | 'refunded' | 'partial_refund' | 'exchanged' | 'void';
export type PaymentMethod = 'cash' | 'card' | 'bank' | 'mobile' | 'credit' | 'points';
export type PurchaseStatus = 'draft' | 'ordered' | 'partial' | 'received' | 'cancelled';
export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired' | 'converted';
export type RepairStatus =
  | 'received' | 'diagnosed' | 'waiting_parts' | 'in_repair'
  | 'ready' | 'delivered' | 'cancelled';
export type ClaimStatus = 'open' | 'approved' | 'rejected' | 'replaced' | 'repaired' | 'closed';

export interface Profile {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  phone?: string;
  active: boolean;
  commission_pct?: number;
  created_at: string;
}

export interface Shop {
  id: string;
  name: string;
  tagline?: string;
  address?: string;
  phone?: string;
  email?: string;
  logo_url?: string;
  receipt_footer?: string;
  tax_rate: number;
  currency: string;
  low_stock_default: number;
  exchange_days: number;
  repair_warranty_days: number;
  loyalty_earn_div: number;
  loyalty_point_value: number;
  settings?: Record<string, unknown>;
}

export interface Category {
  id: string;
  shop_id: string;
  name: string;
  parent_id?: string;
  sort_order?: number;
}

export interface Brand {
  id: string;
  shop_id: string;
  name: string;
}

export interface ProductAttributes {
  resolution?: string;
  lens?: string;
  poe?: boolean;
  night_vision?: string;
  weatherproof?: string;
  power?: string;
  channels?: number;
  storage?: string;
  [key: string]: string | number | boolean | undefined;
}

export interface Product {
  id: string;
  shop_id: string;
  name: string;
  sku?: string;
  barcode?: string;
  category_id?: string;
  brand_id?: string;
  description?: string;
  cost: number;
  price: number;
  stock: number;
  reorder_level: number;
  track_imei: boolean;
  track_serial: boolean;
  track_expiry: boolean;
  warranty_months: number;
  is_kit: boolean;
  is_service: boolean;
  active: boolean;
  attributes: ProductAttributes;
  image_url?: string;
  supplier_id?: string;
  created_at: string;
  category_name?: string;
  brand_name?: string;
}

export interface KitItem {
  id: string;
  kit_product_id: string;
  component_product_id: string;
  qty: number;
  component_name?: string;
  component_stock?: number;
}

export interface InventoryUnit {
  id: string;
  shop_id: string;
  product_id: string;
  imei?: string;
  serial?: string;
  expiry_date?: string;
  status: UnitStatus;
  cost?: number;
  purchase_id?: string;
  sale_id?: string;
  sale_bill_no?: string;
  warranty_months?: number;
  warranty_expires_at?: string;
  note?: string;
  created_at: string;
  sold_at?: string;
  product_name?: string;
}

export interface Customer {
  id: string;
  shop_id: string;
  name: string;
  phone?: string;
  email?: string;
  nic?: string;
  address?: string;
  credit_balance: number;
  loyalty_points: number;
  notes?: string;
  created_at: string;
}

export interface Supplier {
  id: string;
  shop_id: string;
  name: string;
  contact_person?: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  created_at: string;
}

export interface SaleItem {
  product_id?: string;
  name: string;
  qty: number;
  price: number;
  cost: number;
  discount?: number;
  price_overridden?: boolean;
  warranty_months?: number;
  unit_ids?: string[];
  imeis?: string[];
  serials?: string[];
}

export interface PaymentLeg {
  method: PaymentMethod;
  amount: number;
}

export interface Sale {
  id: string;
  shop_id: string;
  bill_no: string;
  customer_id?: string;
  customer_name: string;
  cashier_id?: string;
  cashier_name?: string;
  salesman_id?: string;
  items: SaleItem[];
  subtotal: number;
  discount: number;
  tax: number;
  shipping?: number;
  total: number;
  amount_paid: number;
  change_amount: number;
  profit: number;
  points_earned?: number;
  points_redeemed?: number;
  payments?: PaymentLeg[];
  status: SaleStatus;
  note?: string;
  created_at: string;
}

export interface Quotation {
  id: string;
  shop_id: string;
  quote_no: string;
  customer_id?: string;
  customer_name?: string;
  customer_phone?: string;
  status: QuoteStatus;
  items: { product_id?: string; name: string; qty: number; price: number; discount?: number }[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  valid_until?: string;
  notes?: string;
  converted_sale_id?: string;
  created_by?: string;
  created_at: string;
}

export interface RepairPart {
  product_id?: string;
  name: string;
  qty: number;
  cost: number;
}

export interface RepairJob {
  id: string;
  shop_id: string;
  job_no: string;
  customer_id?: string;
  customer_name: string;
  customer_phone?: string;
  device_type: string;
  device_brand?: string;
  device_model?: string;
  imei?: string;
  serial?: string;
  fault: string;
  diagnosis?: string;
  parts: RepairPart[];
  labor_cost: number;
  status: RepairStatus;
  received_at: string;
  promised_at?: string;
  completed_at?: string;
  delivered_at?: string;
  technician_id?: string;
  technician_name?: string;
  warranty_days: number;
  advance_paid: number;
  notes?: string;
  created_by?: string;
  created_at: string;
}

export interface WarrantyClaim {
  id: string;
  shop_id: string;
  claim_no: string;
  unit_id?: string;
  sale_id?: string;
  customer_id?: string;
  product_name?: string;
  imei_or_serial?: string;
  issue_description: string;
  status: ClaimStatus;
  resolution_notes?: string;
  created_by?: string;
  created_at: string;
  closed_at?: string;
}

export interface Expense {
  id: string;
  shop_id: string;
  category: string;
  note?: string;
  amount: number;
  expense_date: string;
  created_by?: string;
  created_at: string;
}

export interface DaySession {
  id: string;
  shop_id: string;
  cashier_id: string;
  cashier_name?: string;
  session_date: string;
  opening: number;
  closing?: number;
  closed: boolean;
  note?: string;
}

export interface AuditEntry {
  id: string;
  shop_id?: string;
  user_id?: string;
  user_email?: string;
  action: string;
  entity: string;
  details?: string;
  created_at: string;
}

export interface CartLine {
  product: Product;
  qty: number;
  price: number;
  discount: number;
  unitIds: string[];
  note?: string;
}
