import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  POSState, Product, Customer, Supplier, KitItem, Sale, Purchase, Expense, Exchange,
  AppUser, AuditEntry, HeldSale, Settings, Permissions, Role, SaleItem, PaymentMethod, PaymentLeg, DaySession, ReverseRequest,
  InventoryUnit, RepairJob, RepairStatus, PurchaseReturn, PurchaseReturnItem, WarrantyClaim, ClaimStatus, TradeIn,
} from './types';
import { buildSeed, DEFAULT_CATEGORIES, DEFAULT_BRANDS, DEFAULT_ROLE_PERMISSIONS, PERMISSION_KEYS } from './seed';
import { dkey, uid, POINT_VALUE, hashPin, hashPassword, verifyPassword, isHashed, isPasswordHash, SEED_HASH_ADMIN, SEED_HASH_CASHIER } from './utils';
import { hashPasswordAsync, verifyPasswordAsync } from './passwordAsync';
import { idbLoadState, idbSaveState, idbAvailable, idbGetMeta, idbSetMeta, idbListQueue, type BackupMeta } from './db';
import { downloadBackup, startAutoBackup } from './backup';
import {
  getConnectivity, onConnectivityChange, queueWrite, flushSyncQueue, registerServiceWorker,
  type Connectivity,
} from './offline';
import { syncToGoogleDrive } from './driveSync';
import { getMachineIdentity } from './machine';
import { buildPurchaseReceivePlan, canDeletePurchase } from './purchaseReconciliation';
import { appendInventoryTransaction, type InventoryTransaction } from './inventoryLedger';
import { completeSaleAtomic, ensureCloudShop, registerTradeInAtomic, syncNormalizedCatalog } from './cloudSync';


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
  signIn: (email: string, password: string, remember: boolean) => Promise<{ ok: boolean; error?: string }>;
  changePassword: (nextPassword: string) => Promise<{ ok: boolean; error?: string }>;
  signOut: () => void;
  /** cashier → admin requires the admin switch password (pin). admin → cashier is free. */
  switchRole: (role: Role, pin?: string) => Promise<{ ok: boolean; error?: string }>;
  changeAdminPin: (current: string, next: string) => { ok: boolean; error?: string };
  /** verify the admin password without switching role (used for price overrides etc.) */
  verifyAdminPin: (pin: string, reason?: string) => boolean;
  // products
  saveProduct: (p: Product) => void;
  deleteProduct: (id: string) => void;
  saveKitItems: (items: KitItem[]) => void;
  saveQuotations: (quotations: import('./types').Quotation[], quoteCounter?: number) => void;
  adjustStock: (id: string, delta: number, reason: string) => void;
  // customers / suppliers
  saveCustomer: (c: Customer) => void;
  deleteCustomer: (id: string) => void;
  saveSupplier: (s: Supplier) => void;
  deleteSupplier: (id: string) => void;
  saveSupplierPayment: (p: Omit<import('./supplierPayments').SupplierPayment, 'id' | 'date' | 'by'>) => import('./supplierPayments').SupplierPayment | null;
  deleteSupplierPayment: (id: string) => void;
  // sales
  completeSale: (input: NewSaleInput) => Sale | null;
  completeSaleCloud: (input: NewSaleInput) => Promise<Sale | null>;
  refundSale: (saleId: string) => void;
  requestBillReverse: (saleId: string, reason: string) => boolean;
  approveBillReverse: (requestId: string) => boolean;
  rejectBillReverse: (requestId: string, note?: string) => boolean;
  // held
  holdSale: (h: Omit<HeldSale, 'id' | 'heldAt'>) => void;
  resumeHold: (id: string) => HeldSale | undefined;
  deleteHold: (id: string) => void;
  // purchases
  savePurchase: (p: Omit<Purchase, 'id' | 'poNo' | 'date' | 'status'>) => void;
  saveGRNDraft: (p: Omit<Purchase, 'id' | 'poNo' | 'date' | 'status'>) => Purchase | null;
  updateGRNDraft: (id: string, patch: Partial<Omit<Purchase, 'id' | 'poNo' | 'date' | 'status'>>) => boolean;
  receivePurchase: (id: string, processorName?: string) => void;
  processGRN: (id: string, processorName: string) => void;
  createPurchaseReturn: (input: { purchaseId: string; lines: Array<{ itemIdx: number; qty: number }>; reason: string }) => PurchaseReturn | null;
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
  closeSession: (cashierId: string, counted: number, note: string) => void;
  logAudit: (action: string, entity: string, details: string) => void;
  clearAudit: () => void;
  exportData: () => string;
  importData: (json: string) => boolean;
  resetData: () => void;
  /** Reload the current POS data without destroying the authenticated session or route. */
  refreshPOS: () => Promise<void>;
  /** Phase 2: connectivity + backup */
  connectivity: Connectivity;
  ready: boolean; // false while IndexedDB is loading
  backupMeta: BackupMeta;
  runManualBackup: () => Promise<void>;
  setAutoBackupHours: (hours: number) => Promise<void>;
  flushOfflineQueue: () => Promise<number>;
  pendingQueueCount: number;
  // Phase 3 — units & repairs
  saveUnit: (u: InventoryUnit) => void;
  saveUnitsBulk: (units: InventoryUnit[]) => { ok: boolean; added: number; errors: string[] };
  deleteUnit: (id: string) => void;
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
  operation: 'SALE' | 'SALE_REVERSAL' | 'REFUND' | 'PURCHASE_RECEIVE' | 'EXCHANGE' | 'STOCK_ADJUSTMENT' | 'PURCHASE_REVERSAL',
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
    for (const sale of next.sales) if (!ids.has(sale.id)) for (const item of sale.items) if (item.qty > 0) {
      add({ id: 'inv:sale:' + sale.id + ':' + item.productId, type: 'SALE', productId: item.productId, quantity: -item.qty, referenceId: sale.id, referenceNo: sale.billNo, unitIds: item.unitIds });
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
      add({ id: 'inv:purchase-return:' + ret.id + ':' + item.itemIdx, type: 'PURCHASE_REVERSAL', productId: item.productId, quantity: -item.qty, referenceId: ret.id, referenceNo: ret.dnNo, reason: ret.reason });
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


function migrate(s: POSState): POSState {
  // Upgrade plaintext passwords → SHA-256 hashes (one-time migration)
  const users = (s.users || []).map(u => {
    const email = (u.email || '').toLowerCase();
    const defaultPassword = email === 'admin@nexfixsolution.com' ? 'admin123' : email === 'cashier@nexfixsolution.com' ? 'cashier123' : '';
    const isDefaultRecovery = !!defaultPassword && (u.password === (email === 'admin@nexfixsolution.com' ? SEED_HASH_ADMIN : SEED_HASH_CASHIER) || verifyPassword(defaultPassword, u.password || ''));
    return {
      ...u,
      password: isHashed(u.password) ? u.password : hashPassword(u.password || ''),
      mustChangePassword: u.mustChangePassword ?? isDefaultRecovery,
    };
  });
  // Upgrade weak FNV admin PIN hash if it still looks like the old format (8 hex + . + base36)
  let adminPinHash = s.settings?.adminPinHash || hashPin('admin123');
  if (adminPinHash.includes('.') || adminPinHash.length < 32) {
    adminPinHash = hashPin('admin123');
  }
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
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch { /* quota */ }
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
  const [ready, setReady] = useState(!idbAvailable()); // true immediately if no IDB
  const [connectivity, setConnectivity] = useState<Connectivity>(() => getConnectivity());
  const [backupMeta, setBackupMeta] = useState<BackupMeta>({ autoBackupHours: 6, backupCount: 0 });
  const [pendingQueueCount, setPendingQueueCount] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Blocks accidental signOut for a few seconds after successful login (boot/effect race). */
  const loginAtRef = useRef(0);

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

  // Connectivity listeners + auto-flush queue when back online
  useEffect(() => {
    const unsub = onConnectivityChange(async (status) => {
      setConnectivity(status);
      if (status === 'online') {
        const { flushed, pending } = await flushSyncQueue();
        // Keep the durable queue count authoritative. Conflicts/errors intentionally leave queued writes visible.
        setPendingQueueCount(pending);
        // Backup/export on reconnect requires the export permission.
        // Queue flushing remains available independently of backup access.
        if (user && can('act:export')) {
          try {
            await downloadBackup(stateRef.current, 'auto', {
              download: flushed > 0,
              cloud: true,
            });
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
    // Automatic backups are an export operation: only an authenticated user
    // with the export permission may start the scheduler. This also tears the
    // scheduler down when an admin switches to a lower-privilege account.
    if (!ready || !user || !can('act:export')) return;
    const stop = startAutoBackup(
      () => stateRef.current,
      async () => {
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

  const setStateWithInventoryLedger = useCallback((operation: 'SALE' | 'SALE_REVERSAL' | 'REFUND' | 'PURCHASE_RECEIVE' | 'EXCHANGE' | 'STOCK_ADJUSTMENT' | 'PURCHASE_REVERSAL', updater: (prev: POSState) => POSState) => {
    setState(prev => applyInventoryLedger(prev, updater(prev), operation, user?.email));
  }, [user?.email]);


  const verifyAdminPin = useCallback((pin: string, reason?: string): boolean => {
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

  const toggleTheme = useCallback(() => setDark(d => !d), []);

  const pushAudit = useCallback((action: string, entity: string, details: string, who?: string) => {
    setState(s => ({
      ...s,
      audit: [
        { id: uid(), time: new Date().toISOString(), user: who || user?.email || 'system', action, entity, details },
        ...s.audit,
      ].slice(0, 500),
    }));
  }, [user?.email]);


  const signIn = useCallback(async (email: string, password: string, remember: boolean) => {
    const mail = email.trim().toLowerCase();
    if (!mail || !password) return { ok: false, error: 'Enter your email and password' };

    // Built-in recovery credentials — always work even if IDB/local state is empty or corrupted.
    // These match the seeded default accounts shown on the login screen.
    const DEFAULT_ACCOUNTS: Record<string, { id: string; name: string; role: Role; plain: string; hash: string }> = {
      'admin@nexfixsolution.com': {
        id: 'u-admin',
        name: 'Shop Administrator',
        role: 'admin',
        plain: 'admin123',
        hash: SEED_HASH_ADMIN,
      },
      'cashier@nexfixsolution.com': {
        id: 'u-nimal',
        name: 'Cashier',
        role: 'cashier',
        plain: 'cashier123',
        hash: SEED_HASH_CASHIER,
      },
    };

    let users = [...(stateRef.current.users || [])];
    let u = users.find(x => (x.email || '').toLowerCase() === mail);
    const def = DEFAULT_ACCOUNTS[mail];

    // Path A: known default email + matching default password → force-ensure user & login
    if (def && password === def.plain && (!u || u.mustChangePassword === true || u.password === def.hash || verifyPassword(def.plain, u.password || ''))) {
      if (!u) {
        u = {
          id: def.id,
          name: def.name,
          email: mail,
          password: def.hash,
          role: def.role,
          active: true,
          createdAt: new Date().toISOString(),
          mustChangePassword: true,
        };
        users = [...users.filter(x => (x.email || '').toLowerCase() !== mail && x.id !== def.id), u];
      } else {
        u = {
          ...u,
          email: mail,
          password: def.hash,
          role: def.role,
          active: true,
          name: u.name || def.name,
        };
        users = users.map(x => (x.id === u!.id || (x.email || '').toLowerCase() === mail ? u! : x));
      }
      // Keep stateRef in sync so user useMemo resolves immediately after setSession
      stateRef.current = { ...stateRef.current, users };
      setState(s => ({
        ...s,
        users,
        audit: [{
          id: uid(),
          time: new Date().toISOString(),
          user: mail,
          action: 'LOGIN',
          entity: 'Auth',
          details: `${u!.name} signed in (default recovery)`,
        }, ...(s.audit || [])].slice(0, 500),
      }));
    } else {
      // Path B: normal account lookup + password verify
      if (!u) return { ok: false, error: 'No account found for this email' };

      let passwordOk = false;
      if (isHashed(u.password)) {
        passwordOk = await verifyPasswordAsync(password, u.password);
        // sync fallback if async path fails (older browsers / subtle issues)
        if (!passwordOk) {
          try { passwordOk = verifyPassword(password, u.password); } catch { /* ignore */ }
        }
      } else {
        passwordOk = u.password === password;
      }
      if (!passwordOk) return { ok: false, error: 'Incorrect password' };
      if (!u.active) return { ok: false, error: 'This account has been deactivated' };

      const needsUpgrade = !isPasswordHash(u.password);
      const upgradedPassword = needsUpgrade ? await hashPasswordAsync(password) : u.password;
      if (needsUpgrade) {
        users = users.map(x => x.id === u!.id ? { ...x, password: upgradedPassword } : x);
        u = { ...u, password: upgradedPassword };
        stateRef.current = { ...stateRef.current, users };
      }
      setState(s => ({
        ...s,
        users: needsUpgrade ? users : s.users,
        audit: [{
          id: uid(),
          time: new Date().toISOString(),
          user: u!.email,
          action: 'LOGIN',
          entity: 'Auth',
          details: `${u!.name} signed in${needsUpgrade ? ' · password upgraded to PBKDF2' : ''}`,
        }, ...(s.audit || [])].slice(0, 500),
      }));
    }

    const sess = { userId: u!.id, remember };
    loginAtRef.current = Date.now();
    setSession(sess);
    try {
      if (remember) {
        localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
        sessionStorage.removeItem(SESSION_KEY);
      } else {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess));
        localStorage.removeItem(SESSION_KEY);
      }
      localStorage.setItem('nexfix_session_started_v1', String(Date.now()));
    } catch { /* ignore */ }

    return { ok: true };
  }, []);

  const changePassword = useCallback(async (nextPassword: string): Promise<{ ok: boolean; error?: string }> => {
    if (!user) return { ok: false, error: 'You must be signed in' };
    const next = nextPassword.trim();
    if (next.length < 8) return { ok: false, error: 'New password must be at least 8 characters' };
    if (next === 'admin123' || next === 'cashier123') return { ok: false, error: 'Choose a password different from the default recovery password' };
    const hashed = await hashPasswordAsync(next);
    setState(s => ({
      ...s,
      users: s.users.map(u => u.id === user.id ? { ...u, password: hashed, mustChangePassword: false } : u),
    }));
    stateRef.current = { ...stateRef.current, users: stateRef.current.users.map(u => u.id === user.id ? { ...u, password: hashed, mustChangePassword: false } : u) };
    pushAudit('PASSWORD-CHANGE', 'Auth', 'Mandatory first-login password changed');
    return { ok: true };
  }, [user, pushAudit]);

  const signOut = useCallback(() => {
    // Ignore spurious signOut calls in the first 8s after login (boot/effect race)
    if (loginAtRef.current && Date.now() - loginAtRef.current < 8000) {
      return;
    }
    if (user) pushAudit('LOGOUT', 'Auth', `${user.name} signed out`);
    setSession(null);
    try { localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY); sessionStorage.removeItem('nexfix_prev_user'); sessionStorage.removeItem('nexfix_role_switch'); } catch { /* ignore */ }
  }, [user, pushAudit]);

  const switchRole = useCallback(async (role: Role, pin?: string): Promise<{ ok: boolean; error?: string }> => {
    // Prefer restoring the previous user when switching back to cashier
    let target = state.users.find(u => u.role === role && u.active);
    if (role === 'cashier' && user?.role === 'admin') {
      try {
        const prevId = sessionStorage.getItem('nexfix_prev_user');
        if (prevId) {
          const prevUser = state.users.find(u => u.id === prevId && u.role === 'cashier' && u.active);
          if (prevUser) target = prevUser;
        }
      } catch { /* ignore */ }
    }
    if (!target) return { ok: false, error: `No active ${role} account exists` };

    // cashier → admin accepts either the dedicated unlock PIN or the real admin
    // account's current login password. Both are verified against hashes.
    if (role === 'admin' && user?.role === 'cashier') {
      const pinOk = verifyPassword(pin || '', state.settings.adminPinHash);
      const adminUser = state.users.find(u => u.role === 'admin' && u.active);
      const passwordOk = adminUser && isHashed(adminUser.password)
        ? await verifyPasswordAsync(pin || '', adminUser.password)
        : !!adminUser && verifyPassword(pin || '', adminUser.password || '');
      if (!pinOk && !passwordOk) {
        setState(s => ({ ...s, audit: [{
          id: uid(), time: new Date().toISOString(), user: user?.email || 'unknown',
          action: 'DENIED', entity: 'Auth',
          details: `Failed ADMIN unlock attempt by ${user?.name || 'unknown'}`,
        }, ...s.audit].slice(0, 500) }));
        return { ok: false, error: 'Incorrect admin unlock PIN or admin login password' };
      }
      try { sessionStorage.setItem('nexfix_prev_user', user.id); } catch { /* ignore */ }
    }

    const prev = session ? loadSession() : null;
    const sess = { userId: target.id, remember: prev?.remember ?? true };
    try {
      if (role === 'admin') sessionStorage.setItem('nexfix_role_switch', '1');
      else sessionStorage.removeItem('nexfix_role_switch');
    } catch { /* ignore */ }
    setSession(sess);
    try {
      if (sess.remember) { localStorage.setItem(SESSION_KEY, JSON.stringify(sess)); sessionStorage.removeItem(SESSION_KEY); }
      else { sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess)); localStorage.removeItem(SESSION_KEY); }
    } catch { /* ignore */ }
    setState(s => ({
      ...s,
      audit: [{
        id: uid(), time: new Date().toISOString(), user: target!.email, action: 'SWITCH', entity: 'Auth',
        details: `Switched view to ${role.toUpperCase()} (${target!.name})${role === 'admin' && user?.role === 'cashier' ? ' · password verified' : ''}`,
      }, ...s.audit].slice(0, 500),
    }));
    return { ok: true };
  }, [state.users, state.settings.adminPinHash, session, user]);

  const changeAdminPin = useCallback((current: string, next: string): { ok: boolean; error?: string } => {
    if (user?.role !== 'admin') return { ok: false, error: 'Only admins can change this password' };
    if (!verifyPassword(current, state.settings.adminPinHash)) return { ok: false, error: 'Current password is incorrect' };
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

  const saveProduct = useCallback((p: Product) => {
    if (!user || !can('act:manageStock')) {
      pushAudit('DENIED', 'Product', `Blocked product save for ${p.name || p.id}`);
      return;
    }
    const name = String(p.name || '').trim();
    const sku = String(p.sku || '').trim();
    const barcode = String(p.barcode || '').trim();
    const values = [p.cost, p.price, p.stock, p.reorderLevel, ...(p.warrantyMonths === undefined ? [] : [p.warrantyMonths])];
    if (!name || values.some(v => !Number.isFinite(v) || v < 0) || !Number.isInteger(p.stock) || !Number.isInteger(p.reorderLevel) || (p.warrantyMonths !== undefined && !Number.isInteger(p.warrantyMonths))) {
      pushAudit('DENIED', 'Product', `Blocked invalid product input for ${p.id}`);
      return;
    }
    const normalized: Product = { ...p, name, sku, barcode, cost: Math.round(p.cost * 100) / 100, price: Math.round(p.price * 100) / 100, stock: Math.round(p.stock), reorderLevel: Math.round(p.reorderLevel), ...(p.warrantyMonths === undefined ? {} : { warrantyMonths: Math.round(p.warrantyMonths) }) };
    const exists = state.products.some(x => x.id === normalized.id);
    let duplicate = false;
    setState(s => {
      const duplicateSku = s.products.some(x => x.id !== normalized.id && x.sku.trim().toLowerCase() === normalized.sku.toLowerCase());
      const duplicateBarcode = s.products.some(x => x.id !== normalized.id && x.barcode.trim() === normalized.barcode);
      if (duplicateSku || duplicateBarcode) { duplicate = true; return s; }
      const updatedProducts = s.products.some(x => x.id === normalized.id) ? s.products.map(x => x.id === normalized.id ? normalized : x) : [normalized, ...s.products];
      syncToGoogleDrive('Products', updatedProducts);
      return { ...s, products: updatedProducts };
    });
    if (duplicate) pushAudit('DENIED', 'Product', `Blocked duplicate SKU/barcode for ${normalized.name}`);
    else pushAudit(exists ? 'UPDATE' : 'CREATE', 'Product', `${exists ? 'Updated' : 'Added'} product ${normalized.name}`);
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

  const adjustStock = useCallback((id: string, delta: number, reason: string) => {
    if (!user || !can('act:manageStock')) { pushAudit('DENIED', 'Product', `Blocked stock adjustment for ${id}`); return; }
    const amount = Number(delta);
    const note = String(reason || '').trim();
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount === 0 || !note) { pushAudit('DENIED', 'Product', `Blocked invalid stock adjustment for ${id}`); return; }
    const p = state.products.find(x => x.id === id);
    if (!p || !Number.isFinite(p.stock) || p.stock + amount < 0) { pushAudit('DENIED', 'Product', `Blocked stock adjustment below zero for ${id}`); return; }
    setStateWithInventoryLedger('STOCK_ADJUSTMENT', s => {
      const current = s.products.find(x => x.id === id);
      if (!current || !Number.isFinite(current.stock) || current.stock + amount < 0) return s;
      const updatedProducts = s.products.map(x => x.id === id ? { ...x, stock: x.stock + amount } : x);
      syncToGoogleDrive('Products', updatedProducts);
      return { ...s, products: updatedProducts };
    });
    pushAudit('STOCK', 'Product', `Stock ${amount >= 0 ? '+' : ''}${amount} for ${p.name} — ${note}`);
  }, [can, pushAudit, state.products, user]);

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
    const normalizedPhone = phone.replace(/[\s()-]/g, '');
    const duplicatePhone = s.customers.some(x => x.id !== c.id && x.phone.replace(/[\s()-]/g, '') === normalizedPhone);
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
    if (!user || !can('page:suppliers')) {
      pushAudit('DENIED', 'SupplierPayment', 'Blocked supplier payment without supplier access');
      return null;
    }
    if (!state.suppliers.some(s => s.id === p.supplierId)) return null;
    if (!Number.isFinite(p.amount) || p.amount <= 0) return null;
    const purchaseTotal = state.purchases.filter(x => x.supplierId === p.supplierId && x.status === 'received').reduce((sum, x) => sum + Math.max(0, x.total), 0);
    const returnTotal = (state.purchaseReturns || []).filter(x => x.supplierId === p.supplierId).reduce((sum, x) => sum + Math.max(0, x.total), 0);
    const paidTotal = (state.supplierPayments || []).filter(x => x.supplierId === p.supplierId).reduce((sum, x) => sum + Math.max(0, x.amount), 0);
    const outstanding = Math.max(0, Math.round((purchaseTotal - returnTotal - paidTotal) * 100) / 100);
    if (p.amount > outstanding) return null;
    const payment: import('./supplierPayments').SupplierPayment = { ...p, amount: Math.round(p.amount * 100) / 100, id: uid(), date: new Date().toISOString(), by: user.name };
    setState(s => ({ ...s, supplierPayments: [payment, ...(s.supplierPayments || [])] }));
    pushAudit('CREATE', 'SupplierPayment', `Payment of Rs. ${payment.amount.toLocaleString()} to supplier ${state.suppliers.find(s => s.id === p.supplierId)?.name || p.supplierId}`);
    return payment;
  }, [state.suppliers, state.purchases, state.purchaseReturns, state.supplierPayments, user, pushAudit, can]);

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
    if (!user || input.lines.length === 0) return null;
    const s = state;
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
      if (!kitLines.length && requestedQty > p.stock) return null;
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
      if (kitQty + kitDirectOverlap > component.stock) return null;
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
    const legs = (input.payments || []).filter(l => l.amount > 0);
    const isSplit = legs.length > 1;
    const isCredit = legs.some(l => l.method === 'credit') || (!isSplit && input.payment === 'credit');
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
      id: input._saleId || uid(), billNo, date: new Date().toISOString(),
      cashierId: byUser.id, cashierName: byUser.name,
      machineId: machine.id, machineName: machine.name,
      note: input.note?.trim() || undefined,
      customerId: cust?.id, customerName: cust?.name || 'Walk-in customer',
      items, subtotal, discount, tax, shipping: shipping || undefined, total,
      payment: isSplit ? legs[0].method : input.payment,
      payments: isSplit ? legs : undefined,
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
      id: tradeInUnitId, productId: tradeIn.productId, imei: tradeIn.imei?.trim() || undefined, serial: tradeIn.serial?.trim() || undefined,
      status: 'in_stock' as const, cost: tradeInValue, note: 'Trade-in', createdAt: sale.date,
    } : undefined;
    const productsAfterTradeIn = tradeInUnit
      ? updatedProducts.map(p => p.id === tradeInUnit.productId ? { ...p, stock: p.stock + 1 } : p)
      : updatedProducts;

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
          ? { ...u, status: 'sold' as const, saleId: sale.id, saleBillNo: billNo, soldAt: sale.date }
          : u,
        ),
      ],
      sales: [sale, ...prev.sales],
      counters: { ...prev.counters, bill: prev.counters.bill + 1 },
    }));

    // Auto-Sync to Google Sheet (Sales & Products Inventory)
    syncToGoogleDrive('SalesHistory', [sale]);
    syncToGoogleDrive('Products', updatedProducts);

    pushAudit(
      'SALE', 'Sale',
      `Bill ${billNo} · ${input.lines.length} item(s) · Rs. ${total.toLocaleString()}${tradeInValue ? ` · trade-in Rs. ${tradeInValue.toLocaleString()}` : ''}${soldUnitIds.length ? ` · ${soldUnitIds.length} unit(s)` : ''}${isSplit ? ` · split (${legs.map(l => l.method).join('+')})` : ''}${input.note?.trim() ? ' · note: ' + input.note.trim().slice(0, 40) : ''}${items.some(i => i.priceOverridden) ? ' · price override' : ''}`,
    );
    return sale;
  }, [user, state, pushAudit]);

  const completeSaleCloud = useCallback(async (input: NewSaleInput): Promise<Sale | null> => {
    if (!user || input.lines.length === 0) return null;
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
    const tradeInUnitId = tradeIn?.addToInventory ? uid() : undefined;
    if (user.role === 'admin' || user.role === 'manager') {
      const catalog = await syncNormalizedCatalog(state, shop.shopId);
      if (!catalog.ok) return null;
    }
    const pendingKey = 'nexfix_pending_cloud_sale_v2';
    const fingerprint = JSON.stringify({
      lines: saleLines.map(l => ({ productId: l.productId, qty: l.qty, discount: l.discount || 0, price: l.price, unitIds: l.unitIds || [] })),
      customerId: input.customerId || null, discount: (input.discount || 0) + tradeInValue, taxPct: input.taxPct || 0,
      shipping: input.shipping || 0, pointsRedeemed: input.pointsRedeemed || 0,
      payment: input.payment, amountPaid: input.amountPaid,
      payments: (input.payments || []).map(p => ({ method: p.method, amount: p.amount })),
      note: input.note || '', salesmanId: input.salesmanId || user.id,
    });
    let saleId = input._saleId || '';
    try {
      const raw = localStorage.getItem(pendingKey);
      if (!saleId && raw) {
        const pending = JSON.parse(raw) as { saleId?: string; fingerprint?: string };
        if (pending.saleId && pending.fingerprint === fingerprint) saleId = pending.saleId;
      }
    } catch { /* ignore malformed pending state */ }
    if (!saleId) saleId = uid();
    try { localStorage.setItem(pendingKey, JSON.stringify({ saleId, fingerprint })); } catch { /* ignore */ }

    const payments = (input.payments && input.payments.length)
      ? input.payments.filter(p => p.amount > 0).map(p => ({ method: p.method, amount: p.amount }))
      : [{ method: input.payment, amount: input.amountPaid }];
    const cloud = await completeSaleAtomic({
      shopId: shop.shopId, saleId, customerId: input.customerId, shipping: input.shipping,
      discount: (input.discount || 0) + tradeInValue, taxPct: input.taxPct, pointsRedeemed: input.pointsRedeemed,
      note: input.note, salesmanId: input.salesmanId || user.id,
      lines: saleLines.map(l => ({ product_id: l.productId, qty: l.qty, discount: l.discount, price: l.price, unit_ids: l.unitIds })),
      payments,
    });
    if (!cloud.ok || !cloud.saleId || !cloud.billNo || cloud.saleId !== saleId || !cloud.committed?.sale) return null;
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
      if (!tradeInCloud.ok) return null;
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
      id: String(row.id), billNo: String(row.bill_no ?? cloud.billNo), date: String(row.created_at ?? new Date().toISOString()),
      cashierId: String(row.cashier_id ?? user.id), cashierName: String(row.cashier_name ?? user.name),
      machineId: getMachineIdentity().id, machineName: getMachineIdentity().name,
      customerId: row.customer_id ? String(row.customer_id) : undefined,
      customerName: String(row.customer_name ?? committed.customer?.name ?? 'Walk-in customer'),
      items: committedItems, subtotal: n(row.subtotal), discount: Math.max(0, n(row.discount) - tradeInValue), tax: n(row.tax),
      shipping: n(row.shipping) || undefined, total: n(row.total),
      payment: paymentRows.length > 1 ? paymentRows[0].method : (paymentRows[0]?.method || input.payment),
      payments: paymentRows.length > 1 ? paymentRows : undefined,
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
    // The pending marker is cleared only after durable local persistence.
    syncToGoogleDrive('SalesHistory', [sale]);
    syncToGoogleDrive('Products', committed.products);
    pushAudit('SALE', 'Sale', `Cloud bill ${sale.billNo} · authoritative reconciliation · ${committedItems.length} item(s)`);
    return sale;
  }, [user, state, pushAudit, completeSale]);

  const refundSale = useCallback((saleId: string) => {
    if (!user || !can('act:refund')) {
      pushAudit('DENIED', 'Sale', 'Blocked refund without refund permission');
      return;
    }
    const sale = state.sales.find(x => x.id === saleId);
    if (!sale || sale.status !== 'completed') return;

    const priorReturnedByLine = new Map<number, number>();
    for (const ex of state.exchanges.filter(x => x.billNo === sale.billNo)) {
      for (const item of ex.items) if (item.itemIdx !== undefined) {
        priorReturnedByLine.set(item.itemIdx, (priorReturnedByLine.get(item.itemIdx) || 0) + item.qty);
      }
    }
    const remainingItems = sale.items.map((it, idx) => ({ it, idx, qty: Math.max(0, it.qty - (priorReturnedByLine.get(idx) || 0)) })).filter(x => x.qty > 0);
    if (remainingItems.length === 0) return;

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
      const creditDue = currentSale.amountPaid < currentSale.total ? Math.max(0, currentSale.total - currentSale.amountPaid) : 0;
      const creditReduction = Math.min(creditDue, refundValue);
      const returnedRatio = currentSale.total > 0 ? Math.min(1, refundValue / currentSale.total) : 1;
      const pointsEarnedToReverse = Math.min(currentSale.pointsEarned || 0, Math.round((currentSale.pointsEarned || 0) * returnedRatio));
      const pointsToRestore = Math.min(currentSale.pointsRedeemed || 0, Math.round((currentSale.pointsRedeemed || 0) * returnedRatio));
      return {
        ...s,
        sales: s.sales.map(x => x.id === saleId ? { ...x, status: allReturned ? 'refunded' : 'completed' } : x),
        products: s.products.map(p => {
          const qty = qtyByProduct.get(p.id) || 0;
          const tradeInQty = tradeInReturn && p.id === currentSale.tradeIn!.productId ? -1 : 0;
          return qty || tradeInQty ? { ...p, stock: Math.max(0, p.stock + qty + tradeInQty) } : p;
        }),
        customers: s.customers.map(c => c.id === currentSale.customerId ? { ...c, creditBalance: Math.max(0, c.creditBalance - creditReduction), loyaltyPoints: Math.max(0, c.loyaltyPoints - pointsEarnedToReverse + pointsToRestore) } : c),
        units: (s.units || []).map(u => returnedUnitIds.includes(u.id)
          ? { ...u, status: 'returned' as const, saleId: undefined, saleBillNo: undefined, soldAt: undefined }
          : (tradeInReturn && u.id === currentSale.tradeIn!.unitId ? { ...u, status: 'returned' as const } : u)),
      };
    });
    pushAudit('REFUND', 'Sale', `Refunded bill ${sale.billNo} · Rs. ${refundValue.toLocaleString()}${sale.items.flatMap(it => it.unitIds || []).length ? ` · tracked unit(s) returned` : ''}`);
  }, [state.sales, state.exchanges, state.units, pushAudit, user, can]);

  /* ---------------- admin-approved bill reversal ---------------- */
  const requestBillReverse = useCallback((saleId: string, reason: string): boolean => {
    if (!user || !can('page:sales')) {
      pushAudit('DENIED', 'Sale', 'Blocked bill-reversal request without sales-history access');
      return false;
    }
    const sale = state.sales.find(x => x.id === saleId);
    const note = reason.trim();
    if (!sale || sale.status !== 'completed' || !note) return false;
    if (state.reverseRequests?.some(r => r.saleId === saleId && r.status === 'pending')) return false;
    const req: ReverseRequest = { id: uid(), saleId, billNo: sale.billNo, reason: note, requestedBy: user.name, requestedAt: new Date().toISOString(), status: 'pending' };
    setState(s => ({ ...s, reverseRequests: [req, ...(s.reverseRequests || [])] }));
    pushAudit('REVERSE-REQUEST', 'Sale', `Reverse requested for ${sale.billNo} · ${note}`);
    return true;
  }, [state.sales, state.reverseRequests, user, pushAudit, can]);

  const approveBillReverse = useCallback((requestId: string): boolean => {
    if (user?.role !== 'admin') return false;
    const req = (state.reverseRequests || []).find(r => r.id === requestId);
    const sale = req ? state.sales.find(x => x.id === req.saleId) : undefined;
    if (!req || req.status !== 'pending' || !sale || sale.status !== 'completed') return false;
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
    pushAudit('REVERSE-APPROVED', 'Sale', `Bill ${sale.billNo} reversed and stock restored · requested by ${req.requestedBy}`);
    return true;
  }, [state.reverseRequests, state.sales, user, pushAudit]);

  const rejectBillReverse = useCallback((requestId: string, note?: string): boolean => {
    if (user?.role !== 'admin') return false;
    const req = (state.reverseRequests || []).find(r => r.id === requestId);
    if (!req || req.status !== 'pending') return false;
    setState(s => ({ ...s, reverseRequests: (s.reverseRequests || []).map(r => r.id === requestId ? { ...r, status: 'rejected' as const, reviewedBy: user.name, reviewedAt: new Date().toISOString(), reviewNote: note?.trim() || undefined } : r) }));
    pushAudit('REVERSE-REJECTED', 'Sale', `Reverse request for ${req.billNo} rejected · ${note?.trim() || 'No note'}`);
    return true;
  }, [state.reverseRequests, user, pushAudit]);
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
    if (!user || !can('page:purchases')) {
      pushAudit('DENIED', 'Purchase', 'Blocked purchase order creation without purchase access');
      return;
    }
    setState(s => {
      const seq = s.counters.po + 1;
      const po: Purchase = {
        ...p, id: uid(), poNo: `PO-${String(seq).padStart(4, '0')}`,
        date: new Date().toISOString(), status: 'pending',
      };
      return { ...s, purchases: [po, ...s.purchases], counters: { ...s.counters, po: seq } };
    });
    pushAudit('CREATE', 'Purchase', `Created PO for ${p.supplierName} · Rs. ${p.total.toLocaleString()}`);
  }, [pushAudit, user, can]);

  const receivePurchase = useCallback((id: string, processorName?: string) => {
    if (!user || !can('page:purchases')) {
      pushAudit('DENIED', 'Purchase', 'Blocked purchase receive without purchase access');
      return;
    }
    const po = state.purchases.find(x => x.id === id);
    if (!po || po.status !== 'pending') return;
    const plan = buildPurchaseReceivePlan(po, state.products);
    if (!plan) return;
    setStateWithInventoryLedger('PURCHASE_RECEIVE', s => {
      const currentPo = s.purchases.find(x => x.id === id);
      if (!currentPo || currentPo.status !== 'pending') return s;
      const currentPlan = buildPurchaseReceivePlan(currentPo, s.products);
      if (!currentPlan) return s;
      const now = new Date().toISOString();
      const newUnits: InventoryUnit[] = [];
      const products = s.products.map(p => {
        const delta = currentPlan.productStockDelta.get(p.id);
        if (delta === undefined) return p;
        const cost = currentPlan.productCost.get(p.id);
        const trackedQty = currentPlan.trackedUnitCount.get(p.id) || 0;
        if (trackedQty > 0 && (p.trackImei || p.trackSerial)) {
          for (let i = 0; i < trackedQty; i++) {
            newUnits.push({
              id: uid(),
              productId: p.id,
              imei: p.trackImei ? '' : undefined,
              serial: p.trackSerial && !p.trackImei ? '' : undefined,
              status: 'in_stock',
              purchaseId: currentPo.id,
              cost,
              expiryDate: currentPo.items.find(item => item.productId === p.id)?.expiryDate,
              note: `From ${currentPo.poNo} — fill IMEI/Serial in Units`,
              createdAt: now,
            } as InventoryUnit);
          }
        }
        const purchaseItem = currentPo.items.find(item => item.productId === p.id);
        const sellingPrice = purchaseItem?.updateSellingPrice ? purchaseItem.sellingPrice : undefined;
        if (sellingPrice !== undefined && (!Number.isFinite(sellingPrice) || sellingPrice < 0)) return p;
        return { ...p, stock: p.stock + delta, ...(cost !== undefined ? { cost } : {}), ...(sellingPrice !== undefined ? { price: Math.round(sellingPrice * 100) / 100 } : {}) };
      });
      return {
        ...s,
        purchases: s.purchases.map(x => x.id === id ? { ...x, status: 'received' as const, ...(processorName ? { processedAt: now, processedBy: processorName } : {}) } : x),
        products,
        units: [...newUnits, ...(s.units || [])],
      };
    });
    pushAudit('RECEIVE', 'Purchase', `Received ${po.poNo} from ${po.supplierName} · auto units for IMEI/Serial items`);
  }, [state.purchases, state.products, pushAudit, user, can]);

  const saveGRNDraft = useCallback((p: Omit<Purchase, 'id' | 'poNo' | 'date' | 'status'>) => {
    if (!user || !can('page:purchases')) {
      pushAudit('DENIED', 'GRN', 'Blocked GRN draft creation without purchase access');
      return null;
    }
    if (!p.supplierId || !p.items.length) return null;
    const validation: Purchase = { ...p, id: 'validation', poNo: 'GRN-VALIDATION', date: new Date().toISOString(), status: 'pending' };
    if (!buildPurchaseReceivePlan(validation, state.products)) return null;
    const created: Purchase = { ...p, id: uid(), poNo: `GRN-${String((state.counters.grn ?? 0) + 1).padStart(4, '0')}`, date: new Date().toISOString(), status: 'pending', total: p.items.reduce((sum, item) => sum + item.qty * item.cost, 0) };
    setState(s => ({ ...s, purchases: [created, ...s.purchases], counters: { ...s.counters, grn: (s.counters.grn ?? 0) + 1 } }));
    pushAudit('CREATE', 'GRN', `Draft ${created.poNo} for ${created.supplierName} · Rs. ${created.total.toLocaleString()}`);
    return created;
  }, [state.products, state.counters.grn, user, pushAudit, can]);

  const updateGRNDraft = useCallback((id: string, patch: Partial<Omit<Purchase, 'id' | 'poNo' | 'date' | 'status'>>) => {
    if (!user || !can('page:purchases')) {
      pushAudit('DENIED', 'GRN', 'Blocked GRN draft update without purchase access');
      return false;
    }
    const current = state.purchases.find(x => x.id === id);
    if (!current || current.status !== 'pending') return false;
    const next: Purchase = { ...current, ...patch, total: (patch.items || current.items).reduce((sum, item) => sum + item.qty * item.cost, 0) };
    if (!buildPurchaseReceivePlan(next, state.products)) return false;
    setState(s => ({ ...s, purchases: s.purchases.map(x => x.id === id && x.status === 'pending' ? next : x) }));
    pushAudit('EDIT', 'GRN', `Updated draft ${current.poNo}`);
    return true;
  }, [state.purchases, state.products, pushAudit, user, can]);

  const processGRN = useCallback((id: string, processorName: string) => receivePurchase(id, processorName), [receivePurchase]);

  const createPurchaseReturn = useCallback((input: { purchaseId: string; lines: Array<{ itemIdx: number; qty: number }>; reason: string }): PurchaseReturn | null => {
  if (!user || !can('page:purchases')) {
    pushAudit('DENIED', 'Purchase', 'Blocked purchase return without purchase access');
    return null;
  }
  const purchase = state.purchases.find(x => x.id === input.purchaseId);
  if (!purchase || purchase.status !== 'received' || !user || !input.reason.trim()) return null;
  const existing = state.purchaseReturns || [];
  const returnedByItem = new Map<number, number>();
  for (const ret of existing.filter(x => x.purchaseId === purchase.id)) for (const item of ret.items) returnedByItem.set(item.itemIdx, (returnedByItem.get(item.itemIdx) || 0) + item.qty);
  const requested = new Map<number, number>();
  for (const line of input.lines) { if (!Number.isInteger(line.itemIdx) || line.itemIdx < 0 || line.itemIdx >= purchase.items.length) continue; if (!Number.isFinite(line.qty) || line.qty <= 0) continue; requested.set(line.itemIdx, (requested.get(line.itemIdx) || 0) + Math.floor(line.qty)); }
  if (requested.size === 0) return null;
  const items: PurchaseReturnItem[] = [];
  const returnedUnitIds = new Set<string>();
  for (const [itemIdx, qtyRequested] of requested) {
    const source = purchase.items[itemIdx];
    const already = returnedByItem.get(itemIdx) || 0;
    const remaining = Math.max(0, source.qty - already);
    const product = state.products.find(p => p.id === source.productId);
    const stock = product?.stock || 0;
    const tracked = !!(product?.trackImei || product?.trackSerial);
    const availableUnits = tracked ? (state.units || []).filter(u => u.productId === source.productId && u.purchaseId === purchase.id && u.status === 'in_stock') : [];
    const qty = Math.min(qtyRequested, remaining, stock, tracked ? availableUnits.length : Number.MAX_SAFE_INTEGER);
    if (qty <= 0) continue;
    if (tracked) for (const unit of availableUnits.slice(0, qty)) returnedUnitIds.add(unit.id);
    items.push({ itemIdx, productId: source.productId, name: source.name, qty, cost: source.cost, total: qty * source.cost });
  }
  if (!items.length) return null;
  const seq = (state.counters.dn || 0) + 1;
  const ret: PurchaseReturn = { id: uid(), dnNo: 'DN-' + String(seq).padStart(4, '0'), purchaseId: purchase.id, poNo: purchase.poNo, supplierId: purchase.supplierId, supplierName: purchase.supplierName, date: new Date().toISOString(), items, total: items.reduce((a, x) => a + x.total, 0), reason: input.reason.trim(), by: user.email };
  setStateWithInventoryLedger('PURCHASE_REVERSAL', prev => ({
    ...prev,
    products: prev.products.map(p => { const qty = items.filter(x => x.productId === p.id).reduce((a, x) => a + x.qty, 0); return qty ? { ...p, stock: Math.max(0, p.stock - qty) } : p; }),
    units: (prev.units || []).map(u => returnedUnitIds.has(u.id) ? { ...u, status: 'returned' as const, saleId: undefined, saleBillNo: undefined, soldAt: undefined, note: `Returned to supplier via ${ret.dnNo}` } : u),
    purchaseReturns: [ret, ...(prev.purchaseReturns || [])],
    counters: { ...prev.counters, dn: seq },
  }));
  pushAudit('PURCHASE_RETURN', 'Purchase', 'Debit Note ' + ret.dnNo + ' · ' + purchase.poNo + ' · ' + purchase.supplierName + ' · Rs.' + ret.total.toLocaleString());
  return ret;
}, [state.purchases, state.purchaseReturns, state.products, state.units, state.counters.dn, user, pushAudit, can]);

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
    if (!user || !can('page:expenses')) {
      pushAudit('DENIED', 'Expense', 'Blocked expense creation without expense access');
      return;
    }
    const amount = Number(e.amount);
    const category = String(e.category || '').trim();
    const note = String(e.note || '').trim();
    if (!Number.isFinite(amount) || amount <= 0 || !category || !note) {
      pushAudit('DENIED', 'Expense', 'Blocked invalid expense input');
      return;
    }
    const normalizedAmount = Math.round(amount * 100) / 100;
    setState(s => ({
      ...s,
      expenses: [{ ...e, amount: normalizedAmount, category, note, id: uid(), date: new Date().toISOString(), by: user?.name || 'Unknown' }, ...s.expenses],
    }));
    pushAudit('EXPENSE', 'Expense', `${category}: ${note} · Rs. ${normalizedAmount.toLocaleString()}`);
  }, [pushAudit, user?.name, user, can]);

  const deleteExpense = useCallback((id: string) => {
    if (!user || !can('page:expenses') || !can('act:deleteRecords')) {
      pushAudit('DENIED', 'Expense', 'Blocked expense delete without required permissions');
      return;
    }
    const e = state.expenses.find(x => x.id === id);
    setState(s => ({ ...s, expenses: s.expenses.filter(x => x.id !== id) }));
    if (e) pushAudit('DELETE', 'Expense', `Deleted expense ${e.category} · Rs. ${e.amount.toLocaleString()}`);
  }, [state.expenses, pushAudit, user, can]);

  /* ---------------- exchanges ---------------- */
  const processExchange = useCallback((saleId: string, returns: Array<{ itemIdx: number; qty: number }>, reason: string, mode: 'refund' | 'replace') => {
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
      if (!Number.isFinite(item.qty) || item.qty <= 0) continue;
      requested.set(item.itemIdx, Math.floor(item.qty));
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
        const trackedAvailable = (it.unitIds || []).filter(id => s.units.some(u => u.id === id && u.status === 'sold')).length;
        const qty = Math.min(requestedQty, availableQty, it.unitIds && it.unitIds.length > 0 ? trackedAvailable : requestedQty);
        if (qty <= 0) continue;

        const proportionalDiscount = it.qty > 0 ? (it.discount || 0) * (qty / it.qty) : 0;
        const amount = Math.max(0, Math.round((it.price * qty - proportionalDiscount) * 100) / 100);
        const unitIds = (it.unitIds || []).filter(id => s.units.some(u => u.id === id && u.status === 'sold')).slice(0, qty);

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
          ? { ...u, status: 'returned' as const, saleId: undefined, saleBillNo: undefined, soldAt: undefined }
          : u),
      };
    });
    pushAudit('EXCHANGE', 'Exchange', `${mode === 'refund' ? 'Returned' : 'Exchanged'} ${returns.reduce((sum, x) => sum + Math.max(0, Math.floor(x.qty)), 0)} unit(s) on ${sale.billNo}`);
  }, [state.sales, state.settings.exchangeDays, pushAudit, user, can]);

  /* ---------------- users ---------------- */
  const saveUser = useCallback((u: AppUser) => {
    if (!user || user.role !== 'admin') {
      pushAudit('DENIED', 'User', `Blocked user save for ${u.email || u.name || u.id}`);
      return;
    }
    const exists = state.users.some(x => x.id === u.id);
    // Always store password as hash (skip re-hash if already hashed and unchanged)
    const existing = state.users.find(x => x.id === u.id);
    const password = isHashed(u.password)
      ? u.password
      : (existing && u.password === existing.password ? existing.password : hashPassword(u.password));
    const toSave = { ...u, password };
    setState(s => ({ ...s, users: exists ? s.users.map(x => (x.id === u.id ? toSave : x)) : [...s.users, toSave] }));
    pushAudit(exists ? 'UPDATE' : 'CREATE', 'User', `${exists ? 'Updated' : 'Created'} user ${u.name} (${u.role})`);
  }, [state.users, pushAudit, user]);

  const toggleUserActive = useCallback((id: string) => {
    if (!user || user.role !== 'admin') {
      pushAudit('DENIED', 'User', `Blocked user status change for ${id}`);
      return;
    }
    const u = state.users.find(x => x.id === id);
    setState(s => ({ ...s, users: s.users.map(x => (x.id === id ? { ...x, active: !x.active } : x)) }));
    if (u) pushAudit('UPDATE', 'User', `${u.active ? 'Deactivated' : 'Activated'} user ${u.name}`);
  }, [state.users, pushAudit, user]);

  const deleteUser = useCallback((id: string) => {
    if (!user || user.role !== 'admin') {
      pushAudit('DENIED', 'User', `Blocked user delete for ${id}`);
      return;
    }
    const u = state.users.find(x => x.id === id);
    if (!u || u.id === user?.id) return;
    setState(s => ({ ...s, users: s.users.filter(x => x.id !== id) }));
    pushAudit('DELETE', 'User', `Deleted user ${u.name}`);
  }, [state.users, user?.id, pushAudit, user]);

  /* ---------------- admin ---------------- */
  const setPermission = useCallback((role: Role, key: string, value: boolean) => {
    if (!user || user.role !== 'admin') {
      pushAudit('DENIED', 'Permissions', `Blocked permission change for ${role}:${key}`);
      return;
    }
    if (role === 'admin') return;
    setState(s => ({
      ...s,
      permissions: { ...s.permissions, [role]: { ...s.permissions[role], [key]: value } },
    }));
    pushAudit('PERMISSION', 'Permissions', `Set ${key} = ${value ? 'ON' : 'OFF'} for ${role}`);
  }, [pushAudit, user]);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    if (!user || user.role !== 'admin') {
      pushAudit('DENIED', 'Settings', `Blocked settings update: ${Object.keys(patch).join(', ')}`);
      return;
    }
    setState(s => ({ ...s, settings: { ...s.settings, ...patch } }));
    pushAudit('SETTINGS', 'Settings', `Updated settings: ${Object.keys(patch).join(', ')}`);
  }, [pushAudit, user]);

  const closeSession = useCallback((cashierId: string, counted: number, note: string) => {
    if (!user || user.role !== 'admin') {
      pushAudit('DENIED', 'Session', 'Blocked cash-session close without admin access');
      return;
    }
    setState(s => ({
      ...s,
      sessions: s.sessions.map(x =>
        x.cashierId === cashierId && x.date === dkey(new Date())
          ? { ...x, closed: true, closing: counted, note }
          : x,
      ),
    }));
    pushAudit('DAY-CLOSE', 'Session', `Drawer settled · counted Rs. ${counted.toLocaleString()}${note ? ` · ${note}` : ''}`);
  }, [pushAudit, user, can]);

  // auto-open today's drawer session once per cashier
  useEffect(() => {
    if (!user) return;
    const today = dkey(new Date());
    if (state.sessions.some(x => x.cashierId === user.id && x.date === today)) return;
    const ns: DaySession = {
      id: uid(), cashierId: user.id, cashierName: user.name, date: today,
      opening: state.settings.openingFloat, closed: false,
    };
    setState(s =>
      s.sessions.some(x => x.cashierId === user.id && x.date === today)
        ? s
        : { ...s, sessions: [...s.sessions, ns] },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

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

  const exportData = useCallback(() => JSON.stringify(state, null, 2), [state]);

  const importData = useCallback((json: string) => {
    if (!user || user.role !== 'admin') {
      pushAudit('DENIED', 'Settings', 'Blocked backup import without admin access');
      return false;
    }
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
    try {
      const fromIdb = idbAvailable() ? await idbLoadState() : null;
      const refreshed = fromIdb ? migrate(fromIdb) : (loadStateFromLocalStorage() || buildSeed());
      setState(refreshed);
      // Deliberately do not touch session/sessionStorage/localStorage auth keys.
    } catch {
      const fallback = loadStateFromLocalStorage();
      if (fallback) setState(fallback);
    }
  }, []);

  /* ---------------- units (IMEI / serial) ---------------- */
  const saveUnit = useCallback((u: InventoryUnit) => {
    if (!user || !can('page:units')) {
      pushAudit('DENIED', 'Unit', 'Blocked unit save without units access');
      return;
    }
    const exists = (state.units || []).some(x => x.id === u.id);
    // prevent duplicate IMEI/serial in stock
    const dup = (state.units || []).find(x =>
      x.id !== u.id && x.status === 'in_stock' &&
      ((u.imei && x.imei === u.imei) || (u.serial && x.serial === u.serial)),
    );
    if (dup) {
      pushAudit('DENIED', 'Unit', `Duplicate IMEI/serial blocked: ${u.imei || u.serial}`);
      return;
    }
    setState(s => ({
      ...s,
      units: exists
        ? (s.units || []).map(x => (x.id === u.id ? u : x))
        : [u, ...(s.units || [])],
    }));
    pushAudit(exists ? 'UPDATE' : 'CREATE', 'Unit', `${exists ? 'Updated' : 'Added'} unit ${u.imei || u.serial || u.id}`);
  }, [state.units, pushAudit, user, can]);

  const saveUnitsBulk = useCallback((newUnits: InventoryUnit[]): { ok: boolean; added: number; errors: string[] } => {
    if (!user || !can('act:manageStock')) return { ok: false, added: 0, errors: ['You do not have permission to manage inventory units.'] };
    const errors: string[] = [];
    const current = state.units || [];
    const imeis = new Set(current.map(u => (u.imei || '').trim().toLowerCase()).filter(Boolean));
    const serials = new Set(current.map(u => (u.serial || '').trim().toLowerCase()).filter(Boolean));
    const accepted: InventoryUnit[] = [];
    const replacements: InventoryUnit[] = [];
    for (let i = 0; i < newUnits.length; i++) {
      const u = newUnits[i], line = i + 1;
      const imei = (u.imei || '').trim(), serial = (u.serial || '').trim();
      if (!imei && !serial) { errors.push('Line ' + line + ': IMEI or serial is required'); continue; }
      const ik = imei.toLowerCase(), sk = serial.toLowerCase();
      if (imei && imeis.has(ik)) { errors.push('Line ' + line + ': duplicate IMEI'); continue; }
      if (serial && serials.has(sk)) { errors.push('Line ' + line + ': duplicate serial'); continue; }
      if (imei) imeis.add(ik);
      if (serial) serials.add(sk);
      const placeholder = current.find(x =>
        x.productId === u.productId && x.status === 'in_stock' && !!x.purchaseId &&
        ((u.imei && !x.imei) || (u.serial && !x.serial))
      );
      if (placeholder) {
        replacements.push({ ...u, id: placeholder.id, purchaseId: placeholder.purchaseId, createdAt: placeholder.createdAt, cost: placeholder.cost, expiryDate: placeholder.expiryDate });
      } else {
        accepted.push(u);
      }
    }
    if (!accepted.length && !replacements.length) return { ok: false, added: 0, errors };
    const counts = new Map<string, number>();
    for (const u of accepted) counts.set(u.productId, (counts.get(u.productId) || 0) + 1);
    const replacementMap = new Map(replacements.map(u => [u.id, u]));
    setState(s => ({
      ...s,
      units: [...accepted, ...(s.units || []).map(u => replacementMap.get(u.id) || u)],
      products: s.products.map(p => counts.has(p.id) ? { ...p, stock: p.stock + counts.get(p.id)! } : p),
    }));
    const added = accepted.length + replacements.length;
    pushAudit('CREATE', 'Unit', 'Bulk added ' + added + ' IMEI/serial units');
    return { ok: true, added, errors };
  }, [user, can, state.units, pushAudit]);

  const deleteUnit = useCallback((id: string) => {
    if (!user || !can('page:units') || !can('act:deleteRecords')) {
      pushAudit('DENIED', 'Unit', 'Blocked unit delete without required permissions');
      return;
    }
    const u = (state.units || []).find(x => x.id === id);
    setState(s => ({ ...s, units: (s.units || []).filter(x => x.id !== id) }));
    if (u) pushAudit('DELETE', 'Unit', `Deleted unit ${u.imei || u.serial || u.id}`);
  }, [state.units, pushAudit, user, can]);

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
    // Parts are deducted exactly once at delivery, not when the job card is saved.
    if (old?.partsDeductedAt) return;
    setState(st=>{let job:RepairJob={...r,jobNo:jobNo||r.jobNo,parts,by:r.by||user.name};let counters=st.counters;if(!exists&&(!job.jobNo||job.jobNo.startsWith('JOB-TEMP'))){const seq=(st.counters.job||0)+1;job={...job,jobNo:`JOB-${String(seq).padStart(4,'0')}`};counters={...st.counters,job:seq};}return {...st,counters,repairs:exists?(st.repairs||[]).map(x=>x.id===r.id?job:x):[job,...(st.repairs||[])]};});
    pushAudit(exists?'UPDATE':'CREATE','Repair',`${exists?'Updated':'Opened'} ${jobNo||'job'} · ${r.deviceBrand} ${r.deviceModel}`);
  }, [state.repairs,state.products,pushAudit,user,can]);

  const updateRepairStatus = useCallback((id: string, status: RepairStatus, patch?: Partial<RepairJob>) => {
    if (!user || !can('page:repairs')) {
      pushAudit('DENIED', 'Repair', 'Blocked repair status update without repairs access');
      return;
    }
    const allowed: RepairStatus[] = ['received', 'diagnosed', 'waiting_parts', 'in_repair', 'ready', 'delivered', 'cancelled'];
    if (!allowed.includes(status)) return;
    const current = (state.repairs || []).find(j => j.id === id);
    if (!current) return;
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
        if (!product || product.stock < qty) {
          pushAudit('DENIED', 'Repair', 'Cannot deliver ' + current.jobNo + ': insufficient stock for repair part ' + (product?.name || productId));
          return;
        }
      }
    }
    next.partsDeductedAt = shouldDeductParts ? now : current.partsDeductedAt;
    if ((status === 'ready' || status === 'delivered') && !next.completedAt) next.completedAt = now;
    if (status === 'delivered' && !next.deliveredAt) next.deliveredAt = now;
    if (status !== 'delivered') next.deliveredAt = undefined;
    setState(s => {
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
    pushAudit('UPDATE', 'Category', `Renamed "${oldName}" → "${n}"`);
  }, [pushAudit, user, can]);

  const openSession = useCallback((cashierId: string, opening: number) => {
    if (!user || !can('page:pos')) {
      pushAudit('DENIED', 'Session', 'Blocked cash-session open without POS access');
      return;
    }
    const u = state.users.find(x => x.id === cashierId);
    if (!u) return;
    const today = dkey(new Date());
    setState(s => {
      const existing = s.sessions.find(x => x.cashierId === cashierId && x.date === today);
      if (existing) {
        return {
          ...s,
          sessions: s.sessions.map(x =>
            x.id === existing.id ? { ...x, opening: Math.max(0, opening), closed: false, closing: undefined } : x,
          ),
        };
      }
      const ns: DaySession = {
        id: uid(),
        cashierId,
        cashierName: u.name,
        date: today,
        opening: Math.max(0, opening),
        closed: false,
      };
      return { ...s, sessions: [...s.sessions, ns] };
    });
    pushAudit('DAY-OPEN', 'Session', `Opening float Rs. ${opening.toLocaleString()} · ${u.name}`);
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
  }, [user, can, pushAudit]);

  const runManualBackup = useCallback(async () => {
    if (!user || !can('act:export')) {
      pushAudit('DENIED', 'Settings', 'Blocked manual backup without export permission');
      return;
    }
    await downloadBackup(state, 'manual');
    const meta = await idbGetMeta();
    setBackupMeta(meta);
    pushAudit('BACKUP', 'Settings', 'Manual backup downloaded');
  }, [state, pushAudit, user, can]);

  const setAutoBackupHours = useCallback(async (hours: number) => {
    if (!user || user.role !== 'admin') {
      pushAudit('DENIED', 'Backup', 'Blocked auto-backup setting change without admin access');
      return;
    }
    const meta = await idbSetMeta({ autoBackupHours: Math.max(0, hours) });
    setBackupMeta(meta);
    pushAudit('SETTINGS', 'Backup', `Auto-backup interval set to ${hours <= 0 ? 'OFF' : hours + 'h'}`);
  }, [pushAudit, user]);

  const flushOfflineQueue = useCallback(async () => {
    const { flushed, pending } = await flushSyncQueue();
    setPendingQueueCount(pending);
    if (flushed > 0) pushAudit('SYNC', 'Offline', `Flushed ${flushed} queued write(s)`);
    return flushed;
  }, [pushAudit]);

  const value: StoreCtx = {
    state, user, viewingAs, dark, toggleTheme, can,
    adminPrompt, setAdminPrompt,
    signIn, changePassword, signOut, switchRole, changeAdminPin, verifyAdminPin,
    saveProduct, deleteProduct, saveKitItems, saveQuotations, adjustStock,
    saveCustomer, deleteCustomer, saveSupplier, deleteSupplier, saveSupplierPayment, deleteSupplierPayment,
    completeSale, completeSaleCloud, refundSale, requestBillReverse, approveBillReverse, rejectBillReverse, holdSale, resumeHold, deleteHold,
    savePurchase, saveGRNDraft, updateGRNDraft, receivePurchase, processGRN, createPurchaseReturn, deletePurchase,
    addExpense, deleteExpense, processExchange,
    saveUser, toggleUserActive, deleteUser,
    setPermission, updateSettings, closeSession, logAudit, clearAudit,
    exportData, importData, resetData, refreshPOS,
    connectivity, ready, backupMeta, runManualBackup, setAutoBackupHours,
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
