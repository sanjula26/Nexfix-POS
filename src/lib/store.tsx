import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  POSState, Product, Customer, Supplier, KitItem, Sale, Purchase, Expense, Exchange,
  AppUser, AuditEntry, HeldSale, Settings, Permissions, Role, SaleItem, PaymentMethod, PaymentLeg, DaySession, ReverseRequest,
  InventoryUnit, RepairJob, RepairStatus, PurchaseReturn, PurchaseReturnItem, WarrantyClaim, ClaimStatus, TradeIn,
} from './types';
import { buildSeed, DEFAULT_CATEGORIES, DEFAULT_BRANDS, DEFAULT_ROLE_PERMISSIONS, PERMISSION_KEYS } from './seed';
import { dkey, uid, POINT_VALUE, hashPin, hashPassword, verifyPassword, isHashed, isPasswordHash, normalizeWhatsAppPhone, salePayments } from './utils';
import { hashPasswordAsync, verifyPasswordAsync } from './passwordAsync';
import { idbLoadState, idbSaveState, idbAvailable, idbGetMeta, idbSetMeta, idbListQueue, type BackupMeta } from './db';
import { downloadBackup, startAutoBackup, scheduleGoogleBackup } from './backup';
import {
  getConnectivity, onConnectivityChange, queueWrite, queueBranchStockAdjustment, queueInventoryUnitsAdd, queueInventoryUnitDelete, queueReturnCreate, queueSaleReversalRequest, queueSaleReversalApproval, queueSaleReversalRejection, queuePurchaseReceive, queueRepairDelivery, flushSyncQueue, registerServiceWorker,
  type Connectivity,
} from './offline';
import { syncToGoogleDrive, syncShopMetadataToGoogleDrive } from './driveSync';
import { getMachineIdentity } from './machine';
import { buildPurchaseReceivePlan, canDeletePurchase, validatePurchaseUnitIdentifiers } from './purchaseReconciliation';
import { appendInventoryTransaction, type InventoryTransaction } from './inventoryLedger';
import { allocateCreditPaymentFIFO, getOpenCreditInvoiceBalance, type CustomerCreditPayment } from './customerCredit';
import { calculateDayEndTotals } from './dayEnd';
import { addInventoryUnitsAtomic, deleteInventoryUnitAtomic, adjustBranchStockAtomic, completeSaleAtomic, ensureCloudShop, refreshCloudBranchStock, resolveCloudSalesmanId, registerTradeInAtomic, syncNormalizedCatalog, processSaleReturnAtomic, processPurchaseReturnAtomic, processRepairDeliveryAtomic, resolveSaleReturnLines, requestSaleReversal, approveSaleReversal, rejectSaleReversal, listSaleReversalRequests, receivePurchaseAtomic, getCloudShopId } from './cloudSync';
import { supabaseConfigured } from './supabase';
import { getCachedBranchStock, hasCachedBranchStock, hasMultipleCachedBranches, applyBranchStockDeltas, getDefaultBranchId } from './branchStock';


const STORE_KEY = 'nexfix_pos_v2';
const STORE_KEY_V1 = 'nexfix_pos_v1';
const SESSION_KEY = 'nexfix_session_v1';
const THEME_KEY = 'nexfix_theme';

interface Session { userId: string; remember: boolean }

interface NewSaleLine {
  productId: string;
  qty: number;
  discount?: number;
  price?: number;
  /** unit ids to mark sold (IMEI/serial tracked products) */
  unitIds?: string[];
}

function applyCategoryPromotions(lines: NewSaleLine[], products: readonly Product[], settings: Settings, now = new Date()): NewSaleLine[] {
  const promotions = Array.isArray(settings.promotions) ? settings.promotions : [];
  if (!promotions.length) return lines;
  const day = dkey(now);
  return lines.map(line => {
    const product = products.find(p => p.id === line.productId);
    if (!product) return line;
    const eligible = promotions.filter(p => {
      if (p.active === false) return false;
      if (p.category.trim().toLowerCase() !== product.category.trim().toLowerCase()) return false;
      if (p.startDate && day < p.startDate) return false;
      if (p.endDate && day > p.endDate) return false;
      return Number.isFinite(p.discountPct) && p.discountPct > 0 && p.discountPct <= 100;
    });
    if (!eligible.length) return line;
    const pct = Math.max(...eligible.map(p => p.discountPct));
    const unitPrice = line.price !== undefined && line.price >= 0 ? line.price : product.price;
    const gross = Math.max(0, unitPrice * line.qty);
    const manualDiscount = Math.min(Math.max(line.discount || 0, 0), gross);
    const promoDiscount = Math.round((gross - manualDiscount) * pct / 100 * 100) / 100;
    const discount = Math.min(gross, manualDiscount + promoDiscount);
    return { ...line, discount };
  });
}

interface NewSaleInput {
  lines: NewSaleLine[];
  customerId?: string;
  discount: number;
  taxPct: number;
  shipping?: number;
  pointsRedeemed?: number;
  payment: PaymentMethod;
  amountPaid: number;
  /** Remaining sale balance recorded as credit; tender legs represent only money received now. */
  creditDue?: number;
  payments?: PaymentLeg[];
  note?: string;
  tradeIn?: TradeIn;
  /** staff member credited with the sale (defaults to current user) */
  salesmanId?: string;
  _saleId?: string;
  _billNo?: string;
}

export type { NewSaleInput, PaymentLeg };

interface StoreCtx {
  state: POSState;
  user: AppUser | null;
  viewingAs: Role;
  dark: boolean;
  toggleTheme: () => void;
  can: (key: string) => boolean;
  /** true while the ADMIN unlock prompt is visible — the previous user's session is nullified (inert UI, no shortcuts) */
  adminPrompt: boolean;
  setAdminPrompt: (v: boolean) => void;
  signIn: (email: string, password: string, remember: boolean, expectedRole?: Extract<Role, 'admin' | 'cashier'>) => Promise<{ ok: boolean; error?: string }>;
  createInitialAdmin: (name: string, email: string, password: string, cashier?: { name: string; email: string; password: string }) => Promise<{ ok: boolean; error?: string }>;
  changePassword: (nextPassword: string) => Promise<{ ok: boolean; error?: string }>;
  changeManagedPassword: (targetUserId: string, nextPassword: string) => Promise<{ ok: boolean; error?: string }>;
  signOut: (force?: boolean) => void;
  /** Switching to the other POS role always authenticates the target account; admin → cashier uses cashier credentials, cashier → admin accepts the admin unlock PIN or admin login password. */
  switchRole: (role: Role, credential?: string, email?: string) => Promise<{ ok: boolean; error?: string }>;
  changeAdminPin: (current: string, next: string) => { ok: boolean; error?: string };
  /** verify the admin password without switching role (used for price overrides etc.) */
  verifyAdminPin: (pin: string, reason?: string) => boolean;
  /** Fresh admin confirmation for sensitive destructive/security actions. */
  confirmSensitiveAdmin: (reason: string) => Promise<boolean>;
  sensitiveAdminPrompt: { reason: string } | null;
  resolveSensitiveAdmin: (credential: string) => boolean;
  cancelSensitiveAdmin: () => void;
  unlockSession: (credential: string) => boolean;
  // products
  saveProduct: (p: Product) => Promise<boolean>;
  deleteProduct: (id: string) => void;
  saveKitItems: (items: KitItem[]) => void;
  saveQuotations: (quotations: import('./types').Quotation[], quoteCounter?: number) => void;
  adjustStock: (id: string, delta: number, reason: string) => Promise<boolean>;
  // customers / suppliers
  saveCustomer: (c: Customer) => void;
  deleteCustomer: (id: string) => void;
  saveSupplier: (s: Supplier) => void;
  deleteSupplier: (id: string) => void;
  saveSupplierPayment: (p: Omit<import('./supplierPayments').SupplierPayment, 'id' | 'date' | 'by'>) => import('./supplierPayments').SupplierPayment | null;
  deleteSupplierPayment: (id: string) => void;
  saveCustomerCreditPayment: (p: { customerId: string; amount: number; method: Exclude<PaymentMethod, 'credit'>; methods?: PaymentLeg[]; note?: string; saleId?: string }) => { ok: true; payment: CustomerCreditPayment } | { ok: false; error: string };
  // sales
  completeSale: (input: NewSaleInput) => Sale | null;
  completeSaleCloud: (input: NewSaleInput) => Promise<Sale | null>;
  refundSale: (saleId: string) => Promise<boolean>;
  requestBillReverse: (saleId: string, reason: string) => Promise<boolean>;
  approveBillReverse: (requestId: string) => Promise<boolean>;
  rejectBillReverse: (requestId: string, note?: string) => Promise<boolean>;
  // held
  holdSale: (h: Omit<HeldSale, 'id' | 'heldAt'>) => void;
  resumeHold: (id: string) => HeldSale | undefined;
  deleteHold: (id: string) => void;
  // purchases
  savePurchase: (p: Omit<Purchase, 'id' | 'poNo' | 'date' | 'status'>) => void;
  saveGRNDraft: (p: Omit<Purchase, 'id' | 'poNo' | 'date' | 'status'>) => { ok: boolean; purchase?: Purchase; error?: string };
  updateGRNDraft: (id: string, patch: Partial<Omit<Purchase, 'id' | 'poNo' | 'date' | 'status'>>) => { ok: boolean; error?: string };
  receivePurchase: (id: string, processorName?: string) => Promise<{ ok: boolean; error?: string }>;
  processGRN: (id: string, processorName: string) => Promise<{ ok: boolean; error?: string }>;
  createPurchaseReturn: (input: { purchaseId: string; lines: Array<{ itemIdx: number; qty: number; unitIds?: string[] }>; reason: string }) => Promise<PurchaseReturn | null>;
  deletePurchase: (id: string) => void;
  // expenses
  addExpense: (e: Omit<Expense, 'id' | 'date' | 'by'>) => void;
  deleteExpense: (id: string) => void;
  // exchanges
  processExchange: (saleId: string, returns: Array<{ itemIdx: number; qty: number }>, reason: string, mode: 'refund' | 'replace') => void;
  // users
  saveUser: (u: AppUser) => void;
  toggleUserActive: (id: string) => void;
  deleteUser: (id: string) => void;
  // admin
  setPermission: (role: Role, key: string, value: boolean) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  closeSession: (cashierId: string, counted: number, note: string) => boolean;
  /** Close every open cashier drawer for today after counted-cash reconciliation. */
  closeDay: (counts: Record<string, number>, note: string) => boolean;
  logAudit: (action: string, entity: string, details: string) => void;
  clearAudit: () => void;
  exportData: () => Promise<string>;
  importData: (json: string) => Promise<boolean>;
  resetData: () => void;
  /** Reload the current POS data without destroying the authenticated session or route. */
  refreshPOS: () => Promise<void>;
  /** Phase 2: connectivity + backup */
  connectivity: Connectivity;
  ready: boolean; // false while IndexedDB is loading
  backupMeta: BackupMeta;
  runManualBackup: () => Promise<{ ok: boolean; error?: string }>;
  refreshBackupMeta: () => Promise<void>;
  setAutoBackupHours: (hours: number) => Promise<void>;
  flushOfflineQueue: () => Promise<number>;
  pendingQueueCount: number;
  // Phase 3 — units & repairs
  saveUnit: (u: InventoryUnit) => Promise<boolean>;
  saveUnitsBulk: (units: InventoryUnit[], catalogProducts?: Product[]) => Promise<{ ok: boolean; added: number; errors: string[] }>;
  deleteUnit: (id: string) => Promise<boolean>;
  findUnitByCode: (code: string) => InventoryUnit | undefined;
  saveRepair: (r: RepairJob) => void;
  updateRepairStatus: (id: string, status: RepairStatus, patch?: Partial<RepairJob>) => void;
  deleteRepair: (id: string) => void;
  saveWarrantyClaim: (c: WarrantyClaim) => void;
  saveCategory: (name: string) => void;
  removeCategory: (name: string) => void;
  renameCategory: (oldName: string, newName: string) => void;
  openSession: (cashierId: string, opening: number) => void;
  saveBrand: (name: string) => void;
  removeBrand: (name: string) => void;
}

const Ctx = createContext<StoreCtx | null>(null);

function applyInventoryLedger(
  prev: POSState,
  next: POSState,
  operation: 'SALE' | 'SALE_REVERSAL' | 'REFUND' | 'PURCHASE_RECEIVE' | 'EXCHANGE' | 'STOCK_ADJUSTMENT' | 'PURCHASE_REVERSAL' | 'REPAIR_PARTS' | 'UNIT_DELETE',
  by?: string,
): POSState {
  const ledger = next.inventoryTransactions || prev.inventoryTransactions || [];
  const transactions: InventoryTransaction[] = [];
  const prevProducts = new Map(prev.products.map(p => [p.id, p]));
  const nextProducts = new Map(next.products.map(p => [p.id, p]));
  const now = new Date().toISOString();
  const add = (tx: Omit<InventoryTransaction, 'id' | 'occurredAt'> & { id: string }) => transactions.push({ ...tx, occurredAt: now, by });

  if (operation === 'SALE') {
    const ids = new Set(prev.sales.map(x => x.id));
    for (const sale of next.sales) if (!ids.has(sale.id)) {
      const componentQty = new Map<string, number>();
      for (const item of sale.items) if (item.qty > 0) {
        const product = nextProducts.get(item.productId);
        const kitLines = product?.isKit
          ? (next.kitItems || []).filter(k => k.kitProductId === item.productId && Number.isFinite(k.qty) && k.qty > 0)
          : [];
        if (kitLines.length) {
          for (const line of kitLines) componentQty.set(line.componentProductId, (componentQty.get(line.componentProductId) || 0) + line.qty * item.qty);
        } else {
          add({ id: 'inv:sale:' + sale.id + ':' + item.productId, type: 'SALE', productId: item.productId, quantity: -item.qty, referenceId: sale.id, referenceNo: sale.billNo, unitIds: item.unitIds });
        }
      }
      for (const [productId, quantity] of componentQty) {
        add({ id: 'inv:kit-sale:' + sale.id + ':' + productId, type: 'SALE', productId, quantity: -quantity, referenceId: sale.id, referenceNo: sale.billNo, reason: 'Kit BOM component consumed' });
      }
    }
    for (const sale of next.sales) if (!ids.has(sale.id) && sale.tradeIn?.addToInventory && sale.tradeIn.productId && sale.tradeIn.value > 0) {
      add({ id: 'inv:trade-in:' + sale.id, type: 'TRADE_IN', productId: sale.tradeIn.productId, quantity: 1, referenceId: sale.id, referenceNo: sale.billNo, unitIds: undefined, reason: `Trade-in value Rs. ${sale.tradeIn.value}` });
    }
  }

  if (operation === 'SALE_REVERSAL') {
    for (const sale of next.sales) {
      const old = prev.sales.find(x => x.id === sale.id);
      if (!old || old.status === 'reversed' || sale.status !== 'reversed') continue;
      for (const item of sale.items) if (item.qty > 0) {
        add({ id: 'inv:sale-reversal:' + sale.id + ':' + item.productId, type: 'SALE_REVERSAL', productId: item.productId, quantity: item.qty, referenceId: sale.id, referenceNo: sale.billNo, unitIds: item.unitIds, reason: 'Admin-approved bill reversal' });
      }
      if (sale.tradeIn?.addToInventory && sale.tradeIn.productId && sale.tradeIn.unitId) add({ id: 'inv:trade-in-reversal:' + sale.id, type: 'TRADE_IN', productId: sale.tradeIn.productId, quantity: -1, referenceId: sale.id, referenceNo: sale.billNo, reason: 'Trade-in removed by bill reversal' });
    }
  }

  if (operation === 'REFUND') {
    for (const sale of next.sales) {
      const old = prev.sales.find(x => x.id === sale.id);
      if (!old || old.status === 'refunded' || sale.status !== 'refunded') continue;
      for (const item of sale.items) if (item.qty > 0) {
        add({ id: 'inv:refund:' + sale.id + ':' + item.productId, type: 'REFUND', productId: item.productId, quantity: item.qty, referenceId: sale.id, referenceNo: sale.billNo, unitIds: item.unitIds });
      }
      if (sale.tradeIn?.addToInventory && sale.tradeIn.productId && sale.tradeIn.unitId) add({ id: 'inv:trade-in-refund:' + sale.id, type: 'TRADE_IN', productId: sale.tradeIn.productId, quantity: -1, referenceId: sale.id, referenceNo: sale.billNo, reason: 'Trade-in removed by full refund' });
    }
  }

  if (operation === 'PURCHASE_RECEIVE') {
    for (const purchase of next.purchases) {
      const old = prev.purchases.find(x => x.id === purchase.id);
      if (!old || old.status === 'received' || purchase.status !== 'received') continue;
      for (const item of purchase.items) if (item.qty > 0) {
        add({ id: 'inv:purchase:' + purchase.id + ':' + item.productId, type: 'PURCHASE_RECEIVE', productId: item.productId, quantity: item.qty, referenceId: purchase.id, referenceNo: purchase.poNo });
      }
    }
  }

  if (operation === 'EXCHANGE') {
    const ids = new Set(prev.exchanges.map(x => x.id));
    for (const ex of next.exchanges) if (!ids.has(ex.id)) {
      const returned = new Map<string, number>();
      for (const item of ex.items) if (item.qty > 0) {
        returned.set(item.productId, (returned.get(item.productId) || 0) + item.qty);
        add({ id: 'inv:exchange:' + ex.id + ':' + item.productId + ':return', type: 'EXCHANGE_RETURN', productId: item.productId, quantity: item.qty, referenceId: ex.id, referenceNo: ex.exNo, reason: ex.reason });
      }
      for (const [productId, qtyReturned] of returned) {
        const netDelta = (nextProducts.get(productId)?.stock || 0) - (prevProducts.get(productId)?.stock || 0);
        const outgoing = qtyReturned - netDelta;
        if (outgoing > 0) add({ id: 'inv:exchange:' + ex.id + ':' + productId + ':out', type: 'SALE', productId, quantity: -outgoing, referenceId: ex.id, referenceNo: ex.exNo, reason: ex.reason });
      }
    }
  }

  if (operation === 'PURCHASE_REVERSAL') {
    const ids = new Set((prev.purchaseReturns || []).map(x => x.id));
    for (const ret of next.purchaseReturns || []) if (!ids.has(ret.id)) for (const item of ret.items) if (item.qty > 0) {
      add({ id: 'inv:purchase-return:' + ret.id + ':' + item.itemIdx, type: 'PURCHASE_REVERSAL', productId: item.productId, quantity: -item.qty, referenceId: ret.id, referenceNo: ret.dnNo, unitIds: item.unitIds, reason: ret.reason });
    }
  }

  if (operation === 'REPAIR_PARTS') {
    for (const repair of next.repairs || []) {
      const old = (prev.repairs || []).find(x => x.id === repair.id);
      if (!old || old.partsDeductedAt || !repair.partsDeductedAt || repair.status !== 'delivered') continue;
      for (const part of repair.parts || []) if (part.productId && part.qty > 0) {
        add({ id: 'inv:repair-parts:' + repair.id + ':' + part.productId, type: 'REPAIR_PARTS', productId: part.productId, quantity: -part.qty, referenceId: repair.id, referenceNo: repair.jobNo, reason: 'Repair parts consumed on delivery' });
      }
    }
  }  if (operation === 'UNIT_DELETE') {
    const currentIds = new Set((next.units || []).map(u => u.id));
    for (const unit of prev.units || []) {
      if (currentIds.has(unit.id) || unit.status !== 'in_stock') continue;
      add({
        id: 'inv:unit-delete:' + unit.id,
        type: 'UNIT_DELETE',
        productId: unit.productId,
        quantity: -1,
        referenceId: unit.id,
        unitIds: [unit.id],
        reason: 'Inventory unit deleted',
      });
    }
  }



  if (operation === 'STOCK_ADJUSTMENT') {
    for (const [productId, product] of nextProducts) {
      const before = prevProducts.get(productId)?.stock;
      if (before === undefined) continue;
      const delta = product.stock - before;
      if (delta) add({ id: 'inv:adjust:' + productId + ':' + product.stock + ':' + delta, type: 'STOCK_ADJUSTMENT', productId, quantity: delta, reason: 'Stock adjustment' });
    }
  }

  let updated = ledger;
  for (const tx of transactions) updated = appendInventoryTransaction(updated, tx);
  return updated === next.inventoryTransactions ? next : { ...next, inventoryTransactions: updated };
}


const RETIRED_DEMO_PASSWORDS = ['admin', 'cashier'].map(prefix => prefix + '123'); // Retired defaults are never provisioned in production.
const RETIRED_DEMO_EMAILS = ['admin', 'cashier'].map(prefix => prefix + '@nexfixsolution.com');

function migrate(s: POSState): POSState {
  // Upgrade legacy/plaintext passwords without restoring any known default credential.
  const migratedUsers = (s.users || []).map(u => ({
    ...u,
    password: isHashed(u.password) ? u.password : hashPassword(u.password || ''),
    mustChangePassword: u.mustChangePassword ?? true,
  }));
  // Remove only the historical seeded identities while their retired default
  // credentials are still intact. A real shop account that happens to reuse the
  // old email after changing its password is preserved but remains subject to
  // the normal password policy.
  const users = migratedUsers.filter(u => {
    const legacyIdentity = u.id === 'u-admin' || u.id === 'u-nimal'
      || RETIRED_DEMO_EMAILS.includes(u.email.trim().toLowerCase());
    if (!legacyIdentity) return true;
    const retired = RETIRED_DEMO_PASSWORDS.some(secret => verifyPassword(secret, u.password));
    return !retired;
  });
  // Never recreate a historical demo PIN. Existing known-default PINs are
  // invalidated so admin unlock can fall back to the authenticated admin password.
  let adminPinHash = String(s.settings?.adminPinHash || '');
  if (adminPinHash && verifyPassword(RETIRED_DEMO_PASSWORDS[0], adminPinHash)) adminPinHash = '';
  if (adminPinHash && (adminPinHash.includes('.') || adminPinHash.length < 32)) adminPinHash = '';
  const defaultAdminPermissions: Record<string, boolean> = Object.fromEntries(PERMISSION_KEYS.map(k => [k.key, true]));
  const permissions: Permissions = {
    admin: { ...defaultAdminPermissions, ...(s.permissions?.admin || {}) },
    cashier: { ...DEFAULT_ROLE_PERMISSIONS.cashier, ...(s.permissions?.cashier || {}) },
    manager: { ...DEFAULT_ROLE_PERMISSIONS.manager, ...(s.permissions?.manager || {}) },
    technician: { ...DEFAULT_ROLE_PERMISSIONS.technician, ...(s.permissions?.technician || {}) },
  };

  return {
    ...s,
    permissions,
    users,
    units: s.units || [],
    repairs: s.repairs || [],
    counters: {
      bill: s.counters?.bill ?? 0,
      po: s.counters?.po ?? 0,
      ex: s.counters?.ex ?? 0,
      job: s.counters?.job ?? 0,
      quote: (s.counters as { quote?: number })?.quote ?? 0,
      claim: (s.counters as { claim?: number })?.claim ?? 0,
      grn: (s.counters as { grn?: number })?.grn ?? 0,
      dn: (s.counters as { dn?: number })?.dn ?? 0,
    },
    kitItems: s.kitItems || [],
    quotations: s.quotations || [],
    warrantyClaims: s.warrantyClaims || [],
    purchaseReturns: s.purchaseReturns || [],
    supplierPayments: s.supplierPayments || [],
    customerCreditPayments: s.customerCreditPayments || [],
    reverseRequests: s.reverseRequests || [],
    settings: {
      ...s.settings,
      adminPinHash,
      whatsappReceipts: s.settings?.whatsappReceipts ?? false,
      categories: s.settings?.categories?.length ? s.settings.categories : [...DEFAULT_CATEGORIES],
      brands: s.settings?.brands?.length ? s.settings.brands : [...DEFAULT_BRANDS],
      repairWarrantyDays: s.settings?.repairWarrantyDays ?? 30,
      loyaltyPointsPerRs: Number.isFinite(s.settings?.loyaltyPointsPerRs) ? Math.max(0, s.settings!.loyaltyPointsPerRs!) : 0.001,
      loyaltyPointValue: Number.isFinite(s.settings?.loyaltyPointValue) ? Math.max(0, s.settings!.loyaltyPointValue!) : 20,
      promotions: Array.isArray(s.settings?.promotions) ? s.settings.promotions : [],
    },
    customers: (s.customers || []).map(c => ({ ...c, loyaltyPoints: c.loyaltyPoints ?? 0 })),
  };
}

/** Synchronous fallback from localStorage (used as initial state + migration source) */
function loadStateFromLocalStorage(): POSState | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.products && parsed.users) return migrate(parsed as POSState);
    }
    const legacy = localStorage.getItem(STORE_KEY_V1);
    if (legacy) {
      const parsed = JSON.parse(legacy) as POSState;
      if (parsed && parsed.products && parsed.users) return migrate(parsed);
    }
  } catch { /* corrupted */ }
  return null;
}

function loadState(): POSState {
  return loadStateFromLocalStorage() || buildSeed();
}

/** Persist to both IndexedDB (primary) and localStorage (fast secondary cache) */
async function persistState(state: POSState): Promise<void> {
  // IndexedDB is the authoritative full-state store. Do not mirror the full
  // POS dataset into localStorage where it is easier to inspect/tamper with.
  if (idbAvailable()) {
    const saved = await idbSaveState(state);
    // Keep the cloud-sale idempotency marker until the authoritative sale is
    // durably persisted locally. This closes the crash window between the
    // cloud transaction commit and the debounced local state write.
    if (saved) {
      try {
        const pendingKey = 'nexfix_pending_cloud_sale_v2';
        const raw = localStorage.getItem(pendingKey);
        if (raw) {
          const pending = JSON.parse(raw) as { saleId?: string };
          if (pending.saleId && state.sales.some(sale => sale.id === pending.saleId)) {
            localStorage.removeItem(pendingKey);
          }
        }
      } catch { /* ignore malformed/stale marker */ }
    }
  }
  // Track write for offline queue (future cloud sync)
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    await queueWrite('state_write_offline');
  }
}

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch { return null; }
}

export function POSProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<POSState>(loadState);
  const [session, setSession] = useState<Session | null>(loadSession);
  const [dark, setDark] = useState<boolean>(() => {
    try { return localStorage.getItem(THEME_KEY) === 'dark'; } catch { return false; }
  });
  // not persisted — session lock for the admin elevation prompt
  const [adminPrompt, setAdminPrompt] = useState(false);
  const [sensitiveAdminPrompt, setSensitiveAdminPrompt] = useState<{ reason: string } | null>(null);
  const sensitiveAdminResolverRef = useRef<((ok: boolean) => void) | null>(null);
  const [ready, setReady] = useState(!idbAvailable()); // true immediately if no IDB
  const [connectivity, setConnectivity] = useState<Connectivity>(() => getConnectivity());
  const [backupMeta, setBackupMeta] = useState<BackupMeta>({ autoBackupHours: 6, backupCount: 0 });
  const [pendingQueueCount, setPendingQueueCount] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const previousBackupStateRef = useRef(state);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Blocks accidental signOut for a few seconds after successful login (boot/effect race). */
  const loginAtRef = useRef(0);
  const stockAdjustmentLockRef = useRef(false);
  const purchaseReceiveLockRef = useRef(false);
  const purchaseReturnLockRef = useRef(false);
  const supplierPaymentLockRef = useRef(false);
  const customerCreditPaymentLockRef = useRef(false);
  const expenseLockRef = useRef(false);
  const roleSwitchLockRef = useRef(false);

  // Boot: prefer IndexedDB, migrate from localStorage if needed
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!idbAvailable()) {
        setReady(true);
        return;
      }
      try {
        const fromIdb = await idbLoadState();
        if (cancelled) return;
        if (fromIdb) {
          // idbLoadState always repairs the default admin recovery account
          let hydrated = migrate(fromIdb);
          const local = loadStateFromLocalStorage();
          if ((!hydrated.kitItems || hydrated.kitItems.length === 0) && local?.kitItems?.length) {
            hydrated = { ...hydrated, kitItems: local.kitItems };
            await idbSaveState(hydrated);
          }
          setState(hydrated);
        } else {
          // IDB unavailable / failed — fall back to localStorage or seed (which now includes defaults)
          const local = loadStateFromLocalStorage() || buildSeed();
          setState(migrate(local));
          await idbSaveState(local);
        }
        // NOTE: Do NOT clear session here.
        // Clearing session against stateRef races with concurrent signIn and
        // was deleting a freshly written session (login → bounce back to /login).

        const meta = await idbGetMeta();
        const queued = await idbListQueue();
        if (!cancelled) {
          setBackupMeta(meta);
          setPendingQueueCount(queued.length);
        }
      } catch { /* keep localStorage state */ }
      // Re-hydrate session from storage AFTER users are loaded so login is not lost
        try {
          const raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
          if (raw) {
            const sess = JSON.parse(raw) as Session;
            // Prefer the just-loaded state (stateRef updates on next render; use functional check later via setSession)
            setSession(sess);
          }
        } catch { /* ignore */ }
        if (!cancelled) setReady(true);
      // Register service worker for offline shell
      registerServiceWorker().catch(() => {});
    })();
    return () => { cancelled = true; };
  }, []);

  const user = useMemo(
    () => (session ? state.users.find(u => u.id === session.userId && u.active) || null : null),
    [session, state.users],
  );
  const can = useCallback(
    (key: string) => {
      if (!user) return false;
      if (user.role === 'admin') return true;
      return !!state.permissions[user.role]?.[key];
    },
    [user, state.permissions],
  );
  const viewingAs: Role = user?.role || 'admin';

  // Any authenticated POS state mutation is backup-eligible. This catch-all watcher
  // intentionally covers every write path (inventory, customers, suppliers, purchases,
  // repairs, units/IMEI, payments, holds, returns, quotations, warranty claims, sessions,
  // permissions/settings, reversals, and future POS state fields) so a newly added write
  // path cannot silently bypass Google Drive backup. Existing event-specific scheduling
  // remains as an earlier debounce trigger; this watcher is the safety net.
  useEffect(() => {
    if (!ready || !user) {
      previousBackupStateRef.current = state;
      return;
    }
    if (previousBackupStateRef.current !== state) {
      scheduleGoogleBackup(() => stateRef.current, 'settings');
    }
    previousBackupStateRef.current = state;
  }, [state, ready, user?.id]);

  // Debounced persist to IndexedDB + localStorage
  useEffect(() => {
    if (!ready) return;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      persistState(state).catch(() => {});
    }, 120);
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, [state, ready]);

  // Refresh server-authoritative reversal requests so admin approvals are visible across PCs.
  useEffect(() => {
    if (!ready || !user || !supabaseConfigured || typeof navigator === 'undefined' || !navigator.onLine) return;
    let cancelled = false;
    (async () => {
      const shop = await ensureCloudShop('Nexfix Shop');
      if (!shop.ok || !shop.shopId) return;
      const remote = await listSaleReversalRequests(shop.shopId);
      if (!remote.ok || !remote.requests || cancelled) return;
      setState(s => {
        const localById = new Map((s.reverseRequests || []).map(r => [r.id, r]));
        for (const r of remote.requests || []) {
          localById.set(r.id, {
            id: r.id, saleId: r.saleId, billNo: r.billNo, reason: r.reason,
            requestedBy: r.requestedBy, requestedAt: r.requestedAt, status: r.status,
            reviewedBy: r.reviewedBy, reviewedAt: r.reviewedAt, reviewNote: r.reviewNote,
          });
        }
        return { ...s, reverseRequests: [...localById.values()].sort((a,b) => +new Date(b.requestedAt) - +new Date(a.requestedAt)) };
      });
    })();
    return () => { cancelled = true; };
  }, [ready, user?.id, user?.role, connectivity]);

  // Connectivity listeners + auto-flush queue when back online
  useEffect(() => {
    const unsub = onConnectivityChange(async (status) => {
      setConnectivity(status);
      if (status === 'online') {
        const { flushed, pending } = await flushSyncQueue();
        // Keep the durable queue count authoritative. Conflicts/errors intentionally leave queued writes visible.
        setPendingQueueCount(pending);
        // startAutoBackup() owns the interval/due decision. Reconnect only
        // flushes the durable queue here; it must not force an extra cloud
        // snapshot merely because the network became available.
        if (user) {
          try {
            // A settings edit can happen while this PC is offline. Once it
            // reconnects, repair the Drive folder name + shop.json +
            // SHOP_INFO.txt + RECOVERY_KEY.txt before merely refreshing UI meta.
            const metadataResult = await syncShopMetadataToGoogleDrive(stateRef.current);
            if (!metadataResult.ok) {
              console.warn('[Google Backup] reconnect shop metadata sync failed:', metadataResult.error);
            }
            const meta = await idbGetMeta();
            setBackupMeta(meta);
          } catch { /* ignore */ }
        }
      }
    });
    return unsub;
  }, [user, can]);

  // Auto-backup scheduler
  useEffect(() => {
    // Automatic backups are a system operation. Any authenticated POS user
    // may keep the scheduler running; manual JSON export remains permission-gated.
    if (!ready || !user) return;
    const stop = startAutoBackup(
      () => stateRef.current,
      async () => {
        // Refresh both success and failure metadata so Settings never looks
        // silently stale after an automatic attempt.
        const meta = await idbGetMeta();
        setBackupMeta(meta);
      },
    );
    return stop;
  }, [ready, backupMeta.autoBackupHours, user?.id, user?.role, can]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch { /* ignore */ }
  }, [dark]);

  const setStateWithInventoryLedger = useCallback((operation: 'SALE' | 'SALE_REVERSAL' | 'REFUND' | 'PURCHASE_RECEIVE' | 'EXCHANGE' | 'STOCK_ADJUSTMENT' | 'PURCHASE_REVERSAL' | 'REPAIR_PARTS' | 'UNIT_DELETE', updater: (prev: POSState) => POSState) => {
    setState(prev => applyInventoryLedger(prev, updater(prev), operation, user?.email));
  }, [user?.email]);


  const pushAudit = useCallback((action: string, entity: string, details: string, who?: string) => {
    setState(s => ({
      ...s,
      audit: [
        { id: uid(), time: new Date().toISOString(), user: who || user?.email || 'system', action, entity, details },
        ...s.audit,
      ].slice(0, 500),
    }));
  }, [user?.email]);

  const verifyAdminPin = useCallback((pin: string, reason?: string): boolean => {
    if (!user) return false;
    const ok = verifyPassword(pin || '', state.settings.adminPinHash);
    if (!ok) {
      setState(s => ({
        ...s,
        audit: [{
          id: uid(), time: new Date().toISOString(),
          user: user?.email || 'unknown', action: 'DENIED', entity: 'Security',
          details: `Failed admin verification${reason ? ` for ${reason}` : ''} (${user?.name || 'unknown'})`,
        }, ...s.audit].slice(0, 500),
      }));
    }
    return ok;
  }, [state.settings.adminPinHash, user]);

  const unlockSession = useCallback((credential: string): boolean => {
    if (!user || !credential) return false;
    const current = stateRef.current.users.find(u => u.id === user.id);
    if (!current || !current.active || current.mustChangePassword) return false;

    let passwordOk = false;
    try {
      passwordOk = isHashed(current.password)
        ? verifyPassword(credential, current.password)
        : credential === current.password;
    } catch { passwordOk = false; }

    // An unattended terminal can be recovered by the current account or by
    // an active administrator credential, without destroying the current cart.
    let elevatedOk = false;
    try {
      elevatedOk = stateRef.current.users
        .filter(u => u.role === 'admin' && u.active)
        .some(admin => isHashed(admin.password)
          ? verifyPassword(credential, admin.password)
          : credential === admin.password);
    } catch { elevatedOk = false; }
    const adminPinOk = verifyPassword(credential, stateRef.current.settings.adminPinHash || '');

    if (passwordOk || elevatedOk || adminPinOk) {
      loginAtRef.current = Date.now();
      pushAudit('UNLOCK', 'Auth', 'Session unlocked after idle lock');
      return true;
    }
    pushAudit('DENIED', 'Auth', 'Failed idle-lock unlock attempt');
    return false;
  }, [pushAudit, user]);
  const sensitiveAuthAtRef = useRef(0);
  const confirmSensitiveAdmin = useCallback((reason: string): Promise<boolean> => {
    if (user?.role !== 'admin') {
      pushAudit('DENIED', 'Security', 'Sensitive action blocked: administrator authentication required');
      return Promise.resolve(false);
    }
    const FRESH_MS = 5 * 60 * 1000;
    if (Date.now() - sensitiveAuthAtRef.current < FRESH_MS) return Promise.resolve(true);
    if (sensitiveAdminResolverRef.current) {
      sensitiveAdminResolverRef.current(false);
      sensitiveAdminResolverRef.current = null;
    }
    const label = String(reason || 'sensitive action').trim().slice(0, 120);
    setSensitiveAdminPrompt({ reason: label });
    return new Promise<boolean>(resolve => { sensitiveAdminResolverRef.current = resolve; });
  }, [pushAudit, user]);

  const resolveSensitiveAdmin = useCallback((credential: string): boolean => {
    const resolver = sensitiveAdminResolverRef.current;
    if (!resolver || !sensitiveAdminPrompt) return false;
    const secret = String(credential || '');
    const admin = stateRef.current.users.find(u => u.role === 'admin' && u.active);
    let passwordOk = false;
    try {
      passwordOk = !!admin && (isHashed(admin.password) ? verifyPassword(secret, admin.password) : secret === admin.password);
    } catch { passwordOk = false; }
    let pinOk = false;
    try { pinOk = !!secret && verifyPassword(secret, stateRef.current.settings.adminPinHash || ''); } catch { pinOk = false; }
    if (!passwordOk && !pinOk) {
      pushAudit('DENIED', 'Security', 'Failed administrator confirmation for ' + sensitiveAdminPrompt.reason);
      return false;
    }
    sensitiveAuthAtRef.current = Date.now();
    pushAudit('AUTH', 'Security', 'Administrator re-authenticated for ' + sensitiveAdminPrompt.reason);
    resolver(true);
    sensitiveAdminResolverRef.current = null;
    setSensitiveAdminPrompt(null);
    return true;
  }, [pushAudit, sensitiveAdminPrompt]);

  const cancelSensitiveAdmin = useCallback(() => {
    const resolver = sensitiveAdminResolverRef.current;
    if (resolver) {
      resolver(false);
      sensitiveAdminResolverRef.current = null;
      pushAudit('DENIED', 'Security', 'Sensitive action cancelled: administrator confirmation was not provided');
    }
    setSensitiveAdminPrompt(null);
  }, [pushAudit]);
  const toggleTheme = useCallback(() => setDark(d => !d), []);




  const signIn = useCallback(async (email: string, password: string, remember: boolean, expectedRole?: Extract<Role, 'admin' | 'cashier'>) => {
    const mail = email.trim().toLowerCase();
    if (!mail || !password) return { ok: false, error: 'Enter your email and password' };
    // Known demo passwords are never accepted by production builds, including
    // on databases upgraded from an older release that still contain a legacy user.
    const retiredDemoPasswords = ['admin', 'cashier'].map(prefix => prefix + '123');
    if (import.meta.env.VITE_SEED_DEMO !== 'true' && retiredDemoPasswords.some(value => value.toLowerCase() === password.toLowerCase())) {
      return { ok: false, error: 'This password is a retired demo credential. Use the password created during administrator setup.' };
    }

    // Local abuse control: bounded failures with exponential backoff. The
    // limiter is intentionally independent of account existence so it does
    // not create an easy user-enumeration oracle.
    const now = Date.now();
    const RATE_KEY = 'nexfix_login_guard_v1';
    let guard: { failures: number; lockedUntil: number } = { failures: 0, lockedUntil: 0 };
    try {
      const raw = localStorage.getItem(RATE_KEY);
      if (raw) guard = { ...guard, ...(JSON.parse(raw) as Partial<typeof guard>) };
    } catch { /* ignore malformed limiter state */ }
    if (guard.lockedUntil > now) {
      const seconds = Math.ceil((guard.lockedUntil - now) / 1000);
      return { ok: false, error: `Too many failed sign-in attempts. Try again in ${seconds} seconds.` };
    }

    const users = [...(stateRef.current.users || [])];
    const u = users.find(x => (x.email || '').trim().toLowerCase() === mail);
    if (!u) {
      const failures = guard.failures + 1;
      const lockSeconds = failures >= 5 ? Math.min(300, 15 * Math.pow(2, Math.min(failures - 5, 4))) : 0;
      const nextGuard = { failures, lockedUntil: lockSeconds ? now + lockSeconds * 1000 : 0 };
      try { localStorage.setItem(RATE_KEY, JSON.stringify(nextGuard)); } catch { /* ignore */ }
      setState(s => ({ ...s, audit: [{ id: uid(), time: new Date().toISOString(), user: mail, action: 'DENIED', entity: 'Auth', details: 'Failed sign-in attempt' }, ...(s.audit || [])].slice(0, 500) }));
      return { ok: false, error: 'Incorrect email or password' };
    }

    let passwordOk = false;
    if (isHashed(u.password)) {
      passwordOk = await verifyPasswordAsync(password, u.password);
      if (!passwordOk) {
        try { passwordOk = verifyPassword(password, u.password); } catch { /* ignore */ }
      }
    } else {
      passwordOk = u.password === password;
    }
    if (!passwordOk || !u.active) {
      const failures = guard.failures + 1;
      const lockSeconds = failures >= 5 ? Math.min(300, 15 * Math.pow(2, Math.min(failures - 5, 4))) : 0;
      const nextGuard = { failures, lockedUntil: lockSeconds ? now + lockSeconds * 1000 : 0 };
      try { localStorage.setItem(RATE_KEY, JSON.stringify(nextGuard)); } catch { /* ignore */ }
      setState(s => ({ ...s, audit: [{ id: uid(), time: new Date().toISOString(), user: mail, action: 'DENIED', entity: 'Auth', details: 'Failed sign-in attempt' }, ...(s.audit || [])].slice(0, 500) }));
      return { ok: false, error: 'Incorrect email or password' };
    }

    try { localStorage.removeItem(RATE_KEY); } catch { /* ignore */ }
    if (expectedRole && u.role !== expectedRole) return { ok: false, error: `This account is registered as ${u.role === 'admin' ? 'Admin' : 'Cashier'}. Select the matching login role.` };
    const needsUpgrade = !isPasswordHash(u.password);
    const upgradedPassword = needsUpgrade ? await hashPasswordAsync(password) : u.password;
    const nextUser = needsUpgrade ? { ...u, password: upgradedPassword } : u;
    if (needsUpgrade) {
      const nextUsers = users.map(x => x.id === u.id ? nextUser : x);
      stateRef.current = { ...stateRef.current, users: nextUsers };
    }
    const pinWasUnset = !stateRef.current.settings?.adminPinHash && nextUser.role === 'admin';
    setState(s => ({
      ...s,
      users: needsUpgrade ? s.users.map(x => x.id === u!.id ? nextUser : x) : s.users,
      settings: pinWasUnset ? { ...s.settings, adminPinHash: hashPin(password) } : s.settings,
      audit: [{ id: uid(), time: new Date().toISOString(), user: u!.email, action: 'LOGIN', entity: 'Auth', details: `${u!.name} signed in${needsUpgrade ? ' · password upgraded to PBKDF2' : ''}` }, ...(s.audit || [])].slice(0, 500),
    }));

    const sess = { userId: nextUser.id, remember };
    loginAtRef.current = Date.now();
    setSession(sess);
    try {
      // Keep the authenticated POS session durable across a normal browser refresh.
      // "Remember me" is retained in the session metadata for compatibility, but
      // refresh must never force an already-authenticated cashier/admin back to Login.
      localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess));
      localStorage.setItem('nexfix_session_started_v1', String(Date.now()));
    } catch { /* ignore */ }
    return { ok: true };
  }, []);

  const createInitialAdmin = useCallback(async (name: string, email: string, password: string, cashier?: { name: string; email: string; password: string }) => {
    const cleanName = name.trim();
    const mail = email.trim().toLowerCase();
    const next = password.trim();
    if ((stateRef.current.users || []).length > 0) return { ok: false, error: 'Administrator setup is already complete' };
    if (cleanName.length < 2) return { ok: false, error: 'Enter the administrator name' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return { ok: false, error: 'Enter a valid email address' };
    if (next.length < 12) return { ok: false, error: 'Administrator password must be at least 12 characters' };
    const cashierName = cashier?.name.trim() || '';
    const cashierMail = cashier?.email.trim().toLowerCase() || '';
    const cashierPassword = cashier?.password.trim() || '';
    if (cashier && cashierName.length < 2) return { ok: false, error: 'Enter the cashier name' };
    if (cashier && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cashierMail)) return { ok: false, error: 'Enter a valid cashier email address' };
    if (cashier && cashierMail === mail) return { ok: false, error: 'Admin and cashier must use different email addresses' };
    if (cashier && cashierPassword.length < 12) return { ok: false, error: 'Cashier password must be at least 12 characters' };
    const retiredDemoPasswords = ['admin', 'cashier'].map(prefix => prefix + '123');
    if (retiredDemoPasswords.some(value => value.toLowerCase() === next.toLowerCase())) return { ok: false, error: 'Choose a password that is not a retired demo credential' };
    if (cashier && retiredDemoPasswords.some(value => value.toLowerCase() === cashierPassword.toLowerCase())) return { ok: false, error: 'Choose a cashier password that is not a retired demo credential' };
    const hashed = await hashPasswordAsync(next);
    const cashierHashed = cashier ? await hashPasswordAsync(cashierPassword) : '';
    const nowIso = new Date().toISOString();
    const admin: AppUser = {
      id: uid(), name: cleanName, email: mail, password: hashed, role: 'admin',
      active: true, createdAt: nowIso, mustChangePassword: false,
    };
    const cashierUser: AppUser | null = cashier ? {
      id: uid(), name: cashierName, email: cashierMail, password: cashierHashed, role: 'cashier',
      active: true, createdAt: nowIso, mustChangePassword: false,
    } : null;
    const nextState = { ...stateRef.current, users: cashierUser ? [admin, cashierUser] : [admin], settings: { ...stateRef.current.settings, adminPinHash: hashPin(next) } };
    stateRef.current = nextState;
    setState(nextState);
    pushAudit('CREATE', 'Auth', 'Initial administrator account created', mail);
    const sess = { userId: admin.id, remember: true };
    loginAtRef.current = Date.now();
    setSession(sess);
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess));
    } catch { /* ignore */ }
    return { ok: true };
  }, [pushAudit]);

  const changePassword = useCallback(async (nextPassword: string): Promise<{ ok: boolean; error?: string }> => {
    if (!user) return { ok: false, error: 'You must be signed in' };
    const next = nextPassword.trim();
    if (next.length < 12) return { ok: false, error: 'New password must be at least 12 characters' };
    if (RETIRED_DEMO_PASSWORDS.includes(next)) return { ok: false, error: 'Choose a password different from the retired demo credentials' };
    const hashed = await hashPasswordAsync(next);
    setState(s => ({
      ...s,
      users: s.users.map(u => u.id === user.id ? { ...u, password: hashed, mustChangePassword: false } : u),
    }));
    stateRef.current = { ...stateRef.current, users: stateRef.current.users.map(u => u.id === user.id ? { ...u, password: hashed, mustChangePassword: false } : u) };
    pushAudit('PASSWORD-CHANGE', 'Auth', 'Mandatory first-login password changed');
    return { ok: true };
  }, [user, pushAudit]);

  const changeManagedPassword = useCallback(async (targetUserId: string, nextPassword: string): Promise<{ ok: boolean; error?: string }> => {
    if (!user || user.role !== 'admin') return { ok: false, error: 'Only admins can change account passwords' };
    const next = nextPassword.trim();
    if (next.length < 12) return { ok: false, error: 'New password must be at least 12 characters' };
    if (RETIRED_DEMO_PASSWORDS.includes(next)) return { ok: false, error: 'Choose a password different from the retired demo credentials' };
    const target = stateRef.current.users.find(u => u.id === targetUserId && (u.role === 'admin' || u.role === 'cashier'));
    if (!target) return { ok: false, error: 'Admin or cashier account not found' };
    const hashed = await hashPasswordAsync(next);
    setState(s => ({ ...s, users: s.users.map(u => u.id === targetUserId ? { ...u, password: hashed, mustChangePassword: false } : u) }));
    stateRef.current = { ...stateRef.current, users: stateRef.current.users.map(u => u.id === targetUserId ? { ...u, password: hashed, mustChangePassword: false } : u) };
    pushAudit('PASSWORD-CHANGE', 'Auth', 'Admin changed ' + target.role.toUpperCase() + ' login password for ' + target.email);
    return { ok: true };
  }, [user, pushAudit]);
  const signOut = useCallback((force = false) => {
    // Ignore only spurious/effect-driven signOut calls during the first 8s after login.
    // An explicit user action can always sign out immediately.
    if (!force && loginAtRef.current && Date.now() - loginAtRef.current < 8000) {
      return;
    }
    if (user) pushAudit('LOGOUT', 'Auth', `${user.name} signed out`);
    setSession(null);
    try { localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY); sessionStorage.removeItem('nexfix_prev_user'); } catch { /* ignore */ }  }, [user, pushAudit]);

  // Role switches create a real authenticated session; App.tsx enforces mustChangePassword on the target user.
  const switchRole = useCallback(async (role: Role, credential?: string, email?: string): Promise<{ ok: boolean; error?: string }> => {
    // Switching changes the authenticated POS identity. It is never a cosmetic
    // "view" switch and must always authenticate the target account.
    if (!user) return { ok: false, error: 'You must be signed in' };
    if (role === user.role) return { ok: true };
    if (!['admin', 'cashier'].includes(role)) return { ok: false, error: 'Unsupported role switch' };

    let target: AppUser | undefined;
    const secret = credential || '';
    if (roleSwitchLockRef.current) return { ok: false, error: 'Please wait and try again' };
    const SWITCH_RATE_KEY = 'nexfix_role_switch_guard_v1';
    let guard: { failures: number; lockedUntil: number } = { failures: 0, lockedUntil: 0 };
    try {
      const raw = localStorage.getItem(SWITCH_RATE_KEY);
      if (raw) guard = { ...guard, ...(JSON.parse(raw) as Partial<typeof guard>) };
    } catch { /* ignore malformed limiter state */ }
    const now = Date.now();
    if (guard.lockedUntil > now) {
      return { ok: false, error: `Too many failed role-switch attempts. Try again in ${Math.ceil((guard.lockedUntil - now) / 1000)} seconds.` };
    }

    if (role === 'cashier' && user.role === 'admin') {
      const mail = (email || '').trim().toLowerCase();
      if (!mail || !secret) return { ok: false, error: 'Cashier email and password are required' };
      target = state.users.find(u => u.role === 'cashier' && u.active && u.email.trim().toLowerCase() === mail);
      if (!target) return { ok: false, error: 'Incorrect cashier email or password' };
      const passwordOk = isHashed(target.password)
        ? await verifyPasswordAsync(secret, target.password)
        : verifyPassword(secret, target.password || '');
      if (!passwordOk) {
        setState(st => ({ ...st, audit: [{
          id: uid(), time: new Date().toISOString(), user: user.email,
          action: 'DENIED', entity: 'Auth',
          details: 'Failed CASHIER switch authentication by ' + user.name,
        }, ...st.audit].slice(0, 500) }));
        const failures = guard.failures + 1;
        const lockSeconds = failures >= 5 ? Math.min(300, 15 * Math.pow(2, Math.min(failures - 5, 4))) : 0;
        try { localStorage.setItem(SWITCH_RATE_KEY, JSON.stringify({ failures, lockedUntil: lockSeconds ? now + lockSeconds * 1000 : 0 })); } catch { /* ignore */ }
        return { ok: false, error: 'Incorrect cashier email or password' };
      }
    } else if (role === 'admin' && user.role === 'cashier') {
      target = state.users.find(u => u.role === 'admin' && u.active);
      if (!target) return { ok: false, error: 'No active administrator account exists' };
      const pinOk = verifyPassword(secret, state.settings.adminPinHash);
      const passwordOk = isHashed(target.password)
        ? await verifyPasswordAsync(secret, target.password)
        : verifyPassword(secret, target.password || '');
      if (!pinOk && !passwordOk) {
        setState(st => ({ ...st, audit: [{
          id: uid(), time: new Date().toISOString(), user: user.email,
          action: 'DENIED', entity: 'Auth',
          details: 'Failed ADMIN unlock attempt by ' + user.name,
        }, ...st.audit].slice(0, 500) }));
        const failures = guard.failures + 1;
        const lockSeconds = failures >= 5 ? Math.min(300, 15 * Math.pow(2, Math.min(failures - 5, 4))) : 0;
        try { localStorage.setItem(SWITCH_RATE_KEY, JSON.stringify({ failures, lockedUntil: lockSeconds ? now + lockSeconds * 1000 : 0 })); } catch { /* ignore */ }
        return { ok: false, error: 'Incorrect admin unlock PIN or admin login password' };
      }
    }

    if (!target) return { ok: false, error: 'No active ' + role + ' account exists' };
    try { localStorage.removeItem(SWITCH_RATE_KEY); } catch { /* ignore */ }

    const prev = session ? loadSession() : null;
    const sess = { userId: target.id, remember: prev?.remember ?? true };
    setSession(sess);
    try {
      // Keep the authenticated POS session durable across a normal browser refresh.
      // "Remember me" is retained in the session metadata for compatibility, but
      // refresh must never force an already-authenticated cashier/admin back to Login.
      localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess));
      localStorage.setItem('nexfix_session_started_v1', String(Date.now()));
    } catch { /* ignore */ }
    setState(st => ({
      ...st,
      audit: [{
        id: uid(), time: new Date().toISOString(), user: target!.email, action: 'SWITCH', entity: 'Auth',
        details: 'Authenticated switch to ' + role.toUpperCase() + ' (' + target!.name + ')',
      }, ...st.audit].slice(0, 500),
    }));
    return { ok: true };
  }, [state.users, state.settings.adminPinHash, session, user]);
  const changeAdminPin = useCallback((current: string, next: string): { ok: boolean; error?: string } => {
    if (user?.role !== 'admin') return { ok: false, error: 'Only admins can change this password' };
    const currentSecret = String(current || '').trim();
    let currentOk = false;
    if (state.settings.adminPinHash) {
      try { currentOk = verifyPassword(currentSecret, state.settings.adminPinHash); } catch { currentOk = false; }
    } else {
      const admin = stateRef.current.users.find(u => u.id === user.id && u.role === 'admin' && u.active);
      try { currentOk = !!admin && (isHashed(admin.password) ? verifyPassword(currentSecret, admin.password) : currentSecret === admin.password); } catch { currentOk = false; }
    }
    if (!currentOk) return { ok: false, error: state.settings.adminPinHash ? 'Current admin unlock PIN is incorrect' : 'Current administrator login password is incorrect' };
    if (next.trim().length < 4) return { ok: false, error: 'New password must be at least 4 characters' };
    setState(s => ({ ...s, settings: { ...s.settings, adminPinHash: hashPin(next.trim()) } }));
    pushAudit('SETTINGS', 'Security', 'Admin switch password changed');
    return { ok: true };
  }, [user, state.settings.adminPinHash, pushAudit]);

  /* ---------------- products ---------------- */
  const saveKitItems = useCallback((items: KitItem[]) => {
    if (!user || !can('act:manageStock')) {
      pushAudit('DENIED', 'Kit', 'Blocked kit/BOM change without stock-management permission');
      return;
    }
    const valid = items.every(item =>
      !!item.id &&
      !!item.kitProductId &&
      !!item.componentProductId &&
      item.kitProductId !== item.componentProductId &&
      Number.isFinite(item.qty) &&
      item.qty > 0 &&
      state.products.some(p => p.id === item.kitProductId) &&
      state.products.some(p => p.id === item.componentProductId),
    );
    if (!valid) {
      pushAudit('DENIED', 'Kit', 'Blocked invalid kit/BOM data');
      return;
    }
    setState(s => ({ ...s, kitItems: items }));
  }, [can, pushAudit, state.products, user]);

  const saveQuotations = useCallback((quotations: import('./types').Quotation[], quoteCounter?: number) => {
    if (!user || !can('page:pos')) {
      pushAudit('DENIED', 'Quotation', 'Blocked quotation change without POS access');
      return;
    }
    setState(s => ({
      ...s,
      quotations,
      counters: quoteCounter === undefined ? s.counters : { ...s.counters, quote: quoteCounter },
    }));
  }, [user, can, pushAudit]);

  const saveProduct = useCallback(async (p: Product): Promise<boolean> => {
    if (!user || !can('act:manageStock')) {
      pushAudit('DENIED', 'Product', `Blocked product save for ${p.name || p.id}`);
      return false;
    }
    const name = String(p.name || '').trim();
    const sku = String(p.sku || '').trim();
    const barcode = String(p.barcode || '').trim();
    const values = [p.cost, p.price, p.stock, p.reorderLevel, ...(p.warrantyMonths === undefined ? [] : [p.warrantyMonths])];
    if (!name || values.some(v => !Number.isFinite(v) || v < 0) || !Number.isInteger(p.stock) || !Number.isInteger(p.reorderLevel) || (p.warrantyMonths !== undefined && !Number.isInteger(p.warrantyMonths))) {
      pushAudit('DENIED', 'Product', `Blocked invalid product input for ${p.id}`);
      return false;
    }
    const exists = state.products.some(x => x.id === p.id);
    const current = state.products.find(x => x.id === p.id);
    const currentTracked = !!(current?.trackImei || current?.trackSerial);
    const nextTracked = !!(p.trackImei || p.trackSerial);
    const inStockUnits = exists
      ? (state.units || []).filter(u => u.productId === p.id && u.status === 'in_stock').length
      : 0;
    if (nextTracked && Math.round(p.stock) !== inStockUnits) {
      pushAudit('DENIED', 'Product', `Blocked tracked product save for ${name}: stock ${Math.round(p.stock)} does not match in-stock units ${inStockUnits}`);
      return false;
    }
    if (currentTracked && !nextTracked && inStockUnits > 0) {
      pushAudit('DENIED', 'Product', `Blocked disabling tracking for ${name}: ${inStockUnits} in-stock unit(s) remain`);
      return false;
    }
    const normalized: Product = { ...p, name, sku, barcode, cost: Math.round(p.cost * 100) / 100, price: Math.round(p.price * 100) / 100, stock: Math.round(p.stock), reorderLevel: Math.round(p.reorderLevel), ...(p.warrantyMonths === undefined ? {} : { warrantyMonths: Math.round(p.warrantyMonths) }) };
    if (state.products.some(x => x.id !== normalized.id && x.sku.trim().toLowerCase() === normalized.sku.toLowerCase())
      || state.products.some(x => x.id !== normalized.id && x.barcode.trim() === normalized.barcode)) {
      pushAudit('DENIED', 'Product', `Blocked duplicate SKU/barcode for ${normalized.name}`);
      return false;
    }
    const shopId = getCloudShopId();
    const selectedBranchId = stateRef.current.settings.branchId || 'local-main';
    const multipleBranches = hasMultipleCachedBranches(shopId);
    const defaultBranchId = getDefaultBranchId(shopId) || 'local-main';
    const targetBranchId = selectedBranchId === 'local-main' ? defaultBranchId : selectedBranchId;
    const stockDelta = normalized.stock - (current?.stock || 0);
    if (multipleBranches && selectedBranchId === 'local-main' && stockDelta !== 0) {
      pushAudit('DENIED', 'Product', `Blocked stock edit for ${name}: select this POS branch before changing stock.`);
      return false;
    }

    if (stockDelta !== 0) {
      if (stockAdjustmentLockRef.current) {
        pushAudit('DENIED', 'Product', 'Another stock adjustment is in progress. Please wait before changing stock.');
        return false;
      }
      const branchBound = selectedBranchId !== 'local-main';
      const branchCacheReady = targetBranchId !== 'local-main' && hasCachedBranchStock(targetBranchId);
      if (branchBound) {
        const cachedQty = getCachedBranchStock(targetBranchId, normalized.id);
        if (!branchCacheReady || (exists && cachedQty === null) || (cachedQty !== null && cachedQty + stockDelta < 0)) {
          pushAudit('DENIED', 'Product', 'Blocked stock edit because selected-branch stock is missing or insufficient. Connect online and refresh Settings.');
          return false;
        }
      }
      stockAdjustmentLockRef.current = true;
      let cacheApplied = false;
      const adjustmentId = uid();
      try {
        if (exists && supabaseConfigured && getConnectivity() === 'online') {
          const shop = await ensureCloudShop('Nexfix Shop');
          if (!shop.ok || !shop.shopId) {
            pushAudit('DENIED', 'Product', 'Blocked stock edit: ' + (shop.error || 'Cloud shop is unavailable.'));
            return false;
          }
          // Ensure a legacy/local-only product exists in normalized cloud storage
          // at its old quantity before applying the idempotent delta.
          const catalog = await syncNormalizedCatalog({ ...stateRef.current, units: [] }, shop.shopId);
          if (!catalog.ok) {
            pushAudit('DENIED', 'Product', 'Blocked stock edit: ' + (catalog.error || 'Catalog sync failed.'));
            return false;
          }
          const cloudResult = await adjustBranchStockAtomic({
            shopId: shop.shopId, branchId: targetBranchId, deviceId: getMachineIdentity().id,
            productId: normalized.id, delta: stockDelta, note: 'Product editor stock change', adjustmentId,
          });
          if (!cloudResult.ok) {
            pushAudit('DENIED', 'Product', 'Cloud stock edit was not committed: ' + (cloudResult.error || 'unknown error'));
            return false;
          }
          if (branchCacheReady && applyBranchStockDeltas(targetBranchId, { [normalized.id]: stockDelta })) cacheApplied = true;
          try { await refreshCloudBranchStock(shop.shopId, targetBranchId); } catch { /* server remains authoritative */ }
        } else if (exists && supabaseConfigured) {
          if (branchCacheReady) {
            if (applyBranchStockDeltas(targetBranchId, { [normalized.id]: stockDelta })) cacheApplied = true;
            else if (branchBound) {
              pushAudit('DENIED', 'Product', 'Blocked offline stock edit because selected-branch cache changed concurrently.');
              return false;
            }
          } else if (branchBound) {
            pushAudit('DENIED', 'Product', 'Blocked offline stock edit because selected-branch stock is not cached.');
            return false;
          }
          try {
            await queueBranchStockAdjustment({
              shopId: shopId || undefined, branchId: targetBranchId, deviceId: getMachineIdentity().id,
              productId: normalized.id, delta: stockDelta, note: 'Product editor stock change', adjustmentId: uid(), baseProduct: current!,
            });
          } catch (error) {
            if (cacheApplied) applyBranchStockDeltas(targetBranchId, { [normalized.id]: -stockDelta });
            pushAudit('DENIED', 'Product', error instanceof Error ? error.message : 'Stock edit could not be queued safely.');
            return false;
          }
        } else if (branchBound) {
          if (!applyBranchStockDeltas(targetBranchId, { [normalized.id]: stockDelta })) {
            pushAudit('DENIED', 'Product', 'Blocked local stock edit because selected-branch stock would become negative.');
            return false;
          }
        } else if (branchCacheReady) {
          applyBranchStockDeltas(targetBranchId, { [normalized.id]: stockDelta });
        }
      } finally {
        stockAdjustmentLockRef.current = false;
      }
    } else if (!exists && selectedBranchId !== 'local-main') {
      if (!hasCachedBranchStock(selectedBranchId)) {
        pushAudit('DENIED', 'Product', 'Blocked initial stock because selected-branch stock cache is missing. Connect online and refresh Settings.');
        return false;
      }
      if (!applyBranchStockDeltas(selectedBranchId, { [normalized.id]: stockDelta })) {
        pushAudit('DENIED', 'Product', 'Blocked initial stock because selected-branch stock would become negative.');
        return false;
      }
    }
    let duplicate = false;
    setState(s => {
      const duplicateSku = s.products.some(x => x.id !== normalized.id && x.sku.trim().toLowerCase() === normalized.sku.toLowerCase());
      const duplicateBarcode = s.products.some(x => x.id !== normalized.id && x.barcode.trim() === normalized.barcode);
      if (duplicateSku || duplicateBarcode) { duplicate = true; return s; }
      const updatedProducts = s.products.some(x => x.id === normalized.id) ? s.products.map(x => x.id === normalized.id ? normalized : x) : [normalized, ...s.products];
      syncToGoogleDrive('Products', updatedProducts);
      return { ...s, products: updatedProducts };
    });
    if (duplicate) {
      pushAudit('DENIED', 'Product', `Blocked duplicate SKU/barcode for ${normalized.name}`);
      return false;
    }
    pushAudit(exists ? 'UPDATE' : 'CREATE', 'Product', `${exists ? 'Updated' : 'Added'} product ${normalized.name}`);
    return true;
  }, [can, pushAudit, state.products, user]);

  const deleteProduct = useCallback((id: string) => {
    if (!user || !can('act:manageStock')) { pushAudit('DENIED', 'Product', `Blocked product delete for ${id}`); return; }
    const p = state.products.find(x => x.id === id);
    if (!p) return;
    const referencedByHistory = state.sales.some(x => x.items.some(i => i.productId === id))
      || state.purchases.some(x => x.items.some(i => i.productId === id))
      || (state.purchaseReturns || []).some(x => x.items.some(i => i.productId === id))
      || state.exchanges.some(x => x.items.some(i => i.productId === id))
      || state.repairs.some(x => x.parts.some(part => part.productId === id))
      || (state.kitItems || []).some(x => x.kitProductId === id || x.componentProductId === id)
      || (state.quotations || []).some(x => x.items.some(i => i.productId === id))
      || (state.warrantyClaims || []).some(x => x.productName === p.name || (x.unitId && (state.units || []).some(u => u.id === x.unitId && u.productId === id)));
    if (p.stock > 0 || (state.units || []).some(u => u.productId === id) || referencedByHistory) {
      pushAudit('DENIED', 'Product', `Blocked deletion of ${p.name}: stock, tracked units, or historical references exist`);
      return;
    }
    setState(s => ({ ...s, products: s.products.filter(x => x.id !== id) }));
    pushAudit('DELETE', 'Product', `Deleted product ${p.name}`);
  }, [can, pushAudit, state.products, state.units, state.sales, state.purchases, state.purchaseReturns, state.exchanges, state.repairs, state.kitItems, state.quotations, state.warrantyClaims, user]);

  const adjustStock = useCallback(async (id: string, delta: number, reason: string): Promise<boolean> => {
    if (stockAdjustmentLockRef.current) { pushAudit('DENIED', 'Product', 'Another stock adjustment is already in progress.'); return false; }
    stockAdjustmentLockRef.current = true;
    try {
    if (!user || !can('act:manageStock')) { pushAudit('DENIED', 'Product', `Blocked stock adjustment for ${id}`); return false; }
    const amount = Number(delta);
    const note = String(reason || '').trim();
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount === 0 || !note) { pushAudit('DENIED', 'Product', `Blocked invalid stock adjustment for ${id}`); return false; }
    const p = stateRef.current.products.find(x => x.id === id);
    if (!p || !Number.isFinite(p.stock) || p.stock + amount < 0) { pushAudit('DENIED', 'Product', `Blocked stock adjustment below zero for ${id}`); return false; }
    const adjustmentId = uid();
    const shopId = getCloudShopId();
    const selectedBranchId = stateRef.current.settings.branchId || 'local-main';
    if (hasMultipleCachedBranches(shopId) && selectedBranchId === 'local-main') {
      pushAudit('DENIED', 'Product', 'Blocked stock adjustment because this shop has multiple branches and no branch is selected. Open Settings first.');
      return false;
    }
    const targetBranchId = selectedBranchId === 'local-main' ? (getDefaultBranchId(shopId) || 'local-main') : selectedBranchId;
    const branchBound = selectedBranchId !== 'local-main';
    const branchCacheReady = targetBranchId !== 'local-main' && hasCachedBranchStock(targetBranchId);
    if (branchBound) {
      const cachedQty = getCachedBranchStock(targetBranchId, id);
      if (!branchCacheReady || cachedQty === null || cachedQty + amount < 0) {
        pushAudit('DENIED', 'Product', 'Blocked stock adjustment because selected-branch stock is missing or insufficient. Connect online and refresh Settings.');
        return false;
      }
    }

    if (supabaseConfigured && getConnectivity() === 'online') {
      const shop = await ensureCloudShop('Nexfix Shop');
      if (!shop.ok || !shop.shopId) {
        pushAudit('DENIED', 'Product', 'Blocked stock adjustment: ' + (shop.error || 'Cloud shop is unavailable; stock was not changed.'));
        return false;
      }
      const cloudResult = await adjustBranchStockAtomic({ shopId: shop.shopId, branchId: targetBranchId, deviceId: getMachineIdentity().id, productId: id, delta: amount, note, adjustmentId });
      if (!cloudResult.ok) {
        pushAudit('DENIED', 'Product', 'Cloud stock adjustment was not committed: ' + (cloudResult.error || 'unknown error'));
        return false;
      }
      if (branchCacheReady && applyBranchStockDeltas(targetBranchId, { [id]: amount })) {
        try { await refreshCloudBranchStock(shop.shopId, targetBranchId); } catch { /* the delta is applied locally; refresh can retry */ }
      } else {
        try { await refreshCloudBranchStock(shop.shopId, targetBranchId); } catch { /* cloud remains authoritative; refresh can retry */ }
      }
    } else if (supabaseConfigured) {
      let cacheApplied = false;
      if (branchCacheReady) {
        if (applyBranchStockDeltas(targetBranchId, { [id]: amount })) cacheApplied = true;
        else if (branchBound) {
          pushAudit('DENIED', 'Product', 'Blocked stock adjustment because selected-branch stock changed concurrently.');
          return false;
        }
      } else if (branchBound) {
        pushAudit('DENIED', 'Product', 'Blocked offline stock adjustment because selected-branch stock is not cached.');
        return false;
      }
      try {
        await queueBranchStockAdjustment({ shopId: shopId || undefined, branchId: targetBranchId, deviceId: getMachineIdentity().id, productId: id, delta: amount, note, adjustmentId, baseProduct: p });
      } catch (error) {
        if (cacheApplied) applyBranchStockDeltas(targetBranchId, { [id]: -amount });
        pushAudit('DENIED', 'Product', error instanceof Error ? error.message : 'Stock adjustment could not be queued safely.');
        return false;
      }
    } else if (branchBound) {
      if (!applyBranchStockDeltas(targetBranchId, { [id]: amount })) {
        pushAudit('DENIED', 'Product', 'Blocked local stock adjustment because selected-branch stock is missing or would become negative.');
        return false;
      }
    } else if (branchCacheReady) {
      applyBranchStockDeltas(targetBranchId, { [id]: amount });
    }
    setStateWithInventoryLedger('STOCK_ADJUSTMENT', s => {
      const current = s.products.find(x => x.id === id);
      if (!current || !Number.isFinite(current.stock) || current.stock + amount < 0) return s;
      const updatedProducts = s.products.map(x => x.id === id ? { ...x, stock: x.stock + amount } : x);
      syncToGoogleDrive('Products', updatedProducts);
      return { ...s, products: updatedProducts };
    });
    pushAudit('STOCK', 'Product', `Stock ${amount >= 0 ? '+' : ''}${amount} for ${p.name} — ${note}`);
    return true;
    } finally {
      stockAdjustmentLockRef.current = false;
    }
  }, [can, pushAudit, setStateWithInventoryLedger, user]);

  /* ---------------- customers / suppliers ---------------- */
  const saveCustomer = useCallback((c: Customer) => {
  if (!user || (!can('page:customers') && !can('page:pos'))) { pushAudit('DENIED', 'Customer', `Blocked customer save for ${c.name || c.id}`); return; }
  const name = String(c.name || '').trim();
  const phone = String(c.phone || '').trim();
  const email = String(c.email || '').trim().toLowerCase();
  const nic = String(c.nic || '').trim();
  const tin = String(c.tin || '').trim();
  const address = String(c.address || '').trim();
  const creditLimit = c.creditLimit === undefined ? undefined : Number(c.creditLimit);
  const loyaltyPoints = Number(c.loyaltyPoints);
  if (!name || !phone || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) || !Number.isFinite(loyaltyPoints) || !Number.isInteger(loyaltyPoints) || loyaltyPoints < 0 || (creditLimit !== undefined && (!Number.isFinite(creditLimit) || creditLimit < 0))) {
    pushAudit('DENIED', 'Customer', `Blocked invalid customer input for ${c.id}`);
    return;
  }
  const existing = state.customers.find(x => x.id === c.id);
  let duplicate = false;
  setState(s => {
    const normalizedPhone = normalizeWhatsAppPhone(phone);
    const duplicatePhone = normalizedPhone.length >= 9 && s.customers.some(
      x => x.id !== c.id && normalizeWhatsAppPhone(x.phone) === normalizedPhone,
    );
    const duplicateNic = !!nic && s.customers.some(x => x.id !== c.id && (x.nic || '').trim().toLowerCase() === nic.toLowerCase());
    if (duplicatePhone || duplicateNic) { duplicate = true; return s; }
    const updated: Customer = existing
      ? { ...existing, name, phone, email: email || undefined, nic: nic || undefined, tin: tin || undefined, address: address || undefined, creditLimit: creditLimit && creditLimit > 0 ? Math.round(creditLimit * 100) / 100 : undefined }
      : { ...c, name, phone, email: email || undefined, nic: nic || undefined, tin: tin || undefined, address: address || undefined, creditBalance: 0, loyaltyPoints, creditLimit: creditLimit && creditLimit > 0 ? Math.round(creditLimit * 100) / 100 : undefined };
    const updatedCustomers = existing ? s.customers.map(x => x.id === c.id ? updated : x) : [updated, ...s.customers];
    syncToGoogleDrive('Customers', updatedCustomers);
    return { ...s, customers: updatedCustomers };
  });
  if (duplicate) pushAudit('DENIED', 'Customer', `Blocked duplicate phone/NIC for ${name}`);
  else pushAudit(existing ? 'UPDATE' : 'CREATE', 'Customer', `${existing ? 'Updated' : 'Created'} customer ${name}`);
}, [pushAudit, state.customers, user, can]);

  const deleteCustomer = useCallback((id: string) => {
  if (!user || (!can('page:customers') && !can('page:pos')) || !can('act:deleteRecords')) { pushAudit('DENIED', 'Customer', `Blocked customer delete for ${id}`); return; }
  const c = state.customers.find(x => x.id === id);
  if (!c) return;
  const referencedByHistory = state.sales.some(x => x.customerId === id)
    || (state.quotations || []).some(x => x.customerId === id)
    || (state.warrantyClaims || []).some(x => x.customerId === id)
    || state.repairs.some(x => x.customerId === id);
  if (c.creditBalance > 0 || referencedByHistory) {
    pushAudit('DENIED', 'Customer', `Blocked deletion of ${c.name}: balance or historical references exist`);
    return;
  }
  setState(s => ({ ...s, customers: s.customers.filter(x => x.id !== id) }));
  pushAudit('DELETE', 'Customer', `Deleted customer ${c.name}`);
}, [can, pushAudit, state.customers, state.quotations, state.repairs, state.sales, state.warrantyClaims, user]);

  const saveSupplier = useCallback((sp: Supplier) => {
  if (!user || !can('page:suppliers')) { pushAudit('DENIED', 'Supplier', `Blocked supplier save for ${sp.name || sp.id}`); return; }
  const name = String(sp.name || '').trim();
  const phone = String(sp.phone || '').trim();
  const email = String(sp.email || '').trim().toLowerCase();
  const contactPerson = String(sp.contactPerson || '').trim();
  const address = String(sp.address || '').trim();
  if (!name || !phone || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    pushAudit('DENIED', 'Supplier', `Blocked invalid supplier input for ${sp.id}`);
    return;
  }
  const exists = state.suppliers.some(x => x.id === sp.id);
  let duplicate = false;
  setState(s => {
    const normalizedPhone = phone.replace(/[\s()-]/g, '');
    const duplicatePhone = s.suppliers.some(x => x.id !== sp.id && x.phone.replace(/[\s()-]/g, '') === normalizedPhone);
    if (duplicatePhone) { duplicate = true; return s; }
    const normalized: Supplier = { ...sp, name, phone, email: email || undefined, contactPerson: contactPerson || undefined, address: address || undefined };
    const updatedSuppliers = exists ? s.suppliers.map(x => x.id === sp.id ? normalized : x) : [normalized, ...s.suppliers];
    syncToGoogleDrive('Suppliers', updatedSuppliers);
    return { ...s, suppliers: updatedSuppliers };
  });
  if (duplicate) pushAudit('DENIED', 'Supplier', `Blocked duplicate phone for ${name}`);
  else pushAudit(exists ? 'UPDATE' : 'CREATE', 'Supplier', `${exists ? 'Updated' : 'Created'} supplier ${name}`);
}, [pushAudit, state.suppliers, user, can]);

  const deleteSupplier = useCallback((id: string) => {
  if (!user || !can('page:suppliers') || !can('act:deleteRecords')) { pushAudit('DENIED', 'Supplier', `Blocked supplier delete for ${id}`); return; }
  const sp = state.suppliers.find(x => x.id === id);
  if (!sp) return;
  const referencedByHistory = state.purchases.some(x => x.supplierId === id)
    || (state.purchaseReturns || []).some(x => x.supplierId === id)
    || (state.supplierPayments || []).some(x => x.supplierId === id)
    || state.products.some(x => x.supplierId === id)
    || (state.grns || []).some(x => x.supplierId === id);
  if (referencedByHistory) {
    pushAudit('DENIED', 'Supplier', `Blocked deletion of ${sp.name}: linked products or purchase history exists`);
    return;
  }
  setState(s => ({ ...s, suppliers: s.suppliers.filter(x => x.id !== id) }));
  pushAudit('DELETE', 'Supplier', `Deleted supplier ${sp.name}`);
}, [can, pushAudit, state.products, state.purchases, state.purchaseReturns, state.supplierPayments, state.suppliers, state.grns, user]);

  const saveSupplierPayment = useCallback((p: Omit<import('./supplierPayments').SupplierPayment, 'id' | 'date' | 'by'>) => {
    if (supplierPaymentLockRef.current) {
      pushAudit('DENIED', 'SupplierPayment', 'Blocked duplicate supplier payment submission while another payment is being committed');
      return null;
    }
    if (!user || !can('page:suppliers')) {
      pushAudit('DENIED', 'SupplierPayment', 'Blocked supplier payment without supplier access');
      return null;
    }
    const amount = Math.round(Number(p.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const snapshot = stateRef.current;
    if (!snapshot.suppliers.some(s => s.id === p.supplierId)) return null;
    const purchase = p.purchaseId ? snapshot.purchases.find(x => x.id === p.purchaseId) : undefined;
    if (p.purchaseId && (!purchase || purchase.supplierId !== p.supplierId || purchase.status !== 'received')) {
      pushAudit('DENIED', 'SupplierPayment', 'Blocked payment with invalid or unrelated purchase');
      return null;
    }
    const purchaseTotal = snapshot.purchases.filter(x => x.supplierId === p.supplierId && x.status === 'received').reduce((sum, x) => sum + Math.max(0, Number(x.total) || 0), 0);
    const returnTotal = (snapshot.purchaseReturns || []).filter(x => x.supplierId === p.supplierId).reduce((sum, x) => sum + Math.max(0, Number(x.total) || 0), 0);
    const paidTotal = (snapshot.supplierPayments || []).filter(x => x.supplierId === p.supplierId).reduce((sum, x) => sum + Math.max(0, Number(x.amount) || 0), 0);
    const outstanding = Math.max(0, Math.round((purchaseTotal - returnTotal - paidTotal) * 100) / 100);
    if (amount > outstanding) return null;
    if (purchase) {
      const purchasePaid = (snapshot.supplierPayments || []).filter(x => x.purchaseId === purchase.id).reduce((sum, x) => sum + Math.max(0, Number(x.amount) || 0), 0);
      const purchaseReturns = (snapshot.purchaseReturns || []).filter(x => x.purchaseId === purchase.id).reduce((sum, x) => sum + Math.max(0, Number(x.total) || 0), 0);
      const purchaseOutstanding = Math.max(0, Math.round((Math.max(0, Number(purchase.total) || 0) - purchaseReturns - purchasePaid) * 100) / 100);
      if (amount > purchaseOutstanding) {
        pushAudit('DENIED', 'SupplierPayment', 'Blocked payment above selected purchase outstanding balance');
        return null;
      }
    }
    supplierPaymentLockRef.current = true;
    try {
      const payment: import('./supplierPayments').SupplierPayment = { ...p, amount, purchaseId: purchase?.id, id: uid(), date: new Date().toISOString(), by: user.name };
      setState(s => ({ ...s, supplierPayments: [payment, ...(s.supplierPayments || [])] }));
      pushAudit('CREATE', 'SupplierPayment', `Payment of Rs. ${payment.amount.toLocaleString()} to supplier ${snapshot.suppliers.find(s => s.id === p.supplierId)?.name || p.supplierId}`);
      return payment;
    } finally {
      supplierPaymentLockRef.current = false;
    }
  }, [pushAudit, user, can]);

  const saveCustomerCreditPayment = useCallback((p: { customerId: string; amount: number; method: Exclude<PaymentMethod, 'credit'>; methods?: PaymentLeg[]; note?: string; saleId?: string }): { ok: true; payment: CustomerCreditPayment } | { ok: false; error: string } => {
    const deny = (reason: string, audit: string) => {
      pushAudit('DENIED', 'CustomerCreditPayment', audit);
      return { ok: false as const, error: reason };
    };
    if (customerCreditPaymentLockRef.current) {
      return deny('A credit payment is already being saved. Please wait a moment.', 'Blocked duplicate settlement submission');
    }
    if (!user) {
      return deny('Your POS session has expired. Sign in again before collecting payment.', 'Blocked settlement without an authenticated user');
    }
    // Admins have full access through can(); other roles must have both page permissions.
    if (user.role !== 'admin' && (!can('page:customers') || !can('page:pos'))) {
      return deny('You do not have permission to collect credit payments. Ask an administrator to enable Customers and POS access.', 'Blocked settlement without customer and POS access');
    }

    const snapshot = stateRef.current;
    const today = dkey(new Date());
    const selectedBranchId = snapshot.settings.branchId || 'local-main';
    const defaultBranchId = getDefaultBranchId(getCloudShopId()) || 'local-main';
    const effectiveBranch = (branchId?: string) => !branchId || branchId === 'local-main' ? defaultBranchId : branchId;
    if (hasMultipleCachedBranches(getCloudShopId()) && selectedBranchId === 'local-main') {
      return deny('Select this POS branch in Settings before collecting credit payments.', 'Blocked credit settlement because no branch is selected');
    }
    const todaySession = snapshot.sessions.find(session =>
      session.cashierId === user.id && session.date === today &&
      effectiveBranch(session.branchId) === effectiveBranch(selectedBranchId),
    );
    if (!todaySession) {
      return deny("Open a cashier drawer session for today first. Go to Cashier Balance Report and open today's session.", 'Blocked credit settlement because today has no matching cashier session');
    }
    if (todaySession.closed) {
      return deny("Today's cashier drawer is already closed. Reopen the correct session only through the approved day-opening flow.", 'Blocked credit settlement because today session is closed');
    }
    if (todaySession.openingConfirmed === false) {
      return deny("Confirm today's opening float in Cashier Balance Report before collecting credit.", 'Blocked credit settlement because opening float is not confirmed');
    }

    const customer = snapshot.customers.find(x => x.id === p.customerId);
    if (!customer) return deny('Customer not found. Refresh the customer list and try again.', 'Blocked settlement for a missing customer');
    const amount = Math.round(Number(p.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      return deny('Enter a valid payment amount greater than Rs. 0.00.', 'Blocked invalid settlement amount');
    }
    const outstanding = Math.max(0, Math.round((Number(customer.creditBalance) || 0) * 100) / 100);
    if (outstanding <= 0) return deny('This customer has no outstanding credit balance.', `Blocked settlement for zero outstanding customer ${customer.name}`);
    if (amount > outstanding + 0.009) {
      return deny(`Amount exceeds customer outstanding (${'Rs. ' + outstanding.toLocaleString()}). Refresh the balance and enter a smaller amount.`, `Blocked settlement above customer outstanding for ${customer.name}`);
    }

    const rawMethods: PaymentLeg[] = Array.isArray(p.methods) && p.methods.length
      ? p.methods.map(leg => ({ method: leg.method, amount: Math.round(Number(leg.amount) * 100) / 100 }))
      : [{ method: p.method, amount }];
    const validMethods = new Set<Exclude<PaymentMethod, 'credit'>>(['cash', 'card', 'bank', 'mobile']);
    if (rawMethods.some(leg => !validMethods.has(leg.method as Exclude<PaymentMethod, 'credit'>) || !Number.isFinite(leg.amount) || leg.amount <= 0)
      || Math.abs(rawMethods.reduce((sum, leg) => sum + leg.amount, 0) - amount) > 0.009) {
      return deny('Payment split is invalid. Cash + Card (and any other tender legs) must equal the amount being collected.', 'Blocked settlement with invalid or mismatched tender amounts');
    }
    const methods = rawMethods as Array<{ method: Exclude<PaymentMethod, 'credit'>; amount: number }>;
    const previousPayments = snapshot.customerCreditPayments || [];
    let allocations: Array<{ saleId: string; billNo: string; amount: number }> = [];
    if (p.saleId) {
      const sale = snapshot.sales.find(x => x.id === p.saleId && x.customerId === customer.id && x.status === 'completed');
      if (!sale) return deny('Selected invoice was not found for this customer. Refresh and select the invoice again.', 'Blocked settlement for a missing or ineligible selected invoice');
      const invoiceDue = Math.min(getOpenCreditInvoiceBalance(sale, previousPayments), outstanding);
      if (invoiceDue <= 0.009) return deny('This invoice has no remaining credit due. Refresh the invoice list.', `Blocked settlement for paid invoice ${sale.billNo}`);
      if (amount > invoiceDue + 0.009) {
        return deny(`Amount exceeds selected invoice due (Rs. ${invoiceDue.toLocaleString()}). Reduce the amount or choose “Pay FIFO instead”.`, `Blocked settlement above selected invoice due for ${sale.billNo}`);
      }
      allocations = [{ saleId: sale.id, billNo: sale.billNo, amount }];
    } else {
      allocations = allocateCreditPaymentFIFO(customer.id, amount, snapshot.sales, previousPayments);
      const allocated = Math.round(allocations.reduce((sum, item) => sum + item.amount, 0) * 100) / 100;
      if (Math.abs(allocated - amount) > 0.009) {
        return deny('Could not allocate the full payment to open invoices. Refresh and check the customer’s invoice balances before retrying; no payment was saved.', `Blocked FIFO allocation mismatch for ${customer.name}: requested Rs. ${amount}, allocated Rs. ${allocated}`);
      }
    }
    const allocatedTotal = Math.round(allocations.reduce((sum, item) => sum + item.amount, 0) * 100) / 100;
    if (Math.abs(allocatedTotal - amount) > 0.009) {
      return deny('Could not allocate the full payment to open invoices. Refresh and retry; no payment was saved.', `Blocked incomplete invoice allocation for ${customer.name}`);
    }

    customerCreditPaymentLockRef.current = true;
    try {
      // Recheck the current balance immediately before committing to avoid an overpayment.
      const currentCustomer = stateRef.current.customers.find(x => x.id === customer.id);
      const currentOutstanding = Math.max(0, Math.round((Number(currentCustomer?.creditBalance) || 0) * 100) / 100);
      if (!currentCustomer || amount > currentOutstanding + 0.009) {
        return deny(`Customer outstanding changed to Rs. ${currentOutstanding.toLocaleString()}. Refresh the balance and retry.`, `Blocked stale credit settlement for ${customer.name}`);
      }
      const payment: CustomerCreditPayment = {
        id: uid(), customerId: customer.id, cashierId: user.id, amount, method: methods[0].method,
        methods: methods.length > 1 ? methods : undefined,
        allocations,
        date: new Date().toISOString(), by: user.name, note: p.note?.trim() || undefined,
      };
      const newBalance = Math.max(0, Math.round((currentOutstanding - amount) * 100) / 100);
      setState(s => ({
        ...s,
        customers: s.customers.map(x => x.id === customer.id ? { ...x, creditBalance: newBalance } : x),
        customerCreditPayments: [payment, ...(s.customerCreditPayments || [])],
      }));
      pushAudit('CREATE', 'CustomerCreditPayment', `Collected Rs. ${amount.toLocaleString()} from ${customer.name} by ${methods.map(x => x.method).join('+')}; outstanding Rs. ${newBalance.toLocaleString()}`);
      scheduleGoogleBackup(() => stateRef.current, 'settings');
      return { ok: true, payment };
    } finally {
      customerCreditPaymentLockRef.current = false;
    }
  }, [can, pushAudit, user]);

  const deleteSupplierPayment = useCallback((id: string) => {
    if (!user || !can('page:suppliers') || !can('act:deleteRecords')) {
      pushAudit('DENIED', 'SupplierPayment', 'Blocked supplier payment delete without required permissions');
      return;
    }
    const payment = (state.supplierPayments || []).find(x => x.id === id);
    if (!payment) return;
    setState(s => ({ ...s, supplierPayments: (s.supplierPayments || []).filter(x => x.id !== id) }));
    pushAudit('DELETE', 'SupplierPayment', `Deleted supplier payment ${id}`);
  }, [can, state.supplierPayments, pushAudit, user]);

  /* ---------------- sales ---------------- */
  const completeSale = useCallback((input: NewSaleInput): Sale | null => {
    if (!user || !can('page:pos') || input.lines.length === 0) {
      if (user && !can('page:pos')) pushAudit('DENIED', 'Sale', 'Blocked sale completion without POS access');
      return null;
    }
    const selectedBranchId = state.settings.branchId || 'local-main';
    const shopIdForBranch = getCloudShopId();
    if (hasMultipleCachedBranches(shopIdForBranch) && selectedBranchId === 'local-main') {
      pushAudit('DENIED', 'Sale', 'Blocked sale because this shop has multiple branches and no branch is selected. Open Settings and select this POS branch.');
      return null;
    }
    const defaultBranchId = getDefaultBranchId(shopIdForBranch) || 'local-main';
    const todaySession = state.sessions.find(x => x.cashierId === user.id && x.date === dkey(new Date()) && ((x.branchId || 'local-main') === selectedBranchId || ((x.branchId || 'local-main') === 'local-main' && selectedBranchId === defaultBranchId)));
    if (!todaySession || todaySession.closed || todaySession.openingConfirmed === false) {
      pushAudit('DENIED', 'Sale', 'Blocked sale because today\'s cash session is not open or opening float is not confirmed');
      return null;
    }
    const s = state;
    if (selectedBranchId !== 'local-main' && !hasCachedBranchStock(selectedBranchId)) {
      pushAudit('DENIED', 'Sale', 'Blocked offline sale because this branch stock cache is missing. Connect online and open Settings to refresh branch stock.');
      return null;
    }
    const availableForBranch = (product: Product) => {
      if (selectedBranchId === 'local-main') return product.stock;
      return getCachedBranchStock(selectedBranchId, product.id) ?? 0;
    };
    const saleLines = applyCategoryPromotions(input.lines, s.products, s.settings);
    const items: SaleItem[] = [];
    const tradeIn = input.tradeIn;
    const rawTradeInValue = tradeIn ? Math.max(0, Number(tradeIn.value) || 0) : 0;
    if (tradeIn && (!tradeIn.productId || !Number.isFinite(tradeIn.value) || tradeIn.value <= 0)) return null;
    const tradeInProduct = tradeIn ? s.products.find(p => p.id === tradeIn.productId && p.active) : undefined;
    if (tradeIn && !tradeInProduct) return null;
    if (tradeIn?.addToInventory) {
      if (tradeInProduct!.trackImei && !tradeIn.imei?.trim()) return null;
      if (tradeInProduct!.trackSerial && !tradeIn.serial?.trim()) return null;
      if (!tradeInProduct!.trackImei && !tradeInProduct!.trackSerial) return null;
      const duplicate = (s.units || []).some(u => u.status === 'in_stock' && ((tradeIn.imei && u.imei === tradeIn.imei.trim()) || (tradeIn.serial && u.serial === tradeIn.serial.trim())));
      if (duplicate) return null;
    }
    const soldUnitIds: string[] = [];
    const requestedQtyByProduct = new Map<string, number>();
    const requiredComponentQty = new Map<string, number>();
    for (const l of saleLines) {
      const p = s.products.find(x => x.id === l.productId);
      if (!p) return null;
      if (!Number.isFinite(l.qty) || l.qty <= 0) return null;
      // Aggregate duplicate cart lines before validating stock so the same product
      // cannot consume more stock than is actually available.
      const requestedQty = (requestedQtyByProduct.get(l.productId) || 0) + l.qty;
      const kitLines = p.isKit ? (s.kitItems || []).filter(k => k.kitProductId === p.id && Number.isFinite(k.qty) && k.qty > 0) : [];
      // A kit is stocked through its BOM components. A kit without a BOM keeps
      // the legacy product-stock behaviour so existing catalog data remains safe.
      if (!kitLines.length && requestedQty > availableForBranch(p)) return null;
      requestedQtyByProduct.set(l.productId, requestedQty);
      if (kitLines.length) {
        for (const kitLine of kitLines) {
          requiredComponentQty.set(
            kitLine.componentProductId,
            (requiredComponentQty.get(kitLine.componentProductId) || 0) + kitLine.qty * l.qty,
          );
        }
      }
      // IMEI/serial tracked products MUST supply matching in-stock unit ids
      if (p.trackImei || p.trackSerial) {
        if (!l.unitIds || l.unitIds.length !== l.qty) return null;
        for (const uid_ of l.unitIds) {
          const u = (s.units || []).find(x => x.id === uid_ && x.productId === p.id && x.status === 'in_stock');
          if (!u) return null;
          const unitBranchId = u.branchId && u.branchId !== 'local-main' ? u.branchId : (getDefaultBranchId(getCloudShopId()) || 'local-main');
          if (selectedBranchId !== 'local-main' && unitBranchId !== selectedBranchId) return null;
          if (soldUnitIds.includes(uid_)) return null; // same unit twice
          soldUnitIds.push(uid_);
        }
      }
      const unitPrice = l.price !== undefined && l.price >= 0 ? l.price : p.price;
      const gross = unitPrice * l.qty;
      const matchedUnits = (l.unitIds || [])
        .map(id => (s.units || []).find(u => u.id === id))
        .filter(Boolean) as InventoryUnit[];
      items.push({
        productId: p.id, name: p.name, qty: l.qty, price: unitPrice, cost: p.cost,
        discount: Math.min(Math.max(l.discount || 0, 0), gross),
        priceOverridden: unitPrice !== p.price || undefined,
        unitIds: l.unitIds,
        imeis: matchedUnits.map(u => u.imei).filter(Boolean) as string[],
        serials: matchedUnits.map(u => u.serial).filter(Boolean) as string[],
      });
    }
    // Validate component availability after aggregating all kit lines and
    // direct component sales in the same cart.
    for (const [componentId, kitQty] of requiredComponentQty) {
      const component = s.products.find(x => x.id === componentId);
      if (!component) return null;
      const directQty = requestedQtyByProduct.get(componentId) || 0;
      const kitDirectOverlap = s.products.find(x => x.id === componentId)?.isKit ? 0 : directQty;
      if (kitQty + kitDirectOverlap > availableForBranch(component)) return null;
    }

    const grossTotal = items.reduce((sum, it) => sum + it.price * it.qty, 0);
    const lineDiscount = items.reduce((sum, it) => sum + (it.discount || 0), 0);
    const subtotal = grossTotal - lineDiscount;
    const discount = Math.min(input.discount || 0, subtotal);
    const shipping = Math.max(0, input.shipping || 0);
    // Trade-in is sent to cloud as an additional discount, so calculate tax on the
    // same post-trade-in taxable base locally to prevent local/cloud total drift.
    const tradeInValue = Math.min(rawTradeInValue, Math.max(0, subtotal - discount));
    const taxableSubtotal = Math.max(0, subtotal - discount - tradeInValue);
    const tax = Math.round((taxableSubtotal * (input.taxPct || 0)) / 100 * 100) / 100;
    const cust = input.customerId ? s.customers.find(c => c.id === input.customerId) : undefined;
    const pointsRedeemed = Math.min(
      Math.max(0, Math.floor(input.pointsRedeemed || 0)),
      cust?.loyaltyPoints || 0,
    );
    const loyaltyPointValue = Math.max(0, Number(s.settings.loyaltyPointValue ?? POINT_VALUE));
    const pointsValue = pointsRedeemed * loyaltyPointValue;
    const preTotal = taxableSubtotal + tax + shipping;
    const appliedPointsValue = Math.min(pointsValue, Math.max(0, preTotal));
    const total = Math.max(0, Math.round((preTotal - appliedPointsValue) * 100) / 100);
    // Gross margin − discounts − loyalty value actually applied (+ shipping is revenue).
    const profit = Math.round((
      items.reduce((sum, it) => sum + (it.price - it.cost) * it.qty, 0)
      - lineDiscount - discount - appliedPointsValue - tradeInValue + shipping
    ) * 100) / 100;
    const loyaltyPointsPerRs = Math.max(0, Number(s.settings.loyaltyPointsPerRs ?? 0.001));
    const pointsEarned = cust ? Math.floor(Math.max(0, total) * loyaltyPointsPerRs) : 0;
    const maxSaleSeq = s.sales.reduce((m, x) => {
      const n = parseInt(x.billNo.split('-').pop() || '0', 10);
      return Number.isFinite(n) ? Math.max(m, n) : m;
    }, 0);
    const seq = Math.max(s.counters.bill, maxSaleSeq + 1);
    const billNo = input._billNo || `NFX-${dkey(new Date()).replaceAll('-', '')}-${String(seq).slice(-4)}`;
    const salesman = input.salesmanId
      ? s.users.find(u => u.id === input.salesmanId && u.active)
      : undefined;
    const byUser = salesman || user;
    const validPaymentMethods = new Set<PaymentMethod>(['cash', 'card', 'bank', 'mobile', 'credit']);
    if (!validPaymentMethods.has(input.payment)) return null;
    const rawLegs = Array.isArray(input.payments) ? input.payments : [];
    if (rawLegs.some(l => !l || !validPaymentMethods.has(l.method) || !Number.isFinite(l.amount) || l.amount < 0)) return null;
    const legs = rawLegs.filter(l => l.amount > 0).map(l => ({ method: l.method, amount: Math.round(l.amount * 100) / 100 }));
    const isSplit = legs.length > 1;
    if (isSplit && legs.some(l => l.method === 'credit')) return null;
    if (isSplit && Math.abs(legs.reduce((a, l) => a + l.amount, 0) - Math.max(0, Number(input.amountPaid) || 0)) > 0.01) return null;
    const isCredit = legs.some(l => l.method === 'credit') || input.payment === 'credit';
    if (isCredit) {
      if (!cust) return null;
      const creditLimit = cust.creditLimit ?? 0;
      const projectedBalance = cust.creditBalance + Math.max(0, total - (isSplit ? legs.filter(l => l.method !== 'credit').reduce((a, l) => a + l.amount, 0) : input.amountPaid));
      if (creditLimit > 0 && projectedBalance > creditLimit) return null;
    }
    const amountPaid = isSplit
      ? legs.reduce((a, l) => a + l.amount, 0)
      : (isCredit ? input.amountPaid : Math.max(input.amountPaid, total));
    if (isCredit && amountPaid > total) return null;
    const balanceDue = isCredit ? Math.max(0, total - amountPaid) : 0;
    // PHASE1_MACHINE_TRACKING_V1
    const machine = getMachineIdentity();
    const tradeInUnitId = tradeIn?.addToInventory ? uid() : undefined;
    const sale: Sale = {
      id: input._saleId || uid(), branchId: stateRef.current.settings.branchId || 'local-main', billNo, date: new Date().toISOString(),
      cashierId: byUser.id, cashierName: byUser.name,
      salesmanId: input.salesmanId || undefined,
      machineId: machine.id, machineName: machine.name,
      note: input.note?.trim() || undefined,
      customerId: cust?.id, customerName: cust?.name || 'Walk-in customer',
      items, subtotal, discount, tax, shipping: shipping || undefined, total,
      payment: balanceDue > 0.009 ? 'credit' : (legs[0]?.method || input.payment),
      payments: legs.length > 0 ? legs.filter(l => l.method !== 'credit') : undefined,
      pointsRedeemed: pointsRedeemed || undefined,
      pointsEarned: pointsEarned || undefined,
      amountPaid, change: isCredit ? 0 : Math.max(0, amountPaid - total),
      profit,
      tradeIn: tradeIn ? { ...tradeIn, value: tradeInValue, imei: tradeIn.imei?.trim() || undefined, serial: tradeIn.serial?.trim() || undefined, unitId: tradeInUnitId } : undefined,
      status: 'completed',
    };

    // Deduct direct product stock plus BOM component stock. Kit products with
    // components are not decremented themselves; their components are consumed.
    const updatedProducts = s.products.map(p => {
      const directQty = requestedQtyByProduct.get(p.id) || 0;
      const kitComponentQty = requiredComponentQty.get(p.id) || 0;
      const hasKitBom = !!p.isKit && (s.kitItems || []).some(k => k.kitProductId === p.id && Number.isFinite(k.qty) && k.qty > 0);
      const qty = (hasKitBom ? 0 : directQty) + kitComponentQty;
      return qty > 0 ? { ...p, stock: Math.max(0, p.stock - qty) } : p;
    });
    const tradeInUnit = tradeInUnitId && tradeIn ? {
      id: tradeInUnitId, productId: tradeIn.productId, branchId: sale.branchId, imei: tradeIn.imei?.trim() || undefined, serial: tradeIn.serial?.trim() || undefined,
      status: 'in_stock' as const, cost: tradeInValue, note: 'Trade-in', createdAt: sale.date,
    } : undefined;
    const productsAfterTradeIn = tradeInUnit
      ? updatedProducts.map(p => p.id === tradeInUnit.productId ? { ...p, stock: p.stock + 1 } : p)
      : updatedProducts;
    if (selectedBranchId !== 'local-main') {
      const deltas: Record<string, number> = {};
      for (const nextProduct of productsAfterTradeIn) {
        const previous = s.products.find(product => product.id === nextProduct.id);
        const delta = nextProduct.stock - (previous?.stock ?? nextProduct.stock);
        if (delta) deltas[nextProduct.id] = delta;
      }
      if (Object.keys(deltas).length && !applyBranchStockDeltas(selectedBranchId, deltas)) {
        pushAudit('DENIED', 'Sale', 'Blocked sale because cached branch stock is insufficient or stale.');
        return null;
      }
    }

    setStateWithInventoryLedger('SALE', prev => ({
      ...prev,
      products: productsAfterTradeIn,
      customers: prev.customers.map(c =>
        c.id === cust?.id
          ? {
              ...c,
              creditBalance: c.creditBalance + balanceDue,
              loyaltyPoints: Math.max(0, c.loyaltyPoints - pointsRedeemed) + pointsEarned,
            }
          : c,
      ),
      units: [
        ...(tradeInUnit ? [tradeInUnit] : []),
        ...(prev.units || []).map(u => soldUnitIds.includes(u.id)
          ? { ...u, branchId: u.branchId || getDefaultBranchId(getCloudShopId()) || 'local-main', status: 'sold' as const, saleId: sale.id, saleBillNo: billNo, soldAt: sale.date }
          : u,
        ),
      ],
      sales: [sale, ...prev.sales],
      counters: { ...prev.counters, bill: prev.counters.bill + 1 },
    }));

    // Auto-Sync to Google Sheet (Sales & Products Inventory)
    syncToGoogleDrive('SalesHistory', [sale]);
    syncToGoogleDrive('Products', updatedProducts);
    scheduleGoogleBackup(() => stateRef.current, 'sale');

    pushAudit(
      'SALE', 'Sale',
      `Bill ${billNo} · ${input.lines.length} item(s) · Rs. ${total.toLocaleString()}${tradeInValue ? ` · trade-in Rs. ${tradeInValue.toLocaleString()}` : ''}${soldUnitIds.length ? ` · ${soldUnitIds.length} unit(s)` : ''}${isSplit ? ` · split (${legs.map(l => l.method).join('+')})` : ''}${input.note?.trim() ? ' · note: ' + input.note.trim().slice(0, 40) : ''}${items.some(i => i.priceOverridden) ? ' · price override' : ''}`,
    );
    return sale;
  }, [user, state, pushAudit, can]);

  const completeSaleCloud = useCallback(async (input: NewSaleInput): Promise<Sale | null> => {
    if (!user || !can('page:pos') || input.lines.length === 0) {
      if (user && !can('page:pos')) pushAudit('DENIED', 'Sale', 'Blocked cloud sale completion without POS access');
      return null;
    }
    const selectedBranchId = stateRef.current.settings.branchId || 'local-main';
    const defaultBranchId = getDefaultBranchId(getCloudShopId()) || 'local-main';
    const todaySession = stateRef.current.sessions.find(session => session.cashierId === user.id && session.date === dkey(new Date()) && ((session.branchId || 'local-main') === selectedBranchId || ((session.branchId || 'local-main') === 'local-main' && selectedBranchId === defaultBranchId)));
    if (!todaySession || todaySession.closed || todaySession.openingConfirmed === false) {
      pushAudit('DENIED', 'Sale', 'Blocked cloud sale because today\'s cash session is not open or opening float is not confirmed');
      return null;
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) return completeSale(input);
    const shop = await ensureCloudShop('Nexfix Shop');
    if (!shop.ok || !shop.shopId) {
      if (shop.error === 'Cloud authentication is not configured' || shop.error === 'Cloud session is not available' || shop.error === 'offline') {
        return completeSale(input);
      }
      return null;
    }
    const saleLines = applyCategoryPromotions(input.lines, state.products, state.settings);
    const tradeIn = input.tradeIn;
    const tradeInValue = tradeIn ? Math.max(0, Number(tradeIn.value) || 0) : 0;
    if (tradeIn && (!tradeIn.productId || tradeInValue <= 0)) return null;
    const tradeInProduct = tradeIn ? state.products.find(p => p.id === tradeIn.productId && p.active) : undefined;
    if (tradeIn && !tradeInProduct) return null;
    if (tradeIn?.addToInventory) {
      if (tradeInProduct!.trackImei && !tradeIn.imei?.trim()) return null;
      if (tradeInProduct!.trackSerial && !tradeIn.serial?.trim()) return null;
      if (!tradeInProduct!.trackImei && !tradeInProduct!.trackSerial) return null;
      const duplicate = (state.units || []).some(u => u.status === 'in_stock' && ((tradeIn.imei && u.imei === tradeIn.imei.trim()) || (tradeIn.serial && u.serial === tradeIn.serial.trim())));
      if (duplicate) return null;
    }

    if (user.role === 'admin' || user.role === 'manager') {
      const catalog = await syncNormalizedCatalog(state, shop.shopId);
      if (!catalog.ok) return null;
    }
    const localSalesman = input.salesmanId
      ? state.users.find(u => u.id === input.salesmanId && u.active)
      : user;
    const cloudSalesmanId = await resolveCloudSalesmanId(shop.shopId, localSalesman);

    const pendingKey = 'nexfix_pending_cloud_sale_v2';
    const fingerprint = JSON.stringify({
      lines: saleLines.map(l => ({ productId: l.productId, qty: l.qty, discount: l.discount || 0, price: l.price, unitIds: l.unitIds || [] })),
      customerId: input.customerId || null, discount: (input.discount || 0) + tradeInValue, taxPct: input.taxPct || 0,
      shipping: input.shipping || 0, pointsRedeemed: input.pointsRedeemed || 0,
      payment: input.payment, amountPaid: input.amountPaid, creditDue: input.creditDue || 0,
      payments: (input.payments || []).map(p => ({ method: p.method, amount: p.amount })),
      note: input.note || '', salesmanId: cloudSalesmanId || null,
    });
    let saleId = input._saleId || '';
    let tradeInUnitId = tradeIn?.addToInventory ? '' : undefined;
    try {
      const raw = localStorage.getItem(pendingKey);
      if (raw) {
        const pending = JSON.parse(raw) as { saleId?: string; fingerprint?: string; tradeInUnitId?: string };
        if (!saleId && pending.saleId && pending.fingerprint === fingerprint) saleId = pending.saleId;
        if (tradeIn?.addToInventory && pending.saleId === saleId && pending.fingerprint === fingerprint && pending.tradeInUnitId) {
          tradeInUnitId = pending.tradeInUnitId;
        }
      }
    } catch { /* ignore malformed pending state */ }
    if (!saleId) saleId = uid();
    if (tradeIn?.addToInventory && !tradeInUnitId) tradeInUnitId = uid();
    try { localStorage.setItem(pendingKey, JSON.stringify({ saleId, fingerprint, tradeInUnitId })); } catch { /* ignore */ }

    const payments: PaymentLeg[] = (input.payments || [])
      .filter(p => p.amount > 0 && p.method !== 'credit')
      .map(p => ({ method: p.method, amount: Math.round(p.amount * 100) / 100 }));
    if (input.payment === 'credit' && (input.creditDue || 0) > 0.009) {
      payments.push({ method: 'credit', amount: Math.round((input.creditDue || 0) * 100) / 100 });
    } else if (payments.length === 0 && input.payment !== 'credit' && input.amountPaid > 0) {
      payments.push({ method: input.payment, amount: Math.round(input.amountPaid * 100) / 100 });
    }
    const cloud = await completeSaleAtomic({
      shopId: shop.shopId, branchId: stateRef.current.settings.branchId || 'local-main', deviceId: getMachineIdentity().id, saleId, customerId: input.customerId, shipping: input.shipping,
      discount: (input.discount || 0) + tradeInValue, taxPct: input.taxPct, pointsRedeemed: input.pointsRedeemed,
      note: input.note, salesmanId: cloudSalesmanId,
      lines: saleLines.map(l => ({ product_id: l.productId, qty: l.qty, discount: l.discount, price: l.price, unit_ids: l.unitIds })),
      payments,
    });
    if (!cloud.ok) throw new Error(cloud.error || 'Cloud sale could not be completed');
    if (!cloud.saleId || !cloud.billNo || cloud.saleId !== saleId || !cloud.committed?.sale) throw new Error('Cloud sale was committed without a complete receipt response');
    const committed = cloud.committed;
    if (tradeIn?.addToInventory) {
      const tradeInCloud = await registerTradeInAtomic({
        shopId: shop.shopId,
        saleId,
        unitId: tradeInUnitId!,
        productId: tradeIn.productId,
        value: tradeInValue,
        imei: tradeIn.imei?.trim() || undefined,
        serial: tradeIn.serial?.trim() || undefined,
      });
      if (!tradeInCloud.ok) throw new Error(tradeInCloud.error || 'Cloud trade-in could not be registered. The sale is committed; retry the bill to finish trade-in reconciliation.');
    }

    const row = committed.sale;
    const n = (v: unknown, fallback = 0) => { const x = Number(v); return Number.isFinite(x) ? x : fallback; };
    const productRows = new Map(committed.products.map(p => [String(p.id), p]));
    const unitRows = new Map(committed.units.map(u => [String(u.id), u]));
    const committedItems: SaleItem[] = committed.items.map(item => {
      const product = productRows.get(String(item.product_id));
      const ids = Array.isArray(item.unit_ids) ? item.unit_ids.map(String) : [];
      return {
        productId: String(item.product_id), name: String(item.name ?? product?.name ?? 'Item'), qty: n(item.qty),
        price: n(item.price), cost: n(item.cost ?? product?.cost), discount: n(item.discount),
        priceOverridden: item.price_overridden === true || undefined, unitIds: ids.length ? ids : undefined,
        imeis: ids.map(id => unitRows.get(id)?.imei).filter(Boolean) as string[],
        serials: ids.map(id => unitRows.get(id)?.serial).filter(Boolean) as string[],
        warrantyMonths: product ? n(product.warranty_months) || undefined : undefined,
      };
    });
    const paymentRows: PaymentLeg[] = committed.payments.map(p => ({ method: String(p.method) as PaymentMethod, amount: n(p.amount) }));
    const sale: Sale = {
      id: String(row.id), branchId: String(row.branch_id || stateRef.current.settings.branchId || 'local-main'), billNo: String(row.bill_no ?? cloud.billNo), date: String(row.created_at ?? new Date().toISOString()),
      cashierId: String(row.cashier_id ?? user.id), cashierName: String(row.cashier_name ?? user.name),
      machineId: getMachineIdentity().id, machineName: getMachineIdentity().name,
      customerId: row.customer_id ? String(row.customer_id) : undefined,
      customerName: String(row.customer_name ?? committed.customer?.name ?? 'Walk-in customer'),
      items: committedItems, subtotal: n(row.subtotal), discount: Math.max(0, n(row.discount) - tradeInValue), tax: n(row.tax),
      shipping: n(row.shipping) || undefined, total: n(row.total),
      payment: n(row.total) - n(row.amount_paid) > 0.009 ? 'credit' : (paymentRows.length > 1 ? paymentRows[0].method : (paymentRows[0]?.method || input.payment)),
      payments: paymentRows.filter(p => p.method !== 'credit').length > 0 ? paymentRows.filter(p => p.method !== 'credit') : undefined,
      pointsRedeemed: n(row.points_redeemed) || undefined, pointsEarned: n(row.points_earned) || undefined,
      note: row.note ? String(row.note) : undefined,
      tradeIn: tradeIn ? { ...tradeIn, value: tradeInValue, imei: tradeIn.imei?.trim() || undefined, serial: tradeIn.serial?.trim() || undefined, unitId: tradeInUnitId } : undefined, amountPaid: n(row.amount_paid), change: n(row.change_amount),
      profit: n(row.profit), status: 'completed',
    };

    setStateWithInventoryLedger('SALE', prev => {
      if (prev.sales.some(x => x.id === sale.id)) return prev;
      const maxSaleSeq = prev.sales.reduce((m, x) => {
        const seq = parseInt(x.billNo.split('-').pop() || '0', 10);
        return Number.isFinite(seq) ? Math.max(m, seq) : m;
      }, 0);
      const billSeq = parseInt(sale.billNo.split('-').pop() || '0', 10);
      const productUpdates = new Map<string, Product>();
      for (const [id, product] of productRows) {
        const local = prev.products.find(p => p.id === id);
        if (!local) continue;
        productUpdates.set(id, {
          ...local, name: String(product.name ?? local.name), sku: String(product.sku ?? local.sku ?? ''),
          barcode: String(product.barcode ?? local.barcode ?? ''), cost: n(product.cost, local.cost),
          price: n(product.price, local.price), stock: n(product.stock, local.stock),
          reorderLevel: n(product.reorder_level, local.reorderLevel), trackImei: product.track_imei === true,
          trackSerial: product.track_serial === true, trackExpiry: product.track_expiry === true,
          warrantyMonths: n(product.warranty_months, local.warrantyMonths || 0) || undefined,
          isKit: product.is_kit === true, isService: product.is_service === true, active: product.active !== false,
          attributes: (product.attributes && typeof product.attributes === 'object') ? product.attributes as Product['attributes'] : local.attributes,
        });
      }
      const customer = committed.customer;
      const updatedCustomers = customer?.id
        ? prev.customers.map(c => c.id === String(customer.id) ? {
            ...c, name: String(customer.name ?? c.name), phone: String(customer.phone ?? c.phone ?? ''),
            email: customer.email ? String(customer.email) : c.email, nic: customer.nic ? String(customer.nic) : c.nic,
            address: customer.address ? String(customer.address) : c.address,
            creditLimit: n(customer.credit_limit, c.creditLimit ?? 0), creditBalance: n(customer.credit_balance, c.creditBalance),
            loyaltyPoints: n(customer.loyalty_points, c.loyaltyPoints),
          } : c)
        : prev.customers;
      const tradeInUnit = tradeInUnitId && tradeIn ? {
        id: tradeInUnitId, productId: tradeIn.productId, imei: tradeIn.imei?.trim() || undefined, serial: tradeIn.serial?.trim() || undefined,
        status: 'in_stock' as const, cost: tradeInValue, note: 'Trade-in', createdAt: sale.date,
      } : undefined;
      const updatedUnits = [
        ...(tradeInUnit ? [tradeInUnit] : []),
        ...(prev.units || []).map(u => {
        const remote = unitRows.get(u.id);
        if (!remote) return u;
        return {
          ...u, productId: String(remote.product_id ?? u.productId), imei: remote.imei ? String(remote.imei) : u.imei,
          serial: remote.serial ? String(remote.serial) : u.serial, expiryDate: remote.expiry_date ? String(remote.expiry_date) : u.expiryDate,
          status: String(remote.status ?? u.status) as InventoryUnit['status'], saleId: remote.sale_id ? String(remote.sale_id) : undefined,
          saleBillNo: remote.sale_bill_no ? String(remote.sale_bill_no) : undefined, soldAt: remote.sold_at ? String(remote.sold_at) : undefined,
          cost: remote.cost == null ? u.cost : n(remote.cost), warrantyExpiresAt: remote.warranty_expires_at ? String(remote.warranty_expires_at) : u.warrantyExpiresAt,
          note: remote.note ? String(remote.note) : u.note,
        };
      }),
      ];
      if (tradeInUnit) {
        const existingTradeInProduct = productUpdates.get(tradeInUnit.productId) || prev.products.find(p => p.id === tradeInUnit.productId);
        if (existingTradeInProduct) productUpdates.set(tradeInUnit.productId, { ...existingTradeInProduct, stock: existingTradeInProduct.stock + 1 });
      }
      return {
        ...prev, products: prev.products.map(p => productUpdates.get(p.id) || p), customers: updatedCustomers, units: updatedUnits,
        sales: [sale, ...prev.sales], counters: { ...prev.counters, bill: Math.max(prev.counters.bill, maxSaleSeq, Number.isFinite(billSeq) ? billSeq : 0) + 1 },
      };
    });
    // The pending marker is only for crash/retry idempotency. Once the sale
    // has been reconciled into local state, never reuse its saleId for a later
    // identical-looking bill.
    try { localStorage.removeItem(pendingKey); } catch { /* optional cleanup */ }
    syncToGoogleDrive('SalesHistory', [sale]);
    syncToGoogleDrive('Products', committed.products);
    scheduleGoogleBackup(() => stateRef.current, 'sale');
    pushAudit('SALE', 'Sale', `Cloud bill ${sale.billNo} · authoritative reconciliation · ${committedItems.length} item(s)`);
    return sale;
  }, [user, state, pushAudit, completeSale, can]);

  const refundSale = useCallback(async (saleId: string): Promise<boolean> => {
    if (!user || !can('act:refund')) {
      pushAudit('DENIED', 'Sale', 'Blocked refund without refund permission');
      return false;
    }
    const sale = state.sales.find(x => x.id === saleId);
    if (!sale || sale.status !== 'completed') return false;

    const priorReturnedByLine = new Map<number, number>();
    for (const ex of state.exchanges.filter(x => x.billNo === sale.billNo)) {
      for (const item of ex.items) if (item.itemIdx !== undefined) {
        priorReturnedByLine.set(item.itemIdx, (priorReturnedByLine.get(item.itemIdx) || 0) + item.qty);
      }
    }
    const remainingItems = sale.items.map((it, idx) => ({ it, idx, qty: Math.max(0, it.qty - (priorReturnedByLine.get(idx) || 0)) })).filter(x => x.qty > 0);
    if (remainingItems.length === 0) return false;

    const refundQtyByProduct = new Map<string, number>();
    for (const { it, qty } of remainingItems) refundQtyByProduct.set(it.productId, (refundQtyByProduct.get(it.productId) || 0) + qty);
    const merchandiseGross = remainingItems.reduce((sum, { it, qty }) => sum + it.price * qty, 0);
    const merchandiseDiscount = remainingItems.reduce((sum, { it, qty }) => sum + (it.qty > 0 ? (it.discount || 0) * (qty / it.qty) : 0), 0);
    const returnedMerchandise = Math.max(0, merchandiseGross - merchandiseDiscount);
    const saleSubtotal = Math.max(0, sale.subtotal);
    const saleDiscount = Math.min(Math.max(0, sale.discount || 0), saleSubtotal);
    const postDiscountSubtotal = Math.max(0, saleSubtotal - saleDiscount);
    const allocatedDiscount = Math.min(saleDiscount, returnedMerchandise * (saleSubtotal > 0 ? saleDiscount / saleSubtotal : 0));
    const taxableReturned = Math.max(0, returnedMerchandise - allocatedDiscount);
    const taxRefund = postDiscountSubtotal > 0 ? Math.round((sale.tax || 0) * (taxableReturned / postDiscountSubtotal) * 100) / 100 : 0;
    // Trade-in is stored separately from the local sale discount, but it reduces the
    // amount the customer actually paid. Allocate that reduction proportionally to
    // the returned merchandise so local refunds match the cloud return calculation.
    const tradeInValue = Math.max(0, Number(sale.tradeIn?.value || 0));
    const allocatedTradeIn = saleSubtotal > 0
      ? Math.min(tradeInValue, tradeInValue * (returnedMerchandise / saleSubtotal))
      : 0;
    const fullReturn = remainingItems.length === sale.items.length && remainingItems.every(({ it, qty }) => qty === it.qty);
    const shippingRefund = fullReturn ? Math.max(0, sale.shipping || 0) : 0;
    const refundValue = Math.max(0, Math.round((taxableReturned + taxRefund + shippingRefund - allocatedTradeIn) * 100) / 100);

    const pendingRefundKey = 'nexfix_pending_refund_v1:' + sale.id;
    let returnId = '';
    if (supabaseConfigured) {
      try {
        returnId = localStorage.getItem(pendingRefundKey)?.trim() || '';
        if (!returnId) {
          returnId = crypto.randomUUID();
          localStorage.setItem(pendingRefundKey, returnId);
        }
      } catch {
        returnId = crypto.randomUUID();      }
    }

    const returnLines = remainingItems.map(({ it, qty }) => {
      const soldUnitIds = (it.unitIds || []).filter(id =>
        state.units.some(u => u.id === id && u.status === 'sold' && u.saleId === sale.id),
      );
      return {
        product_id: it.productId,
        qty,
        unit_ids: soldUnitIds.length ? soldUnitIds.slice(0, qty) : undefined,
      };
    });

    // Online cloud refunds are committed by the server-authoritative atomic
    // return RPC first. Do not silently fall back to local-only mutation when
    // cloud authorization exists, or the browser could diverge from the shop ledger.
    if (supabaseConfigured && (typeof navigator === 'undefined' || navigator.onLine)) {
      const shop = await ensureCloudShop('Nexfix Shop');
      if (!shop.ok || !shop.shopId) {
        pushAudit('DENIED', 'Sale', 'Cloud refund blocked: ' + (shop.error || 'Cloud shop is unavailable'));
        return false;
      }

      const resolve = await resolveSaleReturnLines({ shopId: shop.shopId, saleId: sale.id, lines: returnLines });
      if (!resolve.ok || !resolve.lines) {
        pushAudit('DENIED', 'Sale', 'Cloud refund blocked: ' + (resolve.error || 'Sale items could not be matched'));
        return false;
      }

      const cloud = await processSaleReturnAtomic({
        shopId: shop.shopId,
        returnId,
        saleId: sale.id,
        reason: 'Full bill refund',
        mode: 'refund',
        paymentMethod: 'cash',
        lines: resolve.lines,
      });
      if (!cloud.ok) {
        pushAudit('DENIED', 'Sale', 'Cloud refund failed: ' + (cloud.error || 'Cloud return was not committed'));
        return false;
      }
      try { localStorage.removeItem(pendingRefundKey); } catch { /* ignore */ }
    }

    // Offline cloud-enabled refunds are queued as a normalized atomic return
    // before the local mutation. This prevents a cashier's offline refund from
    // depending on the admin-only full-state snapshot to reach the cloud later.
    if (supabaseConfigured && (typeof navigator === 'undefined' || !navigator.onLine)) {
      try {
        await queueReturnCreate(returnId, {
          saleId: sale.id,
          reason: 'Full bill refund',
          mode: 'refund',
          paymentMethod: 'cash',
          lines: returnLines,
        });
      } catch {
        pushAudit('DENIED', 'Sale', 'Offline refund blocked: return could not be queued safely');
        return false;
      }
    }

    const priorCreditReduction = (sale.refunds || []).reduce((sum, refund) => sum + Math.max(0, Number(refund.creditAmount) || 0), 0);
    const alreadySettledOnSale = (state.customerCreditPayments || []).reduce((sum, payment) => sum + (payment.allocations || []).filter(allocation => allocation.saleId === sale.id).reduce((part, allocation) => part + Math.max(0, Number(allocation.amount) || 0), 0), 0);
    const refundCreditDue = Math.max(0, sale.total - sale.amountPaid - alreadySettledOnSale - priorCreditReduction);
    const refundCreditAmount = Math.min(refundCreditDue, refundValue);
    const refundCashAmount = Math.max(0, Math.round((refundValue - refundCreditAmount) * 100) / 100);
    const refundEvent = {
      id: uid(),
      date: new Date().toISOString(),
      amount: Math.round(refundValue * 100) / 100,
      cashAmount: refundCashAmount,
      creditAmount: Math.round(refundCreditAmount * 100) / 100,
      method: 'cash' as const,
      cashierId: user.id,
      cashierName: user.name,
      by: user.name,
    };
    setStateWithInventoryLedger('REFUND', s => {
      const currentSale = s.sales.find(x => x.id === saleId);
      if (!currentSale || currentSale.status !== 'completed') return s;
      const currentReturnedByLine = new Map<number, number>();
      for (const ex of s.exchanges.filter(x => x.billNo === currentSale.billNo)) {
        for (const item of ex.items) if (item.itemIdx !== undefined) {
          currentReturnedByLine.set(item.itemIdx, (currentReturnedByLine.get(item.itemIdx) || 0) + item.qty);
        }
      }
      const currentRemaining = currentSale.items.map((it, idx) => Math.max(0, it.qty - (currentReturnedByLine.get(idx) || 0)));
      if (!currentRemaining.some(q => q > 0)) return s;
      const qtyByProduct = new Map<string, number>();
      currentSale.items.forEach((it, idx) => {
        const qty = currentRemaining[idx];
        if (qty > 0) qtyByProduct.set(it.productId, (qtyByProduct.get(it.productId) || 0) + qty);
      });
      const returnedUnitIds = currentSale.items.flatMap(it => it.unitIds || []).filter(id => s.units.some(u => u.id === id && u.status === 'sold' && u.saleId === currentSale.id));
      const allReturned = currentRemaining.every(q => q === 0);
      const tradeInReturn = allReturned && currentSale.tradeIn?.addToInventory && currentSale.tradeIn.productId && currentSale.tradeIn.unitId;
      const previouslyCredited = (currentSale.refunds || []).reduce((sum, refund) => sum + Math.max(0, Number(refund.creditAmount) || 0), 0);
      const alreadySettledOnSale = (s.customerCreditPayments || []).reduce((sum, payment) => sum + (payment.allocations || []).filter(allocation => allocation.saleId === currentSale.id).reduce((part, allocation) => part + Math.max(0, Number(allocation.amount) || 0), 0), 0);
      const creditDue = Math.max(0, currentSale.total - currentSale.amountPaid - alreadySettledOnSale - previouslyCredited);
      const creditReduction = Math.min(creditDue, refundValue);
      const returnedRatio = currentSale.total > 0 ? Math.min(1, refundValue / currentSale.total) : 1;
      const pointsEarnedToReverse = Math.min(currentSale.pointsEarned || 0, Math.round((currentSale.pointsEarned || 0) * returnedRatio));
      const pointsToRestore = Math.min(currentSale.pointsRedeemed || 0, Math.round((currentSale.pointsRedeemed || 0) * returnedRatio));
      return {
        ...s,
        sales: s.sales.map(x => x.id === saleId ? { ...x, status: allReturned ? 'refunded' : 'completed', refunds: [...(x.refunds || []), refundEvent] } : x),
        products: s.products.map(p => {
          const qty = qtyByProduct.get(p.id) || 0;
          const tradeInQty = tradeInReturn && p.id === currentSale.tradeIn!.productId ? -1 : 0;
          return qty || tradeInQty ? { ...p, stock: Math.max(0, p.stock + qty + tradeInQty) } : p;
        }),
        customers: s.customers.map(c => c.id === currentSale.customerId ? { ...c, creditBalance: Math.max(0, c.creditBalance - creditReduction), loyaltyPoints: Math.max(0, c.loyaltyPoints - pointsEarnedToReverse + pointsToRestore) } : c),
        units: (s.units || []).map(u => returnedUnitIds.includes(u.id)
          ? { ...u, status: 'in_stock' as const, saleId: undefined, saleBillNo: undefined, soldAt: undefined }
          : (tradeInReturn && u.id === currentSale.tradeIn!.unitId ? { ...u, status: 'returned' as const } : u)),
      };
    });
    pushAudit('REFUND', 'Sale', `Refunded bill ${sale.billNo} · Rs. ${refundValue.toLocaleString()}${sale.items.flatMap(it => it.unitIds || []).length ? ` · tracked unit(s) returned` : ''}`);
    return true;
  }, [state.sales, state.exchanges, state.units, pushAudit, user, can]);

  /* ---------------- admin-approved bill reversal ---------------- */
  const requestBillReverse = useCallback(async (saleId: string, reason: string): Promise<boolean> => {
    if (!user || !can('page:sales')) {
      pushAudit('DENIED', 'Sale', 'Blocked bill-reversal request without sales-history access');
      return false;
    }
    const sale = stateRef.current.sales.find(x => x.id === saleId);
    const note = reason.trim();
    if (!sale || sale.status !== 'completed' || !note) return false;
    if ((stateRef.current.exchanges || []).some(x => x.billNo === sale.billNo)) {
      pushAudit('DENIED', 'Sale', 'Blocked bill reversal after an exchange exists for the bill');
      return false;
    }
    if (stateRef.current.reverseRequests?.some(r => r.saleId === saleId && r.status === 'pending')) return false;

    const req: ReverseRequest = {
      id: uid(), saleId, billNo: sale.billNo, reason: note,
      requestedBy: user.name, requestedAt: new Date().toISOString(), status: 'pending',
    };

    if (supabaseConfigured && typeof navigator !== 'undefined' && navigator.onLine) {
      const shop = await ensureCloudShop('Nexfix Shop');
      if (!shop.ok || !shop.shopId) {
        pushAudit('DENIED', 'Sale', 'Cloud reversal request blocked: ' + (shop.error || 'Cloud shop unavailable'));
        return false;
      }
      const cloud = await requestSaleReversal({ shopId: shop.shopId, requestId: req.id, saleId, reason: note });
      if (!cloud.ok) {
        pushAudit('DENIED', 'Sale', 'Cloud reversal request blocked: ' + (cloud.error || 'Request was not committed'));
        return false;
      }
    } else if (supabaseConfigured) {
      try {
        await queueSaleReversalRequest(req.id, { saleId, reason: note });
      } catch {
        pushAudit('DENIED', 'Sale', 'Offline reversal request blocked: request could not be queued safely');
        return false;
      }
    }

    setState(s => ({ ...s, reverseRequests: [req, ...(s.reverseRequests || []).filter(r => r.id !== req.id)] }));
    pushAudit('REVERSE-REQUEST', 'Sale', 'Reverse requested for ' + sale.billNo + ' · ' + note);
    return true;
  }, [user, pushAudit, can]);

  const approveBillReverse = useCallback(async (requestId: string): Promise<boolean> => {
    if (user?.role !== 'admin') return false;
    if (!(await confirmSensitiveAdmin('bill reversal approval'))) return false;
    const req = stateRef.current.reverseRequests?.find(r => r.id === requestId);
    const sale = req ? stateRef.current.sales.find(x => x.id === req.saleId) : undefined;
    if (!req || req.status !== 'pending' || !sale || sale.status !== 'completed') return false;

    if (supabaseConfigured && typeof navigator !== 'undefined' && navigator.onLine) {
      const shop = await ensureCloudShop('Nexfix Shop');
      if (!shop.ok || !shop.shopId) {
        pushAudit('DENIED', 'Sale', 'Cloud reversal approval blocked: ' + (shop.error || 'Cloud shop unavailable'));
        return false;
      }
      const cloud = await approveSaleReversal({ shopId: shop.shopId, requestId });
      if (!cloud.ok) {
        pushAudit('DENIED', 'Sale', 'Cloud reversal approval blocked: ' + (cloud.error || 'Approval was not committed'));
        return false;
      }
    } else if (supabaseConfigured) {
      try {
        await queueSaleReversalApproval(requestId);
      } catch {
        pushAudit('DENIED', 'Sale', 'Offline reversal approval blocked: approval could not be queued safely');
        return false;
      }
    }

    setStateWithInventoryLedger('SALE_REVERSAL', s => {
      const currentReq = (s.reverseRequests || []).find(r => r.id === requestId);
      const currentSale = currentReq ? s.sales.find(x => x.id === currentReq.saleId) : undefined;
      if (!currentReq || currentReq.status !== 'pending' || !currentSale || currentSale.status !== 'completed') return s;
      const qtyByProduct = new Map<string, number>();
      currentSale.items.forEach(it => qtyByProduct.set(it.productId, (qtyByProduct.get(it.productId) || 0) + it.qty));
      const unitIds = new Set(currentSale.items.flatMap(it => it.unitIds || []));
      const balanceDue = currentSale.amountPaid < currentSale.total ? Math.max(0, currentSale.total - currentSale.amountPaid) : 0;
      const tradeInReturn = currentSale.tradeIn?.addToInventory && currentSale.tradeIn.productId && currentSale.tradeIn.unitId;
      return {
        ...s,
        sales: s.sales.map(x => x.id === currentSale.id ? { ...x, status: 'reversed' as const } : x),
        products: s.products.map(p => {
          const qty = qtyByProduct.get(p.id) || 0;
          const tradeInQty = tradeInReturn && p.id === currentSale.tradeIn!.productId ? -1 : 0;
          return qty || tradeInQty ? { ...p, stock: Math.max(0, p.stock + qty + tradeInQty) } : p;
        }),
        customers: s.customers.map(c => c.id === currentSale.customerId ? { ...c, creditBalance: Math.max(0, c.creditBalance - balanceDue), loyaltyPoints: Math.max(0, c.loyaltyPoints - (currentSale.pointsEarned || 0) + (currentSale.pointsRedeemed || 0)) } : c),
        units: (s.units || []).map(u => unitIds.has(u.id) && u.saleId === currentSale.id
          ? { ...u, status: 'in_stock' as const, saleId: undefined, saleBillNo: undefined, soldAt: undefined }
          : (tradeInReturn && u.id === currentSale.tradeIn!.unitId ? { ...u, status: 'returned' as const } : u)),
        reverseRequests: (s.reverseRequests || []).map(r => r.id === requestId ? { ...r, status: 'approved' as const, reviewedBy: user.name, reviewedAt: new Date().toISOString() } : r),
      };
    });
    pushAudit('REVERSE-APPROVED', 'Sale', 'Bill ' + sale.billNo + ' reversed and stock restored · requested by ' + req.requestedBy);
    return true;
  }, [user, pushAudit]);

  const rejectBillReverse = useCallback(async (requestId: string, note?: string): Promise<boolean> => {
    if (user?.role !== 'admin') return false;
    const req = stateRef.current.reverseRequests?.find(r => r.id === requestId);
    if (!req || req.status !== 'pending') return false;
    const reviewNote = note?.trim() || undefined;

    if (supabaseConfigured && typeof navigator !== 'undefined' && navigator.onLine) {
      const shop = await ensureCloudShop('Nexfix Shop');
      if (!shop.ok || !shop.shopId) {
        pushAudit('DENIED', 'Sale', 'Cloud reversal rejection blocked: ' + (shop.error || 'Cloud shop unavailable'));
        return false;
      }
      const cloud = await rejectSaleReversal({ shopId: shop.shopId, requestId, note: reviewNote });
      if (!cloud.ok) {
        pushAudit('DENIED', 'Sale', 'Cloud reversal rejection blocked: ' + (cloud.error || 'Rejection was not committed'));
        return false;
      }
    } else if (supabaseConfigured) {
      try {
        await queueSaleReversalRejection(requestId, reviewNote);
      } catch {
        pushAudit('DENIED', 'Sale', 'Offline reversal rejection blocked: rejection could not be queued safely');
        return false;
      }
    }

    setState(s => ({ ...s, reverseRequests: (s.reverseRequests || []).map(r => r.id === requestId ? { ...r, status: 'rejected' as const, reviewedBy: user.name, reviewedAt: new Date().toISOString(), reviewNote } : r) }));
    pushAudit('REVERSE-REJECTED', 'Sale', 'Reverse request for ' + req.billNo + ' rejected · ' + (reviewNote || 'No note'));
    return true;
  }, [user, pushAudit, confirmSensitiveAdmin]);
  /* ---------------- held sales ---------------- */
  const holdSale = useCallback((h: Omit<HeldSale, 'id' | 'heldAt'>) => {
    if (!user || !can('page:pos')) {
      pushAudit('DENIED', 'HeldSale', 'Blocked hold-sale change without POS access');
      return;
    }
    setState(s => ({ ...s, held: [...s.held, { ...h, id: uid(), heldAt: new Date().toISOString() }] }));
  }, [pushAudit, user, can]);

  const resumeHold = useCallback((id: string) => {
    if (!user || !can('page:pos')) {
      pushAudit('DENIED', 'HeldSale', 'Blocked held-sale resume without POS access');
      return undefined;
    }
    const h = state.held.find(x => x.id === id);
    setState(s => ({ ...s, held: s.held.filter(x => x.id !== id) }));
    return h;
  }, [state.held, pushAudit, user, can]);

  const deleteHold = useCallback((id: string) => {
    if (!user || !can('page:pos')) {
      pushAudit('DENIED', 'HeldSale', 'Blocked held-sale delete without POS access');
      return;
    }
    setState(s => ({ ...s, held: s.held.filter(x => x.id !== id) }));
  }, [pushAudit, user, can]);

  /* ---------------- purchases ---------------- */
  const savePurchase = useCallback((p: Omit<Purchase, 'id' | 'poNo' | 'date' | 'status'>) => {
    const selectedBranchId = stateRef.current.settings.branchId || 'local-main';
    if (hasMultipleCachedBranches(getCloudShopId()) && selectedBranchId === 'local-main') {
      pushAudit('DENIED', 'Purchase', 'Blocked purchase order creation because this shop has multiple branches and no branch is selected. Open Settings first.');
      return;
    }
    if (!user || !can('page:purchases')) {
      pushAudit('DENIED', 'Purchase', 'Blocked purchase order creation without purchase access');
      return;
    }
    setState(s => {
      const seq = s.counters.po + 1;
      const po: Purchase = {
        ...p, branchId: stateRef.current.settings.branchId || 'local-main', id: uid(), poNo: `PO-${String(seq).padStart(4, '0')}`,
        date: new Date().toISOString(), status: 'pending',
      };
      return { ...s, purchases: [po, ...s.purchases], counters: { ...s.counters, po: seq } };
    });
    pushAudit('CREATE', 'Purchase', `Created PO for ${p.supplierName} · Rs. ${p.total.toLocaleString()}`);
  }, [pushAudit, user, can]);

  const receivePurchase = useCallback(async (id: string, processorName?: string): Promise<{ ok: boolean; error?: string }> => {
    if (purchaseReceiveLockRef.current) return { ok: false, error: 'A GRN process is already in progress. Please wait.' };
    if (!user || !can('page:purchases')) {
      pushAudit('DENIED', 'Purchase', 'Blocked purchase receive without purchase access');
      return { ok: false, error: 'You do not have permission to manage purchases.' };
    }
    const shopId = getCloudShopId();
    const selectedBranchId = stateRef.current.settings.branchId || 'local-main';
    const multipleBranches = hasMultipleCachedBranches(shopId);
    const defaultBranchId = getDefaultBranchId(shopId) || 'local-main';
    const effectiveBranch = (branchId?: string) => !branchId || branchId === 'local-main' ? defaultBranchId : branchId;
    if (multipleBranches && selectedBranchId === 'local-main') {
      pushAudit('DENIED', 'Purchase', 'Blocked GRN receive because this shop has multiple branches and no branch is selected. Open Settings first.');
      return { ok: false, error: 'Select a branch in Settings before receiving stock.' };
    }
    const po = stateRef.current.purchases.find(x => x.id === id);
    if (!po) return { ok: false, error: 'GRN draft was not found.' };
    if (po.status !== 'pending') return { ok: false, error: 'This GRN is already processed and cannot be processed again.' };
    const purchaseBranchId = effectiveBranch(po.branchId);
    if (multipleBranches && effectiveBranch(selectedBranchId) !== purchaseBranchId) {
      pushAudit('DENIED', 'Purchase', 'Blocked GRN receive because this draft belongs to a different branch. Switch this POS to the GRN branch first.');
      return { ok: false, error: 'This GRN belongs to another branch. Switch this POS to that branch before receiving it.' };
    }
    const receiveBranchId = selectedBranchId === 'local-main' ? purchaseBranchId : selectedBranchId;

    const planResult = buildPurchaseReceivePlan(po, stateRef.current.products);
    if (!planResult.ok) return { ok: false, error: planResult.error || 'GRN validation failed.' };
    const unitResult = validatePurchaseUnitIdentifiers(po, stateRef.current.products, stateRef.current.units || []);
    if (!unitResult.ok) return { ok: false, error: unitResult.error || 'IMEI/Serial validation failed.' };

    purchaseReceiveLockRef.current = true;
    try {
      const online = getConnectivity() === 'online';
      const cloudEnabled = supabaseConfigured;
      const shop = cloudEnabled && online ? await ensureCloudShop('Nexfix Shop') : { ok: false as const };

      if (cloudEnabled && online) {
        if (!shop.ok || !shop.shopId) return { ok: false, error: shop.error || 'Cloud shop is not available for GRN receive.' };
        if (user.role === 'admin' || user.role === 'manager') {
          const catalog = await syncNormalizedCatalog(stateRef.current, shop.shopId);
          if (!catalog.ok) return { ok: false, error: catalog.error || 'Cloud catalog sync failed. GRN was not received.' };
        }
        const cloudResult = await receivePurchaseAtomic({
          shopId: shop.shopId,
          branchId: receiveBranchId,
          deviceId: getMachineIdentity().id,
          purchaseId: po.id,
          purchase: po,
        });
        if (!cloudResult.ok) return { ok: false, error: cloudResult.error || 'Cloud GRN receive was not committed. No local stock was changed.' };
      } else if (cloudEnabled && !online) {
        await queuePurchaseReceive(po.id, { deviceId: getMachineIdentity().id, purchase: { ...po, branchId: receiveBranchId } });
      }

      let applied = false;
      let applyError = '';
      setStateWithInventoryLedger('PURCHASE_RECEIVE', s => {
        const currentPo = s.purchases.find(x => x.id === id);
        if (!currentPo || currentPo.status !== 'pending') {
          applyError = 'This GRN is no longer a pending draft.';
          return s;
        }
        const currentPlanResult = buildPurchaseReceivePlan(currentPo, s.products);
        if (!currentPlanResult.ok || !currentPlanResult.plan) {
          applyError = currentPlanResult.error || 'GRN validation failed before processing.';
          return s;
        }
        const currentUnitResult = validatePurchaseUnitIdentifiers(currentPo, s.products, s.units || []);
        if (!currentUnitResult.ok) {
          applyError = currentUnitResult.error || 'IMEI/Serial validation failed before processing.';
          return s;
        }
        const now = new Date().toISOString();
        const newUnits: InventoryUnit[] = [];
        const products = s.products.map(p => {
          const delta = currentPlanResult.plan!.productStockDelta.get(p.id);
          if (delta === undefined) return p;
          const cost = currentPlanResult.plan!.productCost.get(p.id);
          const trackedQty = currentPlanResult.plan!.trackedUnitCount.get(p.id) || 0;
          const purchaseItem = currentPo.items.find(item => item.productId === p.id);
          if (trackedQty > 0 && (p.trackImei || p.trackSerial)) {
            for (const identifier of purchaseItem?.unitIdentifiers || []) {
              newUnits.push({
                id: uid(), productId: p.id, branchId: receiveBranchId, imei: p.trackImei ? identifier.imei?.trim() : undefined,
                serial: p.trackSerial ? identifier.serial?.trim() : undefined, status: 'in_stock',
                purchaseId: currentPo.id, cost, expiryDate: purchaseItem?.expiryDate, note: 'From ' + currentPo.poNo, createdAt: now,
              } as InventoryUnit);
            }
          }
          const sellingPrice = purchaseItem?.updateSellingPrice ? purchaseItem.sellingPrice : undefined;
          return { ...p, stock: p.stock + delta, ...(cost !== undefined ? { cost } : {}), ...(sellingPrice !== undefined ? { price: Math.round(sellingPrice * 100) / 100 } : {}) };
        });
        const next = {
          ...s, purchases: s.purchases.map(x => x.id === id ? { ...x, branchId: receiveBranchId, status: 'received' as const, ...(processorName ? { processedAt: now, processedBy: processorName } : {}) } : x),
          products, units: [...newUnits, ...(s.units || [])],
        };
        applied = true;
        return next;
      });
      if (!applied) return { ok: false, error: applyError || 'Unable to process this GRN. No stock was changed.' };
      if (cloudEnabled && !online) {
        const branchId = receiveBranchId;
        const deltas: Record<string, number> = {};
        for (const item of po.items) deltas[item.productId] = (deltas[item.productId] || 0) + item.qty;
        if (branchId !== 'local-main') applyBranchStockDeltas(branchId, deltas);
      }
      pushAudit('RECEIVE', 'Purchase', 'Received ' + po.poNo + ' from ' + po.supplierName + ' · recorded IMEI/Serial units' + (cloudEnabled ? ' · cloud-authoritative receive' : ''));
      return { ok: true };
    } finally {
      purchaseReceiveLockRef.current = false;
    }
  }, [pushAudit, user, can, setStateWithInventoryLedger]);

  const saveGRNDraft = useCallback((p: Omit<Purchase, 'id' | 'poNo' | 'date' | 'status'>): { ok: boolean; purchase?: Purchase; error?: string } => {
    const selectedBranchId = stateRef.current.settings.branchId || 'local-main';
    if (hasMultipleCachedBranches(getCloudShopId()) && selectedBranchId === 'local-main') {
      pushAudit('DENIED', 'GRN', 'Blocked GRN draft creation because this shop has multiple branches and no branch is selected. Open Settings first.');
      return { ok: false, error: 'Select a branch in Settings before creating a GRN.' };
    }
    if (!user || !can('page:purchases')) {
      pushAudit('DENIED', 'GRN', 'Blocked GRN draft creation without purchase access');
      return { ok: false, error: 'You do not have permission to manage purchases.' };
    }
    const validation: Purchase = { ...p, id: 'validation', poNo: 'GRN-VALIDATION', date: new Date().toISOString(), status: 'pending' };
    const planResult = buildPurchaseReceivePlan(validation, stateRef.current.products);
    if (!planResult.ok) return { ok: false, error: planResult.error || 'GRN validation failed.' };
    const unitResult = validatePurchaseUnitIdentifiers(validation, stateRef.current.products, stateRef.current.units || []);
    if (!unitResult.ok) return { ok: false, error: unitResult.error || 'IMEI/Serial validation failed.' };
    const created: Purchase = { ...p, branchId: stateRef.current.settings.branchId || p.branchId || 'local-main', id: uid(), poNo: 'GRN-' + String((stateRef.current.counters.grn ?? 0) + 1).padStart(4, '0'), date: new Date().toISOString(), status: 'pending', total: p.items.reduce((sum, item) => sum + item.qty * item.cost, 0) };
    setState(s => ({ ...s, purchases: [created, ...s.purchases], counters: { ...s.counters, grn: (s.counters.grn ?? 0) + 1 } }));
    pushAudit('CREATE', 'GRN', 'Draft ' + created.poNo + ' for ' + created.supplierName + ' · Rs. ' + created.total.toLocaleString());
    return { ok: true, purchase: created };
  }, [state.counters.grn, pushAudit, user, can]);

  const updateGRNDraft = useCallback((id: string, patch: Partial<Omit<Purchase, 'id' | 'poNo' | 'date' | 'status'>>): { ok: boolean; error?: string } => {
    if (!user || !can('page:purchases')) {
      pushAudit('DENIED', 'GRN', 'Blocked GRN draft update without purchase access');
      return { ok: false, error: 'You do not have permission to manage purchases.' };
    }
    const current = stateRef.current.purchases.find(x => x.id === id);
    if (!current) return { ok: false, error: 'GRN draft was not found.' };
    if (current.status !== 'pending') return { ok: false, error: 'This GRN is already processed and cannot be edited.' };
    const next: Purchase = { ...current, ...patch, total: (patch.items || current.items).reduce((sum, item) => sum + item.qty * item.cost, 0) };
    const planResult = buildPurchaseReceivePlan(next, stateRef.current.products);
    if (!planResult.ok) return { ok: false, error: planResult.error || 'GRN validation failed.' };
    const unitResult = validatePurchaseUnitIdentifiers(next, stateRef.current.products, stateRef.current.units || []);
    if (!unitResult.ok) return { ok: false, error: unitResult.error || 'IMEI/Serial validation failed.' };
    setState(s => ({ ...s, purchases: s.purchases.map(x => x.id === id && x.status === 'pending' ? next : x) }));
    pushAudit('EDIT', 'GRN', 'Updated draft ' + current.poNo);
    return { ok: true };
  }, [pushAudit, user, can]);

  const processGRN = useCallback((id: string, processorName: string): Promise<{ ok: boolean; error?: string }> => receivePurchase(id, processorName), [receivePurchase]);

  const createPurchaseReturn = useCallback(async (input: { purchaseId: string; lines: Array<{ itemIdx: number; qty: number; unitIds?: string[] }>; reason: string }): Promise<PurchaseReturn | null> => {
    if (purchaseReturnLockRef.current) return null;
    if (!user || !can('page:purchases')) {
      pushAudit('DENIED', 'Purchase', 'Blocked purchase return without purchase access');
      return null;
    }
    const purchase = state.purchases.find(x => x.id === input.purchaseId);
    if (!purchase || purchase.status !== 'received' || !input.reason.trim()) return null;

    const existing = state.purchaseReturns || [];
    const returnedByItem = new Map<number, number>();
    for (const ret of existing.filter(x => x.purchaseId === purchase.id)) for (const item of ret.items) {
      returnedByItem.set(item.itemIdx, (returnedByItem.get(item.itemIdx) || 0) + item.qty);
    }

    const requested = new Map<number, { qty: number; unitIds: string[] }>();
    for (const line of input.lines) {
      if (!Number.isInteger(line.itemIdx) || line.itemIdx < 0 || line.itemIdx >= purchase.items.length) continue;
      if (!Number.isInteger(line.qty) || line.qty <= 0) continue;
      const previous = requested.get(line.itemIdx);
      const unitIds = Array.isArray(line.unitIds) ? line.unitIds.filter(Boolean) : [];
      requested.set(line.itemIdx, {
        qty: (previous?.qty || 0) + line.qty,
        unitIds: [...(previous?.unitIds || []), ...unitIds],
      });
    }
    if (requested.size === 0) return null;

    const items: PurchaseReturnItem[] = [];
    const returnedUnitIds = new Set<string>();
    for (const [itemIdx, request] of requested) {
      const source = purchase.items[itemIdx];
      if (!Number.isInteger(source.qty) || source.qty <= 0 || !Number.isFinite(source.cost) || source.cost < 0) return null;
      const already = returnedByItem.get(itemIdx) || 0;
      const remaining = Math.max(0, source.qty - already);
      const product = state.products.find(p => p.id === source.productId);
      const stock = product?.stock ?? NaN;
      if (!product || !Number.isFinite(stock) || stock < 0) return null;

      const tracked = Array.isArray(source.unitIdentifiers) && source.unitIdentifiers.length > 0;
      const availableUnits = tracked
        ? (state.units || []).filter(u => u.productId === source.productId && u.purchaseId === purchase.id && u.status === 'in_stock')
        : [];
      const maxReturnable = Math.min(remaining, stock, tracked ? availableUnits.length : Number.MAX_SAFE_INTEGER);
      if (request.qty > maxReturnable) return null;

      let selectedUnitIds: string[] | undefined;
      if (tracked) {
        const selected = [...new Set(request.unitIds)];
        if (selected.length !== request.qty) return null;
        const availableIds = new Set(availableUnits.map(u => u.id));
        const expectedIdentifiers = (source.unitIdentifiers || []).map(x => ({
          imei: x.imei?.trim().toLowerCase() || '',
          serial: x.serial?.trim().toLowerCase() || '',
        }));
        for (const unitId of selected) {
          const unit = availableUnits.find(u => u.id === unitId);
          if (!unit || !availableIds.has(unitId) || returnedUnitIds.has(unitId)) return null;
          const imei = unit.imei?.trim().toLowerCase() || '';
          const serial = unit.serial?.trim().toLowerCase() || '';
          if (!expectedIdentifiers.some(x => x.imei === imei && x.serial === serial)) return null;
          returnedUnitIds.add(unitId);
        }
        selectedUnitIds = selected;
      } else if (request.unitIds.length) {
        return null;
      }

      items.push({
        itemIdx,
        productId: source.productId,
        name: source.name,
        qty: request.qty,
        cost: source.cost,
        total: request.qty * source.cost,
        ...(selectedUnitIds ? { unitIds: selectedUnitIds } : {}),
      });
    }
    if (!items.length) return null;

    purchaseReturnLockRef.current = true;
    try {
      const cloudEnabled = supabaseConfigured;
      const online = getConnectivity() === 'online';
      const returnKey = 'nexfix_pending_purchase_return_v1:' + purchase.id;
      let returnId = '';
      if (cloudEnabled) {
        try {
          returnId = localStorage.getItem(returnKey)?.trim() || '';
          if (!returnId) {
            returnId = crypto.randomUUID();
            localStorage.setItem(returnKey, returnId);
          }
        } catch {
          returnId = uid();
        }
      } else {
        returnId = uid();
      }

      let cloudReturnNo: string | undefined;
      let cloudTotal: number | undefined;

      if (cloudEnabled) {
        if (!online) {
          pushAudit('DENIED', 'Purchase', 'Supplier return blocked while offline because cloud stock must remain authoritative');
          return null;
        }
        const shop = await ensureCloudShop('Nexfix Shop');
        if (!shop.ok || !shop.shopId) {
          pushAudit('DENIED', 'Purchase', 'Cloud supplier return blocked: ' + (shop.error || 'Cloud shop is unavailable'));
          return null;
        }
        const cloudResult = await processPurchaseReturnAtomic({
          shopId: shop.shopId,
          returnId,
          purchaseId: purchase.id,
          deviceId: getMachineIdentity().id,
          reason: input.reason.trim(),
          purchase,
          lines: items.map(item => ({
            item_idx: item.itemIdx,
            product_id: item.productId,
            qty: item.qty,
            cost: item.cost,
            ...(item.unitIds?.length ? { unit_ids: item.unitIds } : {}),
          })),
        });
        if (!cloudResult.ok) {
          pushAudit('DENIED', 'Purchase', 'Cloud supplier return blocked: ' + (cloudResult.error || 'Return was not committed'));
          return null;
        }
        cloudReturnNo = cloudResult.returnNo;
        cloudTotal = cloudResult.total;
      }

      const localSeq = (state.counters.dn || 0) + 1;
      const serverSeq = cloudReturnNo && /^DN-(\d+)$/.test(cloudReturnNo) ? Number(cloudReturnNo.slice(3)) : 0;
      const seq = Math.max(localSeq, Number.isFinite(serverSeq) ? serverSeq : 0);
      const ret: PurchaseReturn = {
        id: returnId,
        dnNo: cloudReturnNo || 'DN-' + String(seq).padStart(4, '0'),
        purchaseId: purchase.id,
        poNo: purchase.poNo,
        supplierId: purchase.supplierId,
        supplierName: purchase.supplierName,
        date: new Date().toISOString(),
        items,
        total: cloudTotal ?? items.reduce((a, x) => a + x.total, 0),
        reason: input.reason.trim(),
        by: user.email,
      };

      let applied = false;
      setStateWithInventoryLedger('PURCHASE_REVERSAL', prev => {
        const currentPurchase = prev.purchases.find(x => x.id === purchase.id);
        if (!currentPurchase || currentPurchase.status !== 'received') return prev;
        const currentReturnedByItem = new Map<number, number>();
        for (const existingReturn of prev.purchaseReturns || []) {
          if (existingReturn.purchaseId !== purchase.id) continue;
          for (const item of existingReturn.items) {
            currentReturnedByItem.set(item.itemIdx, (currentReturnedByItem.get(item.itemIdx) || 0) + item.qty);
          }
        }
        for (const item of items) {
          const source = currentPurchase.items[item.itemIdx];
          const alreadyReturnedNow = currentReturnedByItem.get(item.itemIdx) || 0;
          const product = prev.products.find(p => p.id === item.productId);
          if (!source || source.productId !== item.productId || item.qty > source.qty - alreadyReturnedNow || !product || !Number.isFinite(product.stock) || product.stock < item.qty) return prev;
        }
        for (const unitId of returnedUnitIds) {
          const unit = (prev.units || []).find(u => u.id === unitId);
          if (!unit || unit.status !== 'in_stock' || unit.purchaseId !== purchase.id || !items.some(item => item.productId === unit.productId && (purchase.items[item.itemIdx]?.unitIdentifiers || []).some(identifier =>
            (identifier.imei?.trim().toLowerCase() || '') === (unit.imei?.trim().toLowerCase() || '') &&
            (identifier.serial?.trim().toLowerCase() || '') === (unit.serial?.trim().toLowerCase() || '')
          ))) return prev;
        }
        applied = true;
        return {
          ...prev,
          products: prev.products.map(p => {
            const qty = items.filter(x => x.productId === p.id).reduce((a, x) => a + x.qty, 0);
            return qty ? { ...p, stock: p.stock - qty } : p;
          }),
          units: (prev.units || []).map(u => returnedUnitIds.has(u.id)
            ? { ...u, status: 'returned' as const, saleId: undefined, saleBillNo: undefined, soldAt: undefined, note: `Returned to supplier via ${ret.dnNo}` }
            : u),
          purchaseReturns: [ret, ...(prev.purchaseReturns || [])],
          counters: { ...prev.counters, dn: seq },
        };
      });
      if (!applied) return null;

      if (cloudEnabled) {
        try { localStorage.removeItem(returnKey); } catch (error) { void error; }
      }
      pushAudit('PURCHASE_RETURN', 'Purchase', 'Debit Note ' + ret.dnNo + ' · ' + purchase.poNo + ' · ' + purchase.supplierName + ' · Rs.' + ret.total.toLocaleString());
      return ret;
    } finally {
      purchaseReturnLockRef.current = false;
    }
  }, [state.purchases, state.purchaseReturns, state.products, state.units, state.counters.dn, user, pushAudit, can, setStateWithInventoryLedger]);

const deletePurchase = useCallback((id: string) => {
    if (!user || !can('page:purchases') || !can('act:deleteRecords')) {
      pushAudit('DENIED', 'Purchase', 'Blocked purchase delete without required permissions');
      return;
    }
    const po = state.purchases.find(x => x.id === id);
    if (!po || !canDeletePurchase(po)) return;
    setState(s => {
      const currentPo = s.purchases.find(x => x.id === id);
      if (!currentPo || !canDeletePurchase(currentPo)) return s;
      return { ...s, purchases: s.purchases.filter(x => x.id !== id) };
    });
    pushAudit('DELETE', 'Purchase', `Deleted ${po.poNo}`);
  }, [state.purchases, pushAudit, user, can]);

  /* ---------------- expenses ---------------- */
  const addExpense = useCallback((e: Omit<Expense, 'id' | 'date' | 'by'>) => {
    if (expenseLockRef.current) {
      pushAudit('DENIED', 'Expense', 'Blocked duplicate expense submission while another expense is being committed');
      return;
    }
    if (!user || !can('page:expenses')) {
      pushAudit('DENIED', 'Expense', 'Blocked expense creation without expense access');
      return;
    }
    const selectedBranchId = stateRef.current.settings.branchId || 'local-main';
    if (hasMultipleCachedBranches(getCloudShopId()) && selectedBranchId === 'local-main') {
      pushAudit('DENIED', 'Expense', 'Blocked expense creation because this shop has multiple branches and no branch is selected. Open Settings first.');
      return;
    }
    const amount = Math.round(Number(e.amount) * 100) / 100;
    const category = String(e.category || '').trim();
    const note = String(e.note || '').trim();
    const paymentMethod = e.paymentMethod || 'cash';
    const periodStart = e.periodStart?.trim() || undefined;
    const periodEnd = e.periodEnd?.trim() || undefined;
    const validPaymentMethods = new Set<Expense['paymentMethod']>(['cash', 'bank', 'card']);
    const validDate = (value?: string) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
    if (!Number.isFinite(amount) || amount <= 0 || !category || !note || !validPaymentMethods.has(paymentMethod) || !validDate(periodStart) || !validDate(periodEnd) || (periodStart && periodEnd && periodEnd < periodStart)) {
      pushAudit('DENIED', 'Expense', 'Blocked invalid expense input');
      return;
    }
    expenseLockRef.current = true;
    try {
      const now = new Date().toISOString();
      setState(s => ({
        ...s,
        expenses: [{ ...e, branchId: stateRef.current.settings.branchId || 'local-main', amount, category, note, paymentMethod, periodStart, periodEnd, id: uid(), date: now, by: user.name }, ...s.expenses],
      }));
      pushAudit('EXPENSE', 'Expense', `${category}: ${note} · Rs. ${amount.toLocaleString()}${paymentMethod === 'cash' ? ' · cash' : ''}`);
    } finally {
      expenseLockRef.current = false;
    }
  }, [pushAudit, user, can]);

  const deleteExpense = useCallback((id: string) => {
    if (!user || !can('page:expenses') || !can('act:deleteRecords')) {
      pushAudit('DENIED', 'Expense', 'Blocked expense delete without required permissions');
      return;
    }
    const snapshot = stateRef.current;
    const e = snapshot.expenses.find(x => x.id === id);
    if (!e) return;
    const expenseDate = dkey(new Date(e.date));
    const session = snapshot.sessions.find(x => x.date === expenseDate && x.cashierId === user.id);
    if ((e.paymentMethod || 'cash') === 'cash' && session?.closed) {
      pushAudit('DENIED', 'Expense', 'Blocked cash expense deletion after the cashier session was closed');
      return;
    }
    let deleted = false;
    setState(s => {
      const current = s.expenses.find(x => x.id === id);
      if (!current) return s;
      const currentSession = s.sessions.find(x => x.date === dkey(new Date(current.date)) && x.cashierId === user.id);
      if ((current.paymentMethod || 'cash') === 'cash' && currentSession?.closed) return s;
      deleted = true;
      return { ...s, expenses: s.expenses.filter(x => x.id !== id) };
    });
    if (deleted) pushAudit('DELETE', 'Expense', `Deleted expense ${e.category} · Rs. ${e.amount.toLocaleString()}`);
  }, [pushAudit, user, can]);

  /* ---------------- exchanges ---------------- */
  const processExchange = useCallback((saleId: string, returns: Array<{ itemIdx: number; qty: number; unitIds?: string[] }>, reason: string, mode: 'refund' | 'replace') => {
    const sale = state.sales.find(x => x.id === saleId);
    if (!user || !can('page:exchanges') || !sale || sale.status !== 'completed' || returns.length === 0) {
      if (user && !can('page:exchanges')) pushAudit('DENIED', 'Exchange', 'Blocked exchange without exchanges access');
      return;
    }
    if (mode === 'refund' && !can('act:refund')) return;
    const ageMs = Date.now() - new Date(sale.date).getTime();
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > state.settings.exchangeDays * 86400000) return;

    const requested = new Map<number, number>();
    for (const item of returns) {
      if (!Number.isInteger(item.itemIdx) || item.itemIdx < 0 || item.itemIdx >= sale.items.length) continue;
      if (!Number.isInteger(item.qty) || item.qty <= 0) return;
      requested.set(item.itemIdx, (requested.get(item.itemIdx) || 0) + item.qty);
    }
    if (requested.size === 0) return;

    setStateWithInventoryLedger('EXCHANGE', s => {
      const priorReturnedByLine = new Map<string, number>();
      const priorReturnedByProduct = new Map<string, number>();
      s.exchanges.filter(x => x.billNo === sale.billNo).flatMap(x => x.items).forEach(item => {
        const lineKey = item.itemIdx !== undefined ? 'i:' + item.itemIdx : 'p:' + item.productId;
        priorReturnedByLine.set(lineKey, (priorReturnedByLine.get(lineKey) || 0) + item.qty);
        priorReturnedByProduct.set(item.productId, (priorReturnedByProduct.get(item.productId) || 0) + item.qty);
      });

      const exItems: Exchange['items'] = [];
      const returnedUnitIds: string[] = [];
      const restockQtyByProduct = new Map<string, number>();
      let refund = 0;

      for (const [itemIdx, requestedQty] of requested) {
        const it = sale.items[itemIdx];
        const lineKey = 'i:' + itemIdx;
        const alreadyReturned = priorReturnedByLine.has(lineKey)
          ? (priorReturnedByLine.get(lineKey) || 0)
          : (priorReturnedByProduct.get(it.productId) || 0);
        const availableQty = Math.max(0, it.qty - alreadyReturned);
        const tracked = (it.unitIds || []).length > 0;
        const trackedAvailable = (it.unitIds || []).filter(id => s.units.some(u => u.id === id && u.status === 'sold' && u.saleId === sale.id)).length;
        const maxReturnable = Math.min(availableQty, tracked ? trackedAvailable : availableQty);
        if (requestedQty > maxReturnable) return s;
        const qty = requestedQty;
        if (qty <= 0) continue;

        const requestedUnitIds = Array.isArray((returns.find(r => r.itemIdx === itemIdx) || {}).unitIds)
          ? ((returns.find(r => r.itemIdx === itemIdx) || {}).unitIds || []).filter(Boolean)
          : [];
        if (tracked) {
          if (requestedUnitIds.length !== qty || new Set(requestedUnitIds).size !== qty) return s;
          const soldUnitIds = new Set((it.unitIds || []).filter(Boolean));
          if (requestedUnitIds.some(id => !soldUnitIds.has(id) || !s.units.some(u => u.id === id && u.status === 'sold' && u.saleId === sale.id))) return s;
        } else if (requestedUnitIds.length) {
          return s;
        }

        const proportionalDiscount = it.qty > 0 ? (it.discount || 0) * (qty / it.qty) : 0;
        const amount = Math.max(0, Math.round((it.price * qty - proportionalDiscount) * 100) / 100);
        const unitIds = tracked ? requestedUnitIds : [];

        exItems.push({ itemIdx, productId: it.productId, name: it.name, qty, amount });
        if (mode === 'refund') refund += amount;
        restockQtyByProduct.set(it.productId, (restockQtyByProduct.get(it.productId) || 0) + qty);
        returnedUnitIds.push(...unitIds);
        priorReturnedByLine.set(lineKey, alreadyReturned + qty);
        priorReturnedByProduct.set(it.productId, (priorReturnedByProduct.get(it.productId) || 0) + qty);
      }

      if (exItems.length === 0) return s;

      const seq = s.counters.ex + 1;
      const ex: Exchange = {
        id: uid(), exNo: `EX-${String(seq).padStart(4, '0')}`, date: new Date().toISOString(),
        billNo: sale.billNo, customerName: sale.customerName, reason,
        items: exItems, refund: Math.round(refund * 100) / 100, additional: 0, by: user.name,
      };
      const allReturned = sale.items.every((it, idx) => {
        const returned = priorReturnedByLine.has('i:' + idx)
          ? (priorReturnedByLine.get('i:' + idx) || 0)
          : (priorReturnedByProduct.get(it.productId) || 0);
        return returned >= it.qty;
      });

      return {
        ...s,
        exchanges: [ex, ...s.exchanges],
        counters: { ...s.counters, ex: seq },
        sales: s.sales.map(x => x.id === saleId ? { ...x, status: allReturned ? 'exchanged' : 'completed' } : x),
        products: s.products.map(p => {
          const qty = restockQtyByProduct.get(p.id);
          return qty !== undefined ? { ...p, stock: p.stock + qty } : p;
        }),
        units: (s.units || []).map(u => returnedUnitIds.includes(u.id)
          ? { ...u, status: 'in_stock' as const, saleId: undefined, saleBillNo: undefined, soldAt: undefined }
          : u),
      };
    });
    pushAudit('EXCHANGE', 'Exchange', `${mode === 'refund' ? 'Returned' : 'Exchanged'} ${returns.reduce((sum, x) => sum + Math.max(0, Math.floor(x.qty)), 0)} unit(s) on ${sale.billNo}`);
  }, [state.sales, state.settings.exchangeDays, pushAudit, user, can]);

  /* ---------------- users ---------------- */
  const saveUser = useCallback(async (u: AppUser) => {
    if (!user || user.role !== 'admin') {
      pushAudit('DENIED', 'User', `Blocked user save for ${u.email || u.name || u.id}`);
      return;
    }
    if (!(await confirmSensitiveAdmin('user account create/change'))) return;
    const exists = state.users.some(x => x.id === u.id);
    // Password changes and newly created accounts must use the same 12+ character
    // policy as first-login and managed-password flows. Existing hashes are kept
    // unchanged when the password field is intentionally left blank by the UI.
    const existing = state.users.find(x => x.id === u.id);
    const suppliedPassword = String(u.password || '');
    const passwordChanged = !existing || suppliedPassword !== existing.password;    if (passwordChanged && suppliedPassword.length < 12) {
      pushAudit('DENIED', 'User', `Blocked weak password for ${u.email || u.name || u.id}`);
      return;
    }
    const password = isHashed(suppliedPassword)
      ? suppliedPassword
      : (existing && suppliedPassword === existing.password ? existing.password : hashPassword(suppliedPassword));
    const toSave = { ...u, password };
    setState(s => ({ ...s, users: exists ? s.users.map(x => (x.id === u.id ? toSave : x)) : [...s.users, toSave] }));
    pushAudit(exists ? 'UPDATE' : 'CREATE', 'User', `${exists ? 'Updated' : 'Created'} user ${u.name} (${u.role})`);
  }, [state.users, pushAudit, user, confirmSensitiveAdmin]);

  const toggleUserActive = useCallback(async (id: string) => {
    if (!user || user.role !== 'admin') {
      pushAudit('DENIED', 'User', `Blocked user status change for ${id}`);
      return;
    }
    if (!(await confirmSensitiveAdmin('user activation change'))) return;
    const u = state.users.find(x => x.id === id);
    setState(s => ({ ...s, users: s.users.map(x => (x.id === id ? { ...x, active: !x.active } : x)) }));
    if (u) pushAudit('UPDATE', 'User', `${u.active ? 'Deactivated' : 'Activated'} user ${u.name}`);
  }, [state.users, pushAudit, user, confirmSensitiveAdmin]);

  const deleteUser = useCallback(async (id: string) => {
    if (!user || user.role !== 'admin') {
      pushAudit('DENIED', 'User', `Blocked user delete for ${id}`);
      return;
    }
    if (!(await confirmSensitiveAdmin('user deletion'))) return;
    const u = state.users.find(x => x.id === id);
    if (!u || u.id === user?.id) return;
    setState(s => ({ ...s, users: s.users.filter(x => x.id !== id) }));
    pushAudit('DELETE', 'User', `Deleted user ${u.name}`);
  }, [state.users, user?.id, pushAudit, user, confirmSensitiveAdmin]);

  /* ---------------- admin ---------------- */
  const setPermission = useCallback(async (role: Role, key: string, value: boolean) => {
    if (!user || user.role !== 'admin') {
      pushAudit('DENIED', 'Permissions', `Blocked permission change for ${role}:${key}`);
      return;
    }
    if (role === 'admin') return;
    if (!(await confirmSensitiveAdmin('permission matrix change'))) return;
    if (!PERMISSION_KEYS.some(item => item.key === key)) {
      pushAudit('DENIED', 'Permissions', `Blocked unknown permission key: ${role}:${key}`);
      return;
    }
    setState(s => ({
      ...s,
      permissions: { ...s.permissions, [role]: { ...s.permissions[role], [key]: value } },
    }));
    pushAudit('PERMISSION', 'Permissions', `Set ${key} = ${value ? 'ON' : 'OFF'} for ${role}`);
  }, [pushAudit, user, confirmSensitiveAdmin]);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    if (!user || user.role !== 'admin') {
      pushAudit('DENIED', 'Settings', `Blocked settings update: ${Object.keys(patch).join(', ')}`);
      return;
    }
    const nextState = {
      ...stateRef.current,
      settings: { ...stateRef.current.settings, ...patch },
    };
    setState(s => ({ ...s, settings: nextState.settings }));
    // Shop identity/display metadata is synced immediately and separately from
    // the configured full-backup interval. This keeps Drive folder/shop files
    // current without turning every settings edit into an unexpected snapshot.
    void syncShopMetadataToGoogleDrive(nextState).then(result => {
      if (!result.ok) console.warn('[Google Backup] shop metadata sync failed', result.error);
    });
    scheduleGoogleBackup(() => stateRef.current, 'settings');
    pushAudit('SETTINGS', 'Settings', `Updated settings: ${Object.keys(patch).join(', ')}`);
  }, [pushAudit, user]);

  const closeSession = useCallback((cashierId: string, counted: number, note: string): boolean => {
    if (!user || (user.role !== 'admin' && (user.id !== cashierId || !can('page:pos')))) {
      pushAudit('DENIED', 'Session', 'Blocked cash-session close: only the cashier or an admin may sign off this drawer');
      return false;
    }
    const amount = Number(counted);
    const cleanNote = String(note || '').trim();
    if (!cashierId || !Number.isFinite(amount) || amount < 0) {
      pushAudit('DENIED', 'Session', 'Blocked invalid cash-session closing count');
      return false;
    }
    const snapshot = stateRef.current;
    const today = dkey(new Date());
    const selectedBranchId = snapshot.settings.branchId || 'local-main';
    const defaultBranchId = getDefaultBranchId(getCloudShopId()) || 'local-main';
    const effectiveBranch = (branchId?: string) => !branchId || branchId === 'local-main' ? defaultBranchId : branchId;
    if (hasMultipleCachedBranches(getCloudShopId()) && selectedBranchId === 'local-main') {
      pushAudit('DENIED', 'Session', 'Blocked day-session close because this shop has multiple branches and no branch is selected. Open Settings first.');
      return false;
    }
    const current = snapshot.sessions.find(x => x.cashierId === cashierId && x.date === today && effectiveBranch(x.branchId) === effectiveBranch(selectedBranchId));
    if (!current) {
      pushAudit('DENIED', 'Session', 'Blocked cash-session close: no session exists for today');
      return false;
    }
    if (current.closed) {
      pushAudit('DENIED', 'Session', 'Blocked cash-session close: session is already closed');
      return false;
    }
    if (current.openingConfirmed === false) {
      pushAudit('DENIED', 'Session', 'Blocked cash-session close: opening float has not been confirmed');
      return false;
    }
    if (snapshot.held.length || (snapshot.reverseRequests || []).some(request => request.status === 'pending')) {
      pushAudit('DENIED', 'Session', 'Blocked cash-session close: held bills or pending reverse approvals must be resolved first');
      return false;
    }
    const expected = calculateDayEndTotals(snapshot, today, current).expected;
    const variance = Math.round((amount - expected) * 100) / 100;
    if (variance !== 0 && !cleanNote) {
      pushAudit('DENIED', 'Session', 'Blocked cash-session close: a variance note is required');
      return false;
    }
    const closedAt = new Date().toISOString();
    let closed = false;
    setState(s => {
      const currentSession = s.sessions.find(x => x.id === current.id);
      if (!currentSession || currentSession.closed) return s;
      closed = true;
      return {
        ...s,
        sessions: s.sessions.map(x => x.id === current.id
          ? { ...x, closed: true, closing: Math.round(amount * 100) / 100, expected, variance, closedAt, closedBy: user.name, note: cleanNote || undefined }
          : x),
      };
    });
    if (!closed) return false;
    pushAudit('DAY-CLOSE', 'Session', `Cashier sign off · ${current.cashierName} · expected Rs. ${expected.toLocaleString()} · counted Rs. ${amount.toLocaleString()} · variance Rs. ${variance.toLocaleString()}${cleanNote ? ` · ${cleanNote}` : ''}`);
    return true;
  }, [pushAudit, user, can]);

  const closeDay = useCallback((counts: Record<string, number>, note: string): boolean => {
    if (!user || user.role !== 'admin') {
      pushAudit('DENIED', 'DayClose', 'Blocked full day close without admin access');
      return false;
    }
    const snapshot = stateRef.current;
    const today = dkey(new Date());
    const selectedBranchId = snapshot.settings.branchId || 'local-main';
    const defaultBranchId = getDefaultBranchId(getCloudShopId()) || 'local-main';
    const effectiveBranch = (branchId?: string) => !branchId || branchId === 'local-main' ? defaultBranchId : branchId;
    if (hasMultipleCachedBranches(getCloudShopId()) && selectedBranchId === 'local-main') {
      pushAudit('DENIED', 'DayClose', 'Blocked day close because this shop has multiple branches and no branch is selected. Open Settings first.');
      return false;
    }
    const openSessions = snapshot.sessions.filter(x => x.date === today && !x.closed && effectiveBranch(x.branchId) === effectiveBranch(selectedBranchId));
    if (!openSessions.length) {
      pushAudit('DENIED', 'DayClose', 'Blocked day close: no open cashier sessions');
      return false;
    }
    if (openSessions.some(session => session.openingConfirmed === false)) {
      pushAudit('DENIED', 'DayClose', 'Blocked day close: every open drawer must confirm its opening float first');
      return false;
    }
    if (snapshot.held.length) {
      pushAudit('DENIED', 'DayClose', 'Blocked day close: held sales must be completed or cleared first');
      return false;
    }
    if ((snapshot.reverseRequests || []).some(request => request.status === 'pending')) {
      pushAudit('DENIED', 'DayClose', 'Blocked day close: pending bill reverse approvals exist');
      return false;
    }
    const cleanNote = String(note || '').trim();
    const closings = new Map<string, { counted: number; expected: number; variance: number }>();
    let anyVariance = false;
    for (const session of openSessions) {
      const counted = Number(counts[session.cashierId]);
      if (!Number.isFinite(counted) || counted < 0) {
        pushAudit('DENIED', 'DayClose', `Blocked day close: counted cash missing for ${session.cashierName}`);
        return false;
      }
      const expected = calculateDayEndTotals(snapshot, today, session).expected;
      const roundedCount = Math.round(counted * 100) / 100;
      const variance = Math.round((roundedCount - expected) * 100) / 100;
      closings.set(session.id, { counted: roundedCount, expected, variance });
      if (variance !== 0) anyVariance = true;
    }
    if (anyVariance && !cleanNote) {
      pushAudit('DENIED', 'DayClose', 'Blocked day close: variance note is required');
      return false;
    }
    const closedAt = new Date().toISOString();
    setState(s => ({
      ...s,
      sessions: s.sessions.map(session => {
        if (session.date !== today || session.closed) return session;
        const close = closings.get(session.id);
        if (!close) return session;
        return {
          ...session,
          closed: true,
          closing: close.counted,
          expected: close.expected,
          variance: close.variance,
          closedAt,
          closedBy: user.name,
          note: cleanNote || undefined,
        };
      }),
    }));
    const totalExpected = [...closings.values()].reduce((sum, close) => sum + close.expected, 0);
    const totalCounted = [...closings.values()].reduce((sum, close) => sum + close.counted, 0);
    const variance = Math.round((totalCounted - totalExpected) * 100) / 100;
    pushAudit('DAY-CLOSE', 'DayClose', `Full day signed off · ${openSessions.length} drawer(s) · expected Rs. ${totalExpected.toLocaleString()} · counted Rs. ${totalCounted.toLocaleString()} · variance Rs. ${variance.toLocaleString()}${cleanNote ? ` · ${cleanNote}` : ''}`);
    return true;
  }, [pushAudit, user]);

  // auto-open today's drawer session once per cashier
  useEffect(() => {
    if (!user) return;
    const today = dkey(new Date());
    const selectedBranchId = stateRef.current.settings.branchId || 'local-main';
    const defaultBranchId = getDefaultBranchId(getCloudShopId()) || 'local-main';
    const effectiveBranch = (branchId?: string) => !branchId || branchId === 'local-main' ? defaultBranchId : branchId;
    if (hasMultipleCachedBranches(getCloudShopId()) && selectedBranchId === 'local-main') return;
    if (state.sessions.some(x => x.cashierId === user.id && x.date === today && effectiveBranch(x.branchId) === effectiveBranch(selectedBranchId))) return;
    const ns: DaySession = {
      id: uid(), branchId: stateRef.current.settings.branchId || 'local-main', cashierId: user.id, cashierName: user.name, date: today,
      opening: state.settings.openingFloat, openingConfirmed: false, closed: false,
    };
    setState(s =>
      s.sessions.some(x => x.cashierId === user.id && x.date === today && effectiveBranch(x.branchId) === effectiveBranch(selectedBranchId))
        ? s
        : { ...s, sessions: [...s.sessions, ns] },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, state.settings.branchId]);

  const logAudit = useCallback((action: string, entity: string, details: string) => {
    pushAudit(action, entity, details);
  }, [pushAudit]);

  /** Audit log is append-only — clear is disabled for accountability */
  const clearAudit = useCallback(() => {
    setState(s => ({
      ...s,
      audit: [{
        id: uid(), time: new Date().toISOString(),
        user: user?.email || 'system', action: 'DENIED', entity: 'Audit',
        details: 'Attempted to clear audit log — blocked (append-only policy)',
      }, ...s.audit].slice(0, 500),
    }));
  }, [user?.email]);

  const exportData = useCallback(async () => {
    if (!user || !can('act:export')) {
      pushAudit('DENIED', 'Settings', 'Blocked data export without export permission');
      return '';
    }
    if (!(await confirmSensitiveAdmin('full POS data export'))) return '';
    return JSON.stringify(state, null, 2);
  }, [state, user, can, pushAudit]);

  const importData = useCallback(async (json: string) => {
    if (!user || user.role !== 'admin') {
      pushAudit('DENIED', 'Settings', 'Blocked backup import without admin access');
      return false;
    }
    if (!(await confirmSensitiveAdmin('full POS backup import'))) return false;
    try {
      const parsed = JSON.parse(json) as POSState;
      // Basic schema validation — reject malicious / incomplete payloads
      if (!parsed || typeof parsed !== 'object') return false;
      if (!Array.isArray(parsed.products) || !Array.isArray(parsed.users) || !Array.isArray(parsed.sales)) return false;
      if (!parsed.settings || typeof parsed.settings !== 'object') return false;
      if (!parsed.permissions || typeof parsed.permissions !== 'object') return false;
      // Ensure no user can inject an elevated role without a valid structure
      const safeUsers = parsed.users.filter(
        (u): u is AppUser =>
          !!u && typeof u.id === 'string' && typeof u.email === 'string' &&
          (u.role === 'admin' || u.role === 'cashier' || u.role === 'manager' || u.role === 'technician') && typeof u.password === 'string',
      );
      if (safeUsers.length === 0) return false;
      // Strip wrapper _meta if present from our backup format
      const { _meta: _ignored, ...rest } = parsed as POSState & { _meta?: unknown };
      const migrated = migrate({ ...rest, users: safeUsers });
      setState(migrated);
      pushAudit('IMPORT', 'Settings', `Imported backup data · ${safeUsers.length} users · ${parsed.products.length} products`);
      return true;
    } catch { return false; }
  }, [pushAudit, user]);

  const resetData = useCallback(() => {
    if (!user || user.role !== 'admin') {
      pushAudit('DENIED', 'Settings', 'Blocked demo-data reset without admin access');
      return;
    }
    const seed = buildSeed();
    setState(seed);
    pushAudit('RESET', 'Settings', 'Restored demo seed dataset');
  }, [pushAudit, user]);

  const refreshPOS = useCallback(async () => {
    // A refresh is a data reload, not an authentication operation. Capture the
    // React session first and restore that exact session after the data reload.
    // This prevents a stale IDB snapshot from making user temporarily null and
    // triggering Protected -> /login.
    const current = stateRef.current;
    const activeSession = session;
    try {
      if (ready) await persistState(current);

      const fromIdb = idbAvailable() ? await idbLoadState() : null;
      let refreshed = fromIdb ? migrate(fromIdb) : (loadStateFromLocalStorage() || buildSeed());

      if (activeSession) {
        const currentUser = current.users.find(u => u.id === activeSession.userId);
        const refreshedUser = refreshed.users.find(u => u.id === activeSession.userId);

        // Always prefer the currently authenticated user's in-memory record.
        // This is important when the durable snapshot is one write behind.
        if (currentUser) {
          refreshed = {
            ...refreshed,
            users: [
              currentUser,
              ...refreshed.users.filter(u => u.id !== currentUser.id),
            ],
          };
        } else if (!refreshedUser) {
          // No valid user record is available to preserve; keep the current
          // state instead of turning a refresh into an unexpected logout.
          setSession(activeSession);
          setState(current);
          return;
        }
      }

      setState(refreshed);
      // Explicitly restore the React session captured before the reload.
      // Do not clear or replace localStorage/sessionStorage credentials here.
      if (activeSession) setSession(activeSession);
    } catch {
      // A refresh failure must leave the authenticated POS session untouched.
      setState(current);
      if (activeSession) setSession(activeSession);
    }
  }, [ready, session]);

  /* ---------------- units (IMEI / serial) ---------------- */
  const saveUnit = useCallback(async (u: InventoryUnit): Promise<boolean> => {
    const shopId = getCloudShopId();
    const selectedBranchId = stateRef.current.settings.branchId || 'local-main';
    const defaultBranchId = getDefaultBranchId(shopId) || 'local-main';
    const effectiveBranch = (branchId?: string) => !branchId || branchId === 'local-main' ? defaultBranchId : branchId;
    if (hasMultipleCachedBranches(shopId) && selectedBranchId === 'local-main') {
      pushAudit('DENIED', 'Unit', 'Blocked unit save because this shop has multiple branches and no branch is selected. Open Settings first.');
      return false;
    }
    const targetBranchId = effectiveBranch(selectedBranchId);
    if (!user || !can('page:units') || !can('act:manageStock')) {
      pushAudit('DENIED', 'Unit', 'Blocked unit save without required inventory permissions');
      return false;
    }
    const currentState = stateRef.current;
    const product = currentState.products.find(p => p.id === u.productId);
    if (!product || (!product.trackImei && !product.trackSerial)) {
      pushAudit('DENIED', 'Unit', `Blocked unit save for untracked product ${u.productId}`);
      return false;
    }
    const imei = u.imei?.trim() || '';
    const serial = u.serial?.trim() || '';
    if (product.trackImei && !imei || product.trackSerial && !serial) {
      pushAudit('DENIED', 'Unit', `Blocked incomplete tracked unit for ${u.productId}`);
      return false;
    }
    if (!product.trackImei && imei || !product.trackSerial && serial) {
      pushAudit('DENIED', 'Unit', `Blocked unexpected identifier for ${u.productId}`);
      return false;
    }
    const existingUnit = (currentState.units || []).find(x => x.id === u.id);
    const exists = !!existingUnit;
    if (existingUnit && existingUnit.productId !== u.productId) {
      pushAudit('DENIED', 'Unit', 'Blocked unit product reassignment');
      return false;
    }
    if (existingUnit && effectiveBranch(existingUnit.branchId) !== targetBranchId) {
      pushAudit('DENIED', 'Unit', 'Blocked editing a unit from another branch. Use a stock transfer to move units between branches.');
      return false;
    }
    if (existingUnit && existingUnit.status !== 'in_stock') {
      pushAudit('DENIED', 'Unit', 'Blocked edit of historical/non-stock unit');
      return false;
    }
    if (u.status !== 'in_stock') {
      pushAudit('DENIED', 'Unit', 'Unit creation/edit must keep inventory status as in_stock; sales and returns control status transitions');
      return false;
    }
    const dup = (currentState.units || []).find(x =>
      x.id !== u.id &&
      ((imei && (x.imei || '').trim().toLowerCase() === imei.toLowerCase()) ||
       (serial && (x.serial || '').trim().toLowerCase() === serial.toLowerCase())),
    );
    if (dup) {
      pushAudit('DENIED', 'Unit', `Duplicate IMEI/serial blocked: ${imei || serial}`);
      return false;
    }
    const normalized = { ...u, branchId: existingUnit?.branchId || targetBranchId, imei: imei || undefined, serial: serial || undefined };
    const newUnitIds = exists ? [] : [normalized.id];
    let cacheIncremented = false;
    let productStocks: Record<string, number> | undefined;
    let insertedCount: number | undefined;

    if (supabaseConfigured && getConnectivity() === 'online') {
      const shop = await ensureCloudShop('Nexfix Shop');
      if (!shop.ok || !shop.shopId) {
        pushAudit('DENIED', 'Unit', 'Tracked unit was not saved: ' + (shop.error || 'Cloud shop is unavailable.'));
        return false;
      }
      const catalog = await syncNormalizedCatalog({ ...stateRef.current, units: [] }, shop.shopId);
      if (!catalog.ok) {
        pushAudit('DENIED', 'Unit', 'Tracked unit was not saved: ' + (catalog.error || 'Catalog sync failed.'));
        return false;
      }
      const cloudResult = await addInventoryUnitsAtomic({ shopId: shop.shopId, branchId: targetBranchId, deviceId: getMachineIdentity().id, units: [normalized] });
      if (!cloudResult.ok) {
        pushAudit('DENIED', 'Unit', 'Tracked unit was not saved: ' + (cloudResult.error || 'Cloud transaction failed.'));
        return false;
      }
      productStocks = cloudResult.productStocks;
      insertedCount = cloudResult.inserted;
    } else {
      if (!exists && targetBranchId !== 'local-main') {
        if (selectedBranchId !== 'local-main' && !hasCachedBranchStock(targetBranchId)) {
          pushAudit('DENIED', 'Unit', 'Tracked unit was not saved because branch stock is not cached. Connect online and refresh Settings.');
          return false;
        }
        if (hasCachedBranchStock(targetBranchId)) {
          if (!applyBranchStockDeltas(targetBranchId, { [u.productId]: 1 })) {
            pushAudit('DENIED', 'Unit', 'Tracked unit was not saved because the local branch stock cache could not be updated.');
            return false;
          }
          cacheIncremented = true;
        }
      }
      if (supabaseConfigured) {
        try {
          await queueInventoryUnitsAdd({ shopId: shopId || undefined, branchId: targetBranchId, deviceId: getMachineIdentity().id, units: [normalized], newUnitIds, operationId: uid() });
        } catch (error) {
          if (cacheIncremented) applyBranchStockDeltas(targetBranchId, { [u.productId]: -1 });
          pushAudit('DENIED', 'Unit', error instanceof Error ? error.message : 'Tracked unit could not be queued for cloud sync.');
          return false;
        }
      }
    }

    const stockIncrement = exists ? 0 : (insertedCount === undefined ? 1 : insertedCount > 0 ? 1 : 0);
    setState(s => ({
      ...s,
      units: exists
        ? (s.units || []).map(x => (x.id === u.id ? normalized : x))
        : [normalized, ...(s.units || [])],
      products: s.products.map(p => {
        if (productStocks && productStocks[p.id] !== undefined) return { ...p, stock: productStocks[p.id] };
        return p.id === u.productId && stockIncrement ? { ...p, stock: p.stock + stockIncrement } : p;
      }),
    }));
    pushAudit(exists ? 'UPDATE' : 'CREATE', 'Unit', `${exists ? 'Updated' : 'Added'} unit ${imei || serial || u.id}`);
    return true;
  }, [pushAudit, user, can, setState]);

  const saveUnitsBulk = useCallback(async (newUnits: InventoryUnit[], catalogProducts: Product[] = []): Promise<{ ok: boolean; added: number; errors: string[] }> => {
    const shopId = getCloudShopId();
    const selectedBranchId = stateRef.current.settings.branchId || 'local-main';
    const defaultBranchId = getDefaultBranchId(shopId) || 'local-main';
    const effectiveBranch = (branchId?: string) => !branchId || branchId === 'local-main' ? defaultBranchId : branchId;
    if (hasMultipleCachedBranches(shopId) && selectedBranchId === 'local-main') return { ok: false, added: 0, errors: ['Select this POS branch in Settings before adding IMEI/serial units.'] };
    const targetBranchId = effectiveBranch(selectedBranchId);
    if (!user || !can('act:manageStock')) return { ok: false, added: 0, errors: ['You do not have permission to manage inventory units.'] };
    const currentState = stateRef.current;
    const errors: string[] = [];
    const current = currentState.units || [];
    const currentProducts = [...new Map([...currentState.products, ...catalogProducts].map(product => [product.id, product])).values()];
    const imeis = new Set(current.map(u => (u.imei || '').trim().toLowerCase()).filter(Boolean));
    const serials = new Set(current.map(u => (u.serial || '').trim().toLowerCase()).filter(Boolean));
    const accepted: InventoryUnit[] = [];
    const replacements: InventoryUnit[] = [];
    const usedPlaceholderIds = new Set<string>();

    for (let i = 0; i < newUnits.length; i++) {
      const u = newUnits[i], line = i + 1;
      if (u.status !== 'in_stock') { errors.push('Line ' + line + ': new inventory units must start as in_stock'); continue; }
      const product = currentProducts.find(p => p.id === u.productId);
      const imei = (u.imei || '').trim(), serial = (u.serial || '').trim();
      if (!product) { errors.push('Line ' + line + ': product not found'); continue; }
      if (!product.trackImei && !product.trackSerial) { errors.push('Line ' + line + ': product is not configured for IMEI/serial tracking'); continue; }
      if (product.trackImei && !imei || product.trackSerial && !serial) { errors.push('Line ' + line + ': required IMEI/serial identifier is missing'); continue; }
      if (!product.trackImei && imei || !product.trackSerial && serial) { errors.push('Line ' + line + ': identifier does not match the product tracking settings'); continue; }
      const ik = imei.toLowerCase(), sk = serial.toLowerCase();
      if (imei && imeis.has(ik)) { errors.push('Line ' + line + ': duplicate IMEI'); continue; }
      if (serial && serials.has(sk)) { errors.push('Line ' + line + ': duplicate serial'); continue; }
      if (imei) imeis.add(ik);
      if (serial) serials.add(sk);

      const placeholder = current.find(x =>
        !usedPlaceholderIds.has(x.id) && x.productId === u.productId && x.status === 'in_stock' && !!x.purchaseId &&
        effectiveBranch(x.branchId) === targetBranchId && ((!x.imei && imei) || (!x.serial && serial))
      );
      if (placeholder) {
        usedPlaceholderIds.add(placeholder.id);
        replacements.push({ ...u, id: placeholder.id, branchId: placeholder.branchId || targetBranchId, purchaseId: placeholder.purchaseId, createdAt: placeholder.createdAt, cost: placeholder.cost, expiryDate: placeholder.expiryDate });
      } else {
        accepted.push({ ...u, branchId: targetBranchId });
      }
    }

    if (!accepted.length && !replacements.length) return { ok: false, added: 0, errors };
    const counts = new Map<string, number>();
    for (const u of accepted) counts.set(u.productId, (counts.get(u.productId) || 0) + 1);
    const toSync = [...accepted, ...replacements];
    let cacheDeltasApplied = false;
    let productStocks: Record<string, number> | undefined;
    if (supabaseConfigured && getConnectivity() === 'online') {
      const shop = await ensureCloudShop('Nexfix Shop');
      if (!shop.ok || !shop.shopId) return { ok: false, added: 0, errors: [...errors, shop.error || 'Cloud shop is unavailable.'] };
      const catalog = await syncNormalizedCatalog({ ...stateRef.current, products: currentProducts, units: [] }, shop.shopId);
      if (!catalog.ok) return { ok: false, added: 0, errors: [...errors, catalog.error || 'Catalog sync failed.'] };
      const cloudResult = await addInventoryUnitsAtomic({ shopId: shop.shopId, branchId: targetBranchId, deviceId: getMachineIdentity().id, units: toSync });
      if (!cloudResult.ok) return { ok: false, added: 0, errors: [...errors, cloudResult.error || 'Cloud unit transaction failed.'] };
      productStocks = cloudResult.productStocks;
    } else {
      const deltas = Object.fromEntries(counts.entries());
      if (targetBranchId !== 'local-main' && Object.keys(deltas).length) {
        if (selectedBranchId !== 'local-main' && !hasCachedBranchStock(targetBranchId)) return { ok: false, added: 0, errors: [...errors, 'Branch stock is not cached. Connect online and refresh Settings.'] };
        if (hasCachedBranchStock(targetBranchId)) {
          if (!applyBranchStockDeltas(targetBranchId, deltas)) return { ok: false, added: 0, errors: [...errors, 'Branch stock cache could not be updated safely.'] };
          cacheDeltasApplied = true;
        }
      }
      if (supabaseConfigured) {
        try {
          await queueInventoryUnitsAdd({ shopId: shopId || undefined, branchId: targetBranchId, deviceId: getMachineIdentity().id, units: toSync, newUnitIds: accepted.map(unit => unit.id), operationId: uid() });
        } catch (error) {
          if (cacheDeltasApplied) applyBranchStockDeltas(targetBranchId, Object.fromEntries([...counts.entries()].map(([id, qty]) => [id, -qty])));
          return { ok: false, added: 0, errors: [...errors, error instanceof Error ? error.message : 'Tracked units could not be queued for cloud sync.'] };
        }
      }
    }

    const replacementMap = new Map(replacements.map(u => [u.id, u]));
    setState(s => ({
      ...s,
      units: [...accepted, ...(s.units || []).map(u => replacementMap.get(u.id) || u)],
      products: s.products.map(p => {
        if (productStocks && productStocks[p.id] !== undefined) return { ...p, stock: productStocks[p.id] };
        return counts.has(p.id) ? { ...p, stock: p.stock + counts.get(p.id)! } : p;
      }),
    }));
    const added = accepted.length + replacements.length;
    pushAudit('CREATE', 'Unit', 'Bulk added ' + added + ' IMEI/serial units');
    return { ok: true, added, errors };
  }, [user, can, pushAudit, setState]);

  const deleteUnit = useCallback(async (id: string): Promise<boolean> => {
    if (!user || !can('page:units') || !can('act:deleteRecords')) {
      pushAudit('DENIED', 'Unit', 'Blocked unit delete without required permissions');
      return false;
    }
    const snapshot = stateRef.current;
    const unit = (snapshot.units || []).find(x => x.id === id);
    if (!unit) return false;
    const shopId = getCloudShopId();
    const selectedBranchId = snapshot.settings.branchId || 'local-main';
    const defaultBranchId = getDefaultBranchId(shopId) || 'local-main';
    const effectiveBranch = (branchId?: string) => !branchId || branchId === 'local-main' ? defaultBranchId : branchId;
    if (hasMultipleCachedBranches(shopId) && selectedBranchId === 'local-main') {
      pushAudit('DENIED', 'Unit', 'Blocked unit delete because this shop has multiple branches and no branch is selected. Open Settings first.');
      return false;
    }
    const targetBranchId = effectiveBranch(selectedBranchId);
    if (effectiveBranch(unit.branchId) !== targetBranchId) {
      pushAudit('DENIED', 'Unit', 'Blocked deleting a unit from another branch.');
      return false;
    }
    if (unit.status !== 'in_stock') {
      pushAudit('DENIED', 'Unit', 'Blocked deletion of ' + (unit.imei || unit.serial || unit.id) + ': historical/non-stock unit must be retained');
      return false;
    }

    let cloudProductStock: number | undefined;
    let cacheDecremented = false;
    if (supabaseConfigured && getConnectivity() === 'online') {
      const shop = await ensureCloudShop('Nexfix Shop');
      if (!shop.ok || !shop.shopId) {
        pushAudit('DENIED', 'Unit', 'Tracked unit was not deleted: ' + (shop.error || 'Cloud shop is unavailable.'));
        return false;
      }
      const branchUnits = (snapshot.units || []).filter(item => effectiveBranch(item.branchId) === targetBranchId);
      const catalog = await syncNormalizedCatalog({ ...snapshot, units: branchUnits }, shop.shopId);
      if (!catalog.ok) {
        pushAudit('DENIED', 'Unit', 'Tracked unit was not deleted: ' + (catalog.error || 'Catalog sync failed.'));
        return false;
      }
      const cloudResult = await deleteInventoryUnitAtomic({ shopId: shop.shopId, branchId: targetBranchId, deviceId: getMachineIdentity().id, unitId: unit.id });
      if (!cloudResult.ok) {
        pushAudit('DENIED', 'Unit', 'Tracked unit was not deleted: ' + (cloudResult.error || 'Cloud transaction failed.'));
        return false;
      }
      cloudProductStock = cloudResult.productStock;
    } else {
      if (targetBranchId !== 'local-main') {
        if (selectedBranchId !== 'local-main' && !hasCachedBranchStock(targetBranchId)) {
          pushAudit('DENIED', 'Unit', 'Tracked unit was not deleted because branch stock is not cached. Connect online and refresh Settings.');
          return false;
        }
        if (hasCachedBranchStock(targetBranchId)) {
          if (!applyBranchStockDeltas(targetBranchId, { [unit.productId]: -1 })) {
            pushAudit('DENIED', 'Unit', 'Tracked unit was not deleted because selected-branch stock could not be decremented safely.');
            return false;
          }
          cacheDecremented = true;
        }
      }
      if (supabaseConfigured) {
        try {
          await queueInventoryUnitDelete({ shopId: shopId || undefined, branchId: targetBranchId, deviceId: getMachineIdentity().id, unit, operationId: uid() });
        } catch (error) {
          if (cacheDecremented) applyBranchStockDeltas(targetBranchId, { [unit.productId]: 1 });
          pushAudit('DENIED', 'Unit', error instanceof Error ? error.message : 'Tracked unit deletion could not be queued safely.');
          return false;
        }
      }
    }

    setStateWithInventoryLedger('UNIT_DELETE', s => ({
      ...s,
      units: (s.units || []).filter(x => x.id !== id),
      products: s.products.map(p => p.id === unit.productId
        ? { ...p, stock: cloudProductStock === undefined ? Math.max(0, p.stock - 1) : cloudProductStock }
        : p),
    }));
    pushAudit('DELETE', 'Unit', `Deleted unit ${unit.imei || unit.serial || unit.id}`);
    return true;
  }, [pushAudit, user, can, setStateWithInventoryLedger]);

  const findUnitByCode = useCallback((code: string) => {
    const q = code.trim().toLowerCase();
    if (!q) return undefined;
    return (state.units || []).find(u =>
      (u.imei && u.imei.toLowerCase() === q) ||
      (u.serial && u.serial.toLowerCase() === q) ||
      u.id.toLowerCase() === q,
    );
  }, [state.units]);

  /* ---------------- repairs ---------------- */
  const saveRepair = useCallback((r: RepairJob) => {
    if (!user || !can('page:repairs')) {
      pushAudit('DENIED', 'Repair', 'Blocked repair save without repairs access');
      return;
    }
    const repairs=state.repairs||[], exists=repairs.some(x=>x.id===r.id), jobNo=(r.jobNo||'').trim();
    if(!r.customerName.trim()||!r.deviceType.trim()||!r.deviceModel.trim()||!r.fault.trim()) return;
    if(!Number.isFinite(r.laborCost)||r.laborCost<0) return;
    if(r.advancePaid!=null&&(!Number.isFinite(r.advancePaid)||r.advancePaid<0)) return;
    if(r.warrantyDays!=null&&(!Number.isFinite(r.warrantyDays)||r.warrantyDays<0)) return;
    const parts=(r.parts||[]).map(pt=>({...pt,name:pt.name.trim(),qty:Number(pt.qty),cost:Number(pt.cost),productId:pt.productId?.trim()||undefined}));
    if(parts.some(pt=>!pt.name||!Number.isInteger(pt.qty)||pt.qty<=0||!Number.isFinite(pt.cost)||pt.cost<0)) return;
    if(jobNo&&repairs.some(x=>x.id!==r.id&&x.jobNo.trim().toLowerCase()===jobNo.toLowerCase())) return;
    const old=repairs.find(x=>x.id===r.id);
    // Parts are deducted exactly once at delivery. Once deducted, keep the
    // historical parts/partsDeductedAt fields immutable while allowing safe
    // metadata edits (customer, diagnosis, notes, promised date, etc.).
    if (old?.partsDeductedAt) {
      if (!exists || !old) return;
      if (parts.length !== old.parts.length || parts.some((pt, i) => pt.productId !== old.parts[i]?.productId || pt.qty !== old.parts[i]?.qty || pt.cost !== old.parts[i]?.cost)) return;
    }
    if (parts.some(pt => pt.productId && state.products.find(p => p.id === pt.productId)?.trackImei || pt.productId && state.products.find(p => p.id === pt.productId)?.trackSerial)) return;
    setState(st=>{let job:RepairJob={...r,jobNo:jobNo||r.jobNo,parts:old?.partsDeductedAt?old.parts:parts,partsDeductedAt:old?.partsDeductedAt,by:r.by||user.name};let counters=st.counters;if(!exists&&(!job.jobNo||job.jobNo.startsWith('JOB-TEMP'))){const seq=(st.counters.job||0)+1;job={...job,jobNo:`JOB-${String(seq).padStart(4,'0')}`};counters={...st.counters,job:seq};}return {...st,counters,repairs:exists?(st.repairs||[]).map(x=>x.id===r.id?job:x):[job,...(st.repairs||[])]};});
    pushAudit(exists?'UPDATE':'CREATE','Repair',`${exists?'Updated':'Opened'} ${jobNo||'job'} · ${r.deviceBrand} ${r.deviceModel}`);
  }, [state.repairs,state.products,pushAudit,user,can]);

  const updateRepairStatus = useCallback(async (id: string, status: RepairStatus, patch?: Partial<RepairJob>) => {
    if (!user || !can('page:repairs')) {
      pushAudit('DENIED', 'Repair', 'Blocked repair status update without repairs access');
      return;
    }
    const allowed: RepairStatus[] = ['received', 'diagnosed', 'waiting_parts', 'in_repair', 'ready', 'delivered', 'cancelled'];
    if (!allowed.includes(status)) return;
    const current = (state.repairs || []).find(j => j.id === id);
    if (!current) return;
    if (current.partsDeductedAt) {
      if (patch?.parts !== undefined) {
        pushAudit('DENIED', 'Repair', 'Blocked repair-part changes after stock was deducted');
        return;
      }
      if (status !== 'delivered') {
        pushAudit('DENIED', 'Repair', 'Blocked status change after repair delivery');
        return;
      }
    }
    const next = { ...current, ...patch, status };
    const now = new Date().toISOString();
    const shouldDeductParts = status === 'delivered' && current.status !== 'delivered' && !current.partsDeductedAt;
    const required = new Map<string, number>();
    if (shouldDeductParts) {
      for (const part of next.parts || []) {
        if (!part.productId || !Number.isFinite(part.qty) || part.qty <= 0) continue;
        required.set(part.productId, (required.get(part.productId) || 0) + part.qty);
      }
      for (const [productId, qty] of required) {
        const product = state.products.find(p => p.id === productId);
        if (!product || product.trackImei || product.trackSerial || !Number.isFinite(product.stock) || product.stock < qty) {
          pushAudit('DENIED', 'Repair', 'Cannot deliver ' + current.jobNo + ': invalid or insufficient stock for repair part ' + (product?.name || productId));
          return;
        }
      }
    }
    next.partsDeductedAt = shouldDeductParts ? now : current.partsDeductedAt;
    if ((status === 'ready' || status === 'delivered') && !next.completedAt) next.completedAt = now;
    if (status === 'delivered' && !next.deliveredAt) next.deliveredAt = now;
    if (status !== 'delivered') next.deliveredAt = undefined;

    if (shouldDeductParts && supabaseConfigured) {
      const machine = getMachineIdentity();
      const shop = await ensureCloudShop('Nexfix Shop');
      if (shop.ok && shop.shopId) {
        if (getConnectivity() === 'offline') {
          try {
            await queueRepairDelivery(id, next, machine.id);
          } catch (error) {
            pushAudit('DENIED', 'Repair', error instanceof Error ? error.message : 'Repair delivery could not be queued safely');
            return;
          }
        } else {
          const cloud = await processRepairDeliveryAtomic({ shopId: shop.shopId, repairId: id, deviceId: machine.id, repair: next });
          if (!cloud.ok) {
            pushAudit('DENIED', 'Repair', 'Cloud repair delivery was not committed: ' + (cloud.error || 'unknown error'));
            return;
          }
        }
      } else if (getConnectivity() !== 'offline') {
        pushAudit('DENIED', 'Repair', 'Cloud shop is not available; repair delivery was not committed');
        return;
      }
    }

    setStateWithInventoryLedger('REPAIR_PARTS', s => {
      const products = shouldDeductParts
        ? s.products.map(p => {
            const qty = required.get(p.id) || 0;
            return qty ? { ...p, stock: p.stock - qty } : p;
          })
        : s.products;
      return { ...s, products, repairs: (s.repairs || []).map(j => j.id === id ? next : j) };
    });
    pushAudit('STATUS', 'Repair', 'Job status → ' + status + (shouldDeductParts ? ' · repair parts deducted' : ''));
  }, [pushAudit,user,can,state.repairs,state.products]);

  const deleteRepair = useCallback((id: string) => {
    if(!user || !can('page:repairs') || !can('act:deleteRecords')) {
      pushAudit('DENIED', 'Repair', 'Blocked repair delete without required permissions');
      return;
    }
    const repair=(state.repairs||[]).find(x=>x.id===id);if(!repair||!['cancelled','delivered'].includes(repair.status))return;
    setState(st=>{
      return {...st,repairs:(st.repairs||[]).filter(x=>x.id!==id)};
    });
    pushAudit('DELETE','Repair',`Deleted ${repair.jobNo}`);
  }, [state.repairs,pushAudit,can,user]);

  const saveWarrantyClaim = useCallback((c: WarrantyClaim) => {
    if(!user || !can('page:repairs')) {
      pushAudit('DENIED', 'WarrantyClaim', 'Blocked warranty claim change without repairs access');
      return;
    }const claims=state.warrantyClaims||[],exists=claims.some(x=>x.id===c.id),no=(c.claimNo||'').trim();const valid:ClaimStatus[]=['open','approved','rejected','replaced','repaired','closed'];
    if(!c.productName.trim()||!c.issueDescription.trim()||!valid.includes(c.status))return;
    if(no&&claims.some(x=>x.id!==c.id&&x.claimNo.trim().toLowerCase()===no.toLowerCase()))return;
    setState(st=>{let claim:WarrantyClaim={...c,productName:c.productName.trim(),issueDescription:c.issueDescription.trim(),claimNo:no||c.claimNo,by:c.by||user.name};let counters=st.counters;if(!exists&&(!claim.claimNo||claim.claimNo==='CL-TEMP')){const seq=(st.counters.claim||0)+1;claim={...claim,claimNo:`CL-${String(seq).padStart(4,'0')}`};counters={...st.counters,claim:seq};}claim=claim.status==='closed'?{...claim,closedAt:claim.closedAt||new Date().toISOString()}:{...claim,closedAt:undefined};return {...st,counters,warrantyClaims:exists?(st.warrantyClaims||[]).map(x=>x.id===c.id?claim:x):[claim,...(st.warrantyClaims||[])]};});
    pushAudit(exists?'UPDATE':'CREATE','WarrantyClaim',`${exists?'Updated':'Created'} ${no||'claim'} · ${c.productName}`);
  }, [state.warrantyClaims,pushAudit,user,can]);

  const saveCategory = useCallback((name: string) => {
    if (!user || !can('act:manageStock')) {
      pushAudit('DENIED', 'Category', 'Blocked category create without stock-management permission');
      return;
    }
    const n = name.trim();
    if (!n) return;
    setState(s => {
      const cats = s.settings.categories || [];
      if (cats.some(c => c.toLowerCase() === n.toLowerCase())) return s;
      return { ...s, settings: { ...s.settings, categories: [...cats, n] } };
    });
    scheduleGoogleBackup(() => stateRef.current, 'settings');
  }, [user, can, pushAudit]);

  const removeCategory = useCallback((name: string) => {
    if (!user || !can('act:manageStock')) {
      pushAudit('DENIED', 'Category', 'Blocked category delete without stock-management permission');
      return;
    }
    setState(s => ({
      ...s,
      settings: { ...s.settings, categories: (s.settings.categories || []).filter(c => c !== name) },
    }));
    scheduleGoogleBackup(() => stateRef.current, 'settings');
  }, [user, can, pushAudit]);

  const renameCategory = useCallback((oldName: string, newName: string) => {
    if (!user || !can('act:manageStock')) {
      pushAudit('DENIED', 'Category', 'Blocked category rename without stock-management permission');
      return;
    }
    const n = newName.trim();
    if (!n || !oldName || n === oldName) return;
    setState(s => {
      const cats = s.settings.categories || [];
      if (cats.some(c => c.toLowerCase() === n.toLowerCase() && c !== oldName)) return s;
      return {
        ...s,
        settings: {
          ...s.settings,
          categories: cats.map(c => (c === oldName ? n : c)),
        },
        products: s.products.map(p => (p.category === oldName ? { ...p, category: n } : p)),
      };
    });
    scheduleGoogleBackup(() => stateRef.current, 'settings');
    pushAudit('UPDATE', 'Category', `Renamed "${oldName}" → "${n}"`);
  }, [pushAudit, user, can]);

  const openSession = useCallback((cashierId: string, opening: number) => {
    if (!user || (user.role !== 'admin' && (user.id !== cashierId || !can('page:pos')))) {
      pushAudit('DENIED', 'Session', 'Blocked cash-session open: only the cashier or an admin may set this opening float');
      return;
    }
    const u = state.users.find(x => x.id === cashierId);
    if (!u) return;
    const today = dkey(new Date());
    const selectedBranchId = stateRef.current.settings.branchId || 'local-main';
    const defaultBranchId = getDefaultBranchId(getCloudShopId()) || 'local-main';
    const effectiveBranch = (branchId?: string) => !branchId || branchId === 'local-main' ? defaultBranchId : branchId;
    if (hasMultipleCachedBranches(getCloudShopId()) && selectedBranchId === 'local-main') {
      pushAudit('DENIED', 'Session', 'Blocked day-session open because this shop has multiple branches and no branch is selected. Open Settings first.');
      return;
    }
    const normalizedOpening = Math.round(Math.max(0, Number(opening)) * 100) / 100;
    if (!Number.isFinite(normalizedOpening)) {
      pushAudit('DENIED', 'Session', 'Blocked invalid cash-session opening float');
      return;
    }
    let opened = false;
    setState(s => {
      const existing = s.sessions.find(x => x.cashierId === cashierId && x.date === today && effectiveBranch(x.branchId) === effectiveBranch(selectedBranchId));
      if (existing) {
        if (existing.closed) {
          pushAudit('DENIED', 'Session', 'Blocked reopening a closed cash session');
          return s;
        }
        if (existing.opening === normalizedOpening && existing.openingConfirmed === true) return s;
        const hasSales = s.sales.some(sale => dkey(sale.date) === today && sale.cashierId === cashierId && effectiveBranch(sale.branchId) === effectiveBranch(selectedBranchId));
        const hasCashExpenses = s.expenses.some(exp => dkey(exp.date) === today && (exp.paymentMethod || 'cash') === 'cash' && exp.by === u.name && effectiveBranch(exp.branchId) === effectiveBranch(selectedBranchId));
        if ((hasSales || hasCashExpenses) && existing.opening !== normalizedOpening) {
          pushAudit('DENIED', 'Session', `Blocked opening-float change after activity for ${u.name}`);
          return s;
        }
        opened = true;
        return {
          ...s,
          sessions: s.sessions.map(x => x.id === existing.id ? { ...x, opening: normalizedOpening, openingConfirmed: true } : x),
        };
      }
      const ns: DaySession = {
        id: uid(), branchId: stateRef.current.settings.branchId || 'local-main',
        cashierId,
        cashierName: u.name,
        date: today,
        opening: normalizedOpening,
        openingConfirmed: true,
        closed: false,
      };
      opened = true;
      return { ...s, sessions: [...s.sessions, ns] };
    });
    if (opened) pushAudit('DAY-OPEN', 'Session', `Opening float Rs. ${normalizedOpening.toLocaleString()} · ${u.name}`);
  }, [state.users, pushAudit, user, can]);

  const saveBrand = useCallback((name: string) => {
    if (!user || !can('act:manageStock')) {
      pushAudit('DENIED', 'Brand', 'Blocked brand create without stock-management permission');
      return;
    }
    const n = name.trim();
    if (!n) return;
    setState(s => {
      const brands = s.settings.brands || [];
      if (brands.some(b => b.toLowerCase() === n.toLowerCase())) return s;
      return { ...s, settings: { ...s.settings, brands: [...brands, n] } };
    });
    scheduleGoogleBackup(() => stateRef.current, 'settings');
  }, [user, can, pushAudit]);

  const removeBrand = useCallback((name: string) => {
    if (!user || !can('act:manageStock')) {
      pushAudit('DENIED', 'Brand', 'Blocked brand delete without stock-management permission');
      return;
    }
    setState(s => ({
      ...s,
      settings: { ...s.settings, brands: (s.settings.brands || []).filter(b => b !== name) },
    }));
    scheduleGoogleBackup(() => stateRef.current, 'settings');
  }, [user, can, pushAudit]);

  const runManualBackup = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (!user || !can('act:export')) {
      pushAudit('DENIED', 'Settings', 'Blocked manual backup without export permission');
      return { ok: false, error: 'Backup export permission is required.' };
    }
    if (!(await confirmSensitiveAdmin('full local backup export'))) return { ok: false, error: 'Backup export cancelled.' };
    try {
      const result = await downloadBackup(stateRef.current, 'manual', { download: true, cloud: false });
      const meta = await idbGetMeta();
      setBackupMeta(meta);
      if (!result.local) {
        const error = result.error || 'Backup file could not be downloaded to this PC.';
        pushAudit('DENIED', 'Settings', 'Manual backup download failed');
        return { ok: false, error };
      }
      pushAudit('BACKUP', 'Settings', 'Manual backup downloaded');
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Backup download failed.';
      pushAudit('DENIED', 'Settings', 'Manual backup download failed');
      return { ok: false, error: message };
    }
  }, [state, pushAudit, user, can, confirmSensitiveAdmin]);

  const refreshBackupMeta = useCallback(async () => {
    const meta = await idbGetMeta();
    setBackupMeta(meta);
  }, []);

  const setAutoBackupHours = useCallback(async (hours: number) => {
    if (!user || user.role !== 'admin') {
      pushAudit('DENIED', 'Backup', 'Blocked auto-backup setting change without admin access');
      return;
    }
    const meta = await idbSetMeta({ autoBackupHours: Math.max(0, hours) });
    setBackupMeta(meta);
    const label = hours <= 0 ? 'OFF' : hours < 1 ? `${Math.round(hours * 60)}m` : `${hours}h`;
    pushAudit('SETTINGS', 'Backup', `Auto-backup interval set to ${label}`);
  }, [pushAudit, user]);

  const flushOfflineQueue = useCallback(async () => {
    const { flushed, pending } = await flushSyncQueue();
    setPendingQueueCount(pending);
    if (flushed > 0) pushAudit('SYNC', 'Offline', `Flushed ${flushed} queued write(s)`);
    return flushed;
  }, [pushAudit]);

  const value: StoreCtx = {
    state, user, viewingAs, dark, toggleTheme, can,
    adminPrompt, setAdminPrompt, sensitiveAdminPrompt, resolveSensitiveAdmin, cancelSensitiveAdmin,
    signIn, changePassword, changeManagedPassword, signOut, switchRole, changeAdminPin, verifyAdminPin, confirmSensitiveAdmin, unlockSession,
    createInitialAdmin,
    saveProduct, deleteProduct, saveKitItems, saveQuotations, adjustStock,
    saveCustomer, deleteCustomer, saveSupplier, deleteSupplier, saveSupplierPayment, deleteSupplierPayment, saveCustomerCreditPayment,
    completeSale, completeSaleCloud, refundSale, requestBillReverse, approveBillReverse, rejectBillReverse, holdSale, resumeHold, deleteHold,
    savePurchase, saveGRNDraft, updateGRNDraft, receivePurchase, processGRN, createPurchaseReturn, deletePurchase,
    addExpense, deleteExpense, processExchange,
    saveUser, toggleUserActive, deleteUser,
    setPermission, updateSettings, closeSession, closeDay, logAudit, clearAudit,
    exportData, importData, resetData, refreshPOS,
    connectivity, ready, backupMeta, runManualBackup, refreshBackupMeta, setAutoBackupHours,
    flushOfflineQueue, pendingQueueCount,
    saveUnit, saveUnitsBulk, deleteUnit, findUnitByCode,
    saveRepair, updateRepairStatus, deleteRepair, saveWarrantyClaim,
    saveCategory, removeCategory, renameCategory, openSession, saveBrand, removeBrand,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePOS() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('usePOS must be used inside POSProvider');
  return ctx;
}