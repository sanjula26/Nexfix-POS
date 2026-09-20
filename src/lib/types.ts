import type { InventoryTransaction } from './inventoryLedger';
import type { SupplierPayment } from './supplierPayments';

export type Role = 'admin' | 'cashier' | 'technician' | 'manager';
export interface AppUser { id:string; name:string; email:string; password:string; role:Role; active:boolean; createdAt:string; commissionPct?:number; mustChangePassword?:boolean; }
export interface ProductAttributes { resolution?:string; lens?:string; poe?:boolean; nightVision?:string; weatherproof?:string; power?:string; channels?:number; storage?:string; [key:string]:string|number|boolean|undefined; }
export interface Product { id:string; name:string; sku:string; barcode:string; category:string; brand:string; cost:number; price:number; stock:number; reorderLevel:number; trackImei:boolean; trackSerial?:boolean; trackExpiry?:boolean; warrantyMonths?:number; isKit?:boolean; isService?:boolean; attributes?:ProductAttributes; supplierId?:string; active:boolean; createdAt:string; }
export interface KitItem { id:string; kitProductId:string; componentProductId:string; qty:number; }
export type UnitStatus='in_stock'|'sold'|'returned'|'reserved'|'defective'|'in_repair';
export interface InventoryUnit { id:string; productId:string; imei?:string; serial?:string; expiryDate?:string; status:UnitStatus; purchaseId?:string; saleId?:string; saleBillNo?:string; cost?:number; note?:string; createdAt:string; soldAt?:string; warrantyExpiresAt?:string; }
export interface Customer { id:string; name:string; phone:string; email?:string; nic?:string; tin?:string; address?:string; createdAt:string; creditBalance:number; loyaltyPoints:number; creditLimit?:number; }
export interface Supplier { id:string; name:string; contactPerson?:string; phone:string; email?:string; address?:string; createdAt:string; }
export interface SaleItem { productId:string; name:string; qty:number; price:number; cost:number; discount?:number; priceOverridden?:boolean; unitIds?:string[]; imeis?:string[]; serials?:string[]; warrantyMonths?:number; }
export type PaymentMethod='cash'|'card'|'bank'|'mobile'|'credit';
export interface PaymentLeg { method:PaymentMethod; amount:number }
export interface Sale { id:string; billNo:string; date:string; cashierId:string; cashierName:string; machineId?:string; machineName?:string; customerId?:string; customerName:string; items:SaleItem[]; subtotal:number; discount:number; tax:number; total:number; payment:PaymentMethod; payments?:PaymentLeg[]; shipping?:number; pointsRedeemed?:number; pointsEarned?:number; note?:string; amountPaid:number; change:number; profit:number; status:'completed'|'refunded'|'reversed'|'exchanged'; }
export interface PurchaseItem { productId:string; name:string; qty:number; cost:number; expiryDate?:string; sellingPrice?:number; sellDiscountPct?:number; sellDiscountAmt?:number; updateSellingPrice?:boolean; }
export interface Purchase { id:string; poNo:string; date:string; supplierId:string; supplierName:string; items:PurchaseItem[]; total:number; status:'pending'|'received'; supplierInvoiceNo?:string; notes?:string; processedAt?:string; processedBy?:string; }

export interface PurchaseReturnItem { itemIdx:number; productId:string; name:string; qty:number; cost:number; total:number; }
export interface PurchaseReturn { id:string; dnNo:string; purchaseId:string; poNo:string; supplierId:string; supplierName:string; date:string; items:PurchaseReturnItem[]; total:number; reason:string; by:string; }

// ── GRN (Goods Received Note) ──────────────────────────────────────────────
export interface GRNItem {
  productId: string;
  itemCode: string;
  description: string;
  costPrice: number;
  sellingPrice: number;
  sellDiscountPct: number;
  sellDiscountAmt: number;
  quantity: number;
  total: number;
  imeis?: string[];
}
export interface GRN {
  id: string;
  grnNumber: string;
  supplierId: string;
  supplierName: string;
  supplierInvoiceNo: string;
  date: string;
  status: 'draft' | 'processed';
  items: GRNItem[];
  totalCost: number;
  notes?: string;
  createdBy: string;
  processedAt?: string;
  processedBy?: string;
}
// ─────────────────────────────────────────────────────────────────────────────

export interface Expense { id:string; date:string; category:string; note:string; amount:number; by:string; periodStart?:string; periodEnd?:string; }
export interface ExchangeItem { productId:string; name:string; qty:number; amount:number; itemIdx?:number }
export interface Exchange { id:string; exNo:string; date:string; billNo:string; customerName:string; reason:string; items:ExchangeItem[]; refund:number; additional:number; by:string; }
export interface AuditEntry { id:string; time:string; user:string; action:string; entity:string; details:string; }
export interface HeldLine { productId:string; qty:number; unitIds?:string[] }
export interface HeldSale { id:string; label:string; heldAt:string; customerId?:string; lines:HeldLine[]; discount:number; taxPct:number; }
export interface DaySession { id:string; cashierId:string; cashierName:string; date:string; opening:number; closed:boolean; closing?:number; note?:string; }
export type RepairStatus='received'|'diagnosed'|'waiting_parts'|'in_repair'|'ready'|'delivered'|'cancelled';
export interface RepairPart { productId?:string; name:string; qty:number; cost:number; }
export interface RepairJob { id:string; jobNo:string; customerId?:string; customerName:string; customerPhone?:string; deviceType:string; deviceBrand:string; deviceModel:string; imei?:string; serial?:string; fault:string; diagnosis?:string; parts:RepairPart[]; laborCost:number; status:RepairStatus; receivedAt:string; promisedAt?:string; completedAt?:string; deliveredAt?:string; technicianId?:string; technicianName?:string; warrantyDays?:number; note?:string; advancePaid?:number; by:string; }
export type QuoteStatus='draft'|'sent'|'accepted'|'rejected'|'expired'|'converted';
export interface QuotationItem { productId?:string; name:string; qty:number; price:number; discount?:number; }
export interface Quotation { id:string; quoteNo:string; customerId?:string; customerName:string; customerPhone?:string; status:QuoteStatus; items:QuotationItem[]; subtotal:number; discount:number; tax:number; total:number; validUntil?:string; notes?:string; convertedSaleId?:string; createdAt:string; by:string; }
export type ClaimStatus='open'|'approved'|'rejected'|'replaced'|'repaired'|'closed';
export interface WarrantyClaim { id:string; claimNo:string; unitId?:string; saleId?:string; saleBillNo?:string; customerId?:string; customerName?:string; productName:string; imeiOrSerial?:string; issueDescription:string; status:ClaimStatus; resolutionNotes?:string; createdAt:string; closedAt?:string; by:string; }
export interface Promotion { id:string; name:string; category:string; discountPct:number; startDate?:string; endDate?:string; active?:boolean; }
export interface Settings { shopName:string; tagline:string; address:string; phone:string; email:string; receiptFooter:string; taxDefault:number; lowStockDefault:number; exchangeDays:number; openingFloat:number; loyaltyPointsPerRs?:number; loyaltyPointValue?:number; adminPinHash:string; whatsappReceipts:boolean; categories?:string[]; brands?:string[]; repairWarrantyDays?:number; invoiceTitle?:string; invoiceSubtitle?:string; invoiceCurrency?:string; invoiceTaxLabel?:string; invoiceTerms?:string; invoiceFooter?:string; invoiceShowTax?:boolean; taxRegistrationNo?:string; invoicePlaceOfSupply?:string; promotions?:Promotion[]; }
export interface Permissions { admin:Record<string,boolean>; cashier:Record<string,boolean>; technician?:Record<string,boolean>; manager?:Record<string,boolean>; }
export interface Counters { bill:number; po:number; ex:number; job:number; quote:number; claim:number; grn?:number; dn?:number; }
export interface ReverseRequest { id:string; saleId:string; billNo:string; reason:string; requestedBy:string; requestedAt:string; status:'pending'|'approved'|'rejected'; reviewedBy?:string; reviewedAt?:string; reviewNote?:string; }
export interface POSState { products:Product[]; customers:Customer[]; suppliers:Supplier[]; sales:Sale[]; purchases:Purchase[]; expenses:Expense[]; exchanges:Exchange[]; purchaseReturns?:PurchaseReturn[]; users:AppUser[]; audit:AuditEntry[]; held:HeldSale[]; sessions:DaySession[]; settings:Settings; permissions:Permissions; kitItems?:KitItem[]; quotations?:Quotation[]; warrantyClaims?:WarrantyClaim[]; counters:Counters; units:InventoryUnit[]; repairs:RepairJob[]; inventoryTransactions?:InventoryTransaction[]; supplierPayments?:SupplierPayment[]; grns?:GRN[]; reverseRequests?:ReverseRequest[]; }