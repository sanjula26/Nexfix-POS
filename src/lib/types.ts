export type Role = 'admin' | 'cashier' | 'technician' | 'manager';

export interface AppUser { id:string; name:string; email:string; password:string; role:Role; active:boolean; createdAt:string; commissionPct?:number; }
export interface ProductAttributes { resolution?:string; lens?:string; poe?:boolean; nightVision?:string; weatherproof?:string; power?:string; channels?:number; storage?:string; [key:string]:string|number|boolean|undefined; }
export interface Product { id:string; name:string; sku:string; barcode:string; category:string; brand:string; cost:number; price:number; stock:number; reorderLevel:number; trackImei:boolean; trackSerial?:boolean; trackExpiry?:boolean; warrantyMonths?:number; isKit?:boolean; isService?:boolean; attributes?:ProductAttributes; supplierId?:string; active:boolean; createdAt:string; }
export interface KitItem { id:string; kitProductId:string; componentProductId:string; qty:number; }
export type UnitStatus='in_stock'|'sold'|'returned'|'reserved'|'defective'|'in_repair';
export interface InventoryUnit { id:string; productId:string; imei?:string; serial?:string; expiryDate?:string; status:UnitStatus; purchaseId?:string; saleId?:string; saleBillNo?:string; cost?:number; note?:string; createdAt:string; soldAt?:string; warrantyExpiresAt?:string; }
export interface Customer { id:string; name:string; phone:string; email?:string; nic?:string; address?:string; createdAt:string; creditBalance:number; loyaltyPoints:number; }
export interface Supplier { id:string; name:string; contactPerson?:string; phone:string; email?:string; address?:string; createdAt:string; }
export interface SaleItem { productId?:string; name:string; qty:number; price:number; cost?:number; discount?:number; priceOverridden?:boolean; unitIds?:string[]; imeis?:string[]; serials?:string[]; warrantyMonths?:number; }
export type PaymentMethod='cash'|'card'|'bank'|'mobile'|'credit';
export interface PaymentLeg { method:PaymentMethod; amount:number; }
export interface Sale { id:string; billNo:string; date:string; cashierId:string; cashierName:string; customerId?:string; customerName:string; items:SaleItem[]; subtotal:number; discount:number; tax:number; total:number; payment:PaymentMethod; payments?:PaymentLeg[]; shipping?:number; pointsRedeemed?:number; pointsEarned?:number; note?:string; amountPaid:number; change:number; profit:number; status:'completed'|'refunded'|'exchanged'; }
export interface PurchaseItem { productId:string; name:string; qty:number; cost:number; expiryDate?:string; }
export interface Purchase { id:string; poNo:string; date:string; supplierId?:string; supplierName:string; items:PurchaseItem[]; subtotal?:number; tax?:number; total:number; status:string; notes?:string; }
export interface Expense { id:string; date:string; category:string; amount:number; note?:string; by:string; }
export interface Exchange { id:string; date:string; saleId?:string; exNo?:string; billNo?:string; fromProductId?:string; toProductId?:string; reason?:string; items?:SaleItem[]; refund?:number; note?:string; by:string; }
export interface AuditEntry { id:string; date?:string; time?:string; action:string; entity:string; details:string; by?:string; user?:string; }
export interface HeldSale { id:string; createdAt?:string; heldAt?:string; by:string; label?:string; items?:SaleItem[]; lines?:Array<{productId:string;qty:number;price?:number;discount?:number}>; customerId?:string; discount?:number; taxPct?:number; }
export interface DaySession { id?:string; cashierId:string; date:string; opening:number; closing?:number; closed:boolean; note?:string; }
export type QuoteStatus='draft'|'sent'|'accepted'|'rejected'|'converted'|'expired';
export type QuotationItem=SaleItem;
export interface Quotation { id:string; quoteNo:string; date:string; customerName:string; customerPhone?:string; items:QuotationItem[]; subtotal:number; discount:number; tax:number; total:number; notes?:string; convertedSaleId?:string; status?:QuoteStatus; createdAt:string; by:string; }
export type ClaimStatus='open'|'approved'|'rejected'|'replaced'|'repaired'|'closed';
export interface WarrantyClaim { id:string; claimNo:string; unitId?:string; saleId?:string; saleBillNo?:string; customerId?:string; customerName?:string; productName:string; imeiOrSerial?:string; issueDescription:string; status:ClaimStatus; resolutionNotes?:string; createdAt:string; closedAt?:string; by:string; }
export type RepairStatus='received'|'diagnosing'|'waiting_parts'|'in_progress'|'ready'|'delivered'|'cancelled';
export interface RepairPart { id?:string; productId:string; name:string; qty:number; unitCost?:number; cost?:number; }
export interface RepairJob { id:string; jobNo:string; customerId?:string; customerName:string; phone?:string; customerPhone?:string; device?:string; deviceType?:string; deviceBrand?:string; deviceModel?:string; imeiOrSerial?:string; imei?:string; serial?:string; issue?:string; fault?:string; diagnosis?:string; status?:RepairStatus; warrantyDays?:number; receivedAt?:string; promisedAt?:string; completedAt?:string; deliveredAt?:string; laborCost?:number; advancePaid?:number; parts?:RepairPart[]; createdAt:string; updatedAt?:string; by:string; }
export interface Settings { shopName:string; tagline:string; address:string; phone:string; email:string; receiptFooter:string; taxDefault:number; lowStockDefault:number; exchangeDays:number; openingFloat:number; adminPinHash:string; whatsappReceipts:boolean; categories?:string[]; brands?:string[]; repairWarrantyDays?:number; }
export interface Permissions { admin:Record<string,boolean>; cashier:Record<string,boolean>; technician:Record<string,boolean>; manager:Record<string,boolean>; }
export interface Counters { bill:number; po:number; ex:number; job:number; quote:number; claim:number; }
export interface POSState { products:Product[]; customers:Customer[]; suppliers:Supplier[]; sales:Sale[]; purchases:Purchase[]; expenses:Expense[]; exchanges:Exchange[]; users:AppUser[]; audit:AuditEntry[]; held:HeldSale[]; sessions:DaySession[]; settings:Settings; permissions:Permissions; kitItems?:KitItem[]; quotations?:Quotation[]; warrantyClaims?:WarrantyClaim[]; counters:Counters; units:InventoryUnit[]; repairs:RepairJob[]; }
