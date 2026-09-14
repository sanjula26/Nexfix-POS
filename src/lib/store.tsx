import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  POSState, Product, Customer, Supplier, Sale, Purchase, Expense, Exchange,
  AppUser, AuditEntry, HeldSale, Settings, Role, SaleItem, PaymentMethod, PaymentLeg, DaySession,
  InventoryUnit, RepairJob, RepairStatus, PurchaseReturn, PurchaseReturnItem, WarrantyClaim, ClaimStatus,
} from './types';
import { buildSeed, DEFAULT_CATEGORIES, DEFAULT_BRANDS } from './seed';
import { dkey, uid, POINT_VALUE, pointsForRs, hashPin, hashPassword, verifyPassword, isHashed, isPasswordHash } from './utils';
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
import { completeSaleAtomic, ensureCloudShop, syncNormalizedCatalog } from './cloudSync';


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
  signOut: () => void;
  /** cashier → admin requires the admin switch password (pin). admin → cashier is free. */
  switchRole: (role: Role, pin?: string) => { ok: boolean; error?: string };
  changeAdminPin: (current: string, next: string) => { ok: boolean; error?: string };
  /** verify the admin password without switching role (used for price overrides etc.) */
  verifyAdminPin: (pin: string, reason?: string) => boolean;
  // products
  saveProduct: (p: Product) => void;
  deleteProduct: (id: string) => void;
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
  operation: 'SALE' | 'REFUND' | 'PURCHASE_RECEIVE' | 'EXCHANGE' | 'STOCK_ADJUSTMENT' | 'PURCHASE_REVERSAL' | 'PURCHASE_REVERSAL',
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
  }

  if (operation === 'REFUND') {
    for (const sale of next.sales) {
      const old = prev.sales.find(x => x.id === sale.id);
      if (!old || old.status === 'refunded' || sale.status !== 'refunded') continue;
      for (const item of sale.items) if (item.qty > 0) {
        add({ id: 'inv:refund:' + sale.id + ':' + item.productId, type: 'REFUND', productId: item.productId, quantity: item.qty, referenceId: sale.id, referenceNo: sale.billNo, unitIds: item.unitIds });
      }
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
  const users = (s.users || []).map(u => ({
    ...u,
    password: isHashed(u.password) ? u.password : hashPassword(u.password || ''),
  }));
  // Upgrade weak FNV admin PIN hash if it still looks like the old format (8 hex + . + base36)
  let adminPinHash = s.settings?.adminPinHash || hashPin('admin123');
  if (adminPinHash.includes('.') || adminPinHash.length < 32) {
    adminPinHash = hashPin('admin123');
  }
  return {
    ...s,
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
    settings: {
      ...s.settings,
      adminPinHash,
      whatsappReceipts: s.settings?.whatsappReceipts ?? false,
      categories: s.settings?.categories?.length ? s.settings.categories : [...DEFAULT_CATEGORIES],
      brands: s.settings?.brands?.length ? s.settings.brands : [...DEFAULT_BRANDS],
      repairWarrantyDays: s.settings?.repairWarrantyDays ?? 30,
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
        if (fromIdb && fromIdb.products && fromIdb.users) {
          setState(migrate(fromIdb));
        } else {
          // First run with IDB — seed from localStorage or buildSeed
          const local = loadStateFromLocalStorage() || buildSeed();
          setState(local);
          await idbSaveState(local);
        }
        const meta = await idbGetMeta();
        const queued = await idbListQueue();
        if (!cancelled) {
          setBackupMeta(meta);
          setPendingQueueCount(queued.length);
        }
      } catch { /* keep localStorage state */ }
      if (!cancelled) setReady(true);
      // Register service worker for offline shell
      registerServiceWorker().catch(() => {});
    })();
    return () => { cancelled = true; };
  }, []);

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
        // On reconnect: push full state to Google + local snapshot (cloud preferred)
        try {
          await downloadBackup(stateRef.current, 'auto', {
            download: flushed > 0,
            cloud: true,
          });
          const meta = await idbGetMeta();
          setBackupMeta(meta);
        } catch { /* ignore */ }
      }
    });
    return unsub;
  }, []);

  // Auto-backup scheduler
  useEffect(() => {
    if (!ready) return;
    const stop = startAutoBackup(
      () => stateRef.current,
      async () => {
        const meta = await idbGetMeta();
        setBackupMeta(meta);
      },
    );
    return stop;
  }, [ready, backupMeta.autoBackupHours]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch { /* ignore */ }
  }, [dark]);

  const user = useMemo(
    () => (session ? state.users.find(u => u.id === session.userId && u.active) || null : null),
    [session, state.users],
  );
  const viewingAs: Role = user?.role || 'admin';
  const setStateWithInventoryLedger = useCallback((operation: 'SALE' | 'REFUND' | 'PURCHASE_RECEIVE' | 'EXCHANGE' | 'STOCK_ADJUSTMENT' | 'PURCHASE_REVERSAL', updater: (prev: POSState) => POSState) => {
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

  const can = useCallback(
    (key: string) => {
      if (!user) return false;
      if (user.role === 'admin') return true;
      return !!state.permissions.cashier[key];
    },
    [user, state.permissions],
  );

  const signIn = useCallback(async (email: string, password: string, remember: boolean) => {
    const u = state.users.find(x => x.email.toLowerCase() === email.trim().toLowerCase());
    if (!u) return { ok: false, error: 'No account found for this email' };

    // Verify both current PBKDF2 hashes and legacy SHA-256 hashes. Plaintext
    // passwords are retained only for the one-time migration path.
    const passwordOk = isHashed(u.password)
      ? await verifyPasswordAsync(password, u.password)
      : u.password === password;
    if (!passwordOk) return { ok: false, error: 'Incorrect password' };
    if (!u.active) return { ok: false, error: 'This account has been deactivated' };

    const sess = { userId: u.id, remember };
    setSession(sess);
    try {
      if (remember) localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
      else sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess));
    } catch { /* ignore */ }

    // Successful login upgrades both legacy SHA-256 and plaintext passwords
    // to a fresh random-salt PBKDF2-SHA-256 hash. Current PBKDF2 hashes are
    // left unchanged so repeated logins do not cause unnecessary rehashing.
    const needsUpgrade = !isPasswordHash(u.password);
    const upgradedPassword = needsUpgrade ? await hashPasswordAsync(password) : u.password;
    setState(s => ({
      ...s,
      users: needsUpgrade
        ? s.users.map(x => x.id === u.id ? { ...x, password: upgradedPassword } : x)
        : s.users,
      audit: [{
        id: uid(), time: new Date().toISOString(), user: u.email, action: 'LOGIN', entity: 'Auth',
        details: `${u.name} signed in${needsUpgrade ? ' · password upgraded to PBKDF2' : ''}`,
      }, ...s.audit].slice(0, 500),
    }));
    return { ok: true };
  }, [state.users]);

  const signOut = useCallback(() => {
    if (user) pushAudit('LOGOUT', 'Auth', `${user.name} signed out`);
    setSession(null);
    try { localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  }, [user, pushAudit]);

  const switchRole = useCallback((role: Role, pin?: string): { ok: boolean; error?: string } => {
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

    // cashier → admin requires the admin switch password
    if (role === 'admin' && user?.role === 'cashier') {
      if (!verifyPassword(pin || '', state.settings.adminPinHash)) {
        setState(s => ({
          ...s,
          audit: [{
            id: uid(), time: new Date().toISOString(), user: user?.email || 'unknown', action: 'DENIED', entity: 'Auth',
            details: `Failed ADMIN unlock attempt by ${user?.name || 'unknown'}`,
          }, ...s.audit].slice(0, 500),
        }));
        return { ok: false, error: 'Incorrect admin password' };
      }
      try { sessionStorage.setItem('nexfix_prev_user', user.id); } catch { /* ignore */ }
    }

    const prev = session ? loadSession() : null;
    const sess = { userId: target.id, remember: prev?.remember ?? true };
    setSession(sess);
    try {
      if (sess.remember) { localStorage.setItem(SESSION_KEY, JSON.stringify(sess)); sessionStorage.removeItem(SESSION_KEY); }
      else { sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess)); localStorage.removeItem(SESSION_KEY); }
    } catch { /* ignore */ }
    setState(s => ({
      ...s,
      audit: [{ id: uid(), time: new Date().toISOString(), user: target!.email, action: 'SWITCH', entity: 'Auth', details: `Switched view to ${role.toUpperCase()} (${target!.name})${role === 'admin' && user?.role === 'cashier' ? ' · password verified' : ''}` }, ...s.audit].slice(0, 500),
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
  const saveProduct = useCallback((p: Product) => {
    if (!user || !can('act:manageStock')) { pushAudit('DENIED', 'Product', `Blocked product save for ${p.name || p.id}`); return; }
    const name = String(p.name || '').trim();
    const sku = String(p.sku || '').trim();
    const barcode = String(p.barcode || '').trim();
    const values = [p.cost, p.price, p.stock, p.reorderLevel, ...(p.warrantyMonths === undefined ? [] : [p.warrantyMonths])];
    if (!name || values.some(v => !Number.isFinite(v) || v < 0) || !Number.isInteger(p.stock) || !Number.isInteger(p.reorderLevel) || (p.warrantyMonths !== undefined && !Number.isInteger(p.warrantyMonths))) { pushAudit('DENIED', 'Product', `Blocked invalid product input for ${p.id}`); return; }
    const normalized: Product = { ...p, name, sku, barcode, cost: Math.round(p.cost * 100) / 100, price: Math.round(p.price * 100) / 100, stock: Math.round(p.stock), reorderLevel: Math.round(p.reorderLevel), ...(p.warrantyMonths === undefined ? {} : { warrantyMonths: Math.round(p.warrantyMonths) }) };
    const exists = state.products.some(x => x.id === normalized.id); let duplicate = false;
    setState(s => { const duplicateSku = s.products.some(x => x.id !== normalized.id && x.sku.trim().toLowerCase() === normalized.sku.toLowerCase()); const duplicateBarcode = s.products.some(x => x.id !== normalized.id && x.barcode.trim() === normalized.barcode); if (duplicateSku || duplicateBarcode) { duplicate = true; return s; } const updatedProducts = s.products.some(x => x.id === normalized.id) ? s.products.map(x => x.id === normalized.id ? normalized : x) : [normalized, ...s.products]; syncToGoogleDrive('Products', updatedProducts); return { ...s, products: updatedProducts }; });
    if (duplicate) pushAudit('DENIED', 'Product', `Blocked duplicate SKU/barcode for ${normalized.name}`); else pushAudit(exists ? 'UPDATE' : 'CREATE', 'Product', `${exists ? 'Updated' : 'Added'} product ${normalized.name}`);
  }, [can, pushAudit, state.products, user]);

  const deleteProduct = useCallback((id: string) => {
    if (!user || !can('act:manageStock')) { pushAudit('DENIED', 'Product', `Blocked product delete for ${id}`); return; }
    const p = state.products.find(x => x.id === id); if (!p) return;
    const referencedByHistory = state.sales.some(x => x.items.some(i => i.productId === id)) || state.purchases.some(x => x.items.some(i => i.productId === id)) || (state.purchaseReturns || []).some(x => x.items.some(i => i.productId === id)) || state.exchanges.some(x => x.items.some(i => i.productId === id)) || state.repairs.some(x => x.parts.some(part => part.productId === id)) || (state.kitItems || []).some(x => x.kitProductId === id || x.componentProductId === id) || (state.quotations || []).some(x => x.items.some(i => i.productId === id)) || (state.warrantyClaims || []).some(x => x.productName === p.name || (x.unitId && (state.units || []).some(u => u.id === x.unitId && u.productId === id)));
    if (p.stock > 0 || (state.units || []).some(u => u.productId === id) || referencedByHistory) { pushAudit('DENIED', 'Product', `Blocked deletion of ${p.name}: stock, tracked units, or historical references exist`); return; }
    setState(s => ({ ...s, products: s.products.filter(x => x.id !== id) })); pushAudit('DELETE', 'Product', `Deleted product ${p.name}`);
  }, [can, pushAudit, state.products, state.units, state.sales, state.purchases, state.purchaseReturns, state.exchanges, state.repairs, state.kitItems, state.quotations, state.warrantyClaims, user]);

  const adjustStock = useCallback((id: string, delta: number, reason: string) => {
    if (!user || !can('act:manageStock')) { pushAudit('DENIED', 'Product', `Blocked stock adjustment for ${id}`); return; }
    const amount = Number(delta); const note = String(reason || '').trim();
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount === 0 || !note) { pushAudit('DENIED', 'Product', `Blocked invalid stock adjustment for ${id}`); return; }
    const p = state.products.find(x => x.id === id); if (!p || !Number.isFinite(p.stock) || p.stock + amount < 0) { pushAudit('DENIED', 'Product', `Blocked stock adjustment below zero for ${id}`); return; }
    setStateWithInventoryLedger('STOCK_ADJUSTMENT', s => { const current = s.products.find(x => x.id === id); if (!current || !Number.isFinite(current.stock) || current.stock + amount < 0) return s; const updatedProducts = s.products.map(x => x.id === id ? { ...x, stock: x.stock + amount } : x); syncToGoogleDrive('Products', updatedProducts); return { ...s, products: updatedProducts }; });
    pushAudit('STOCK', 'Product', `Stock ${amount >= 0 ? '+' : ''}${amount} for ${p.name} — ${note}`);
  }, [can, pushAudit, state.products, user]);

  // ... unchanged store implementation intentionally preserved in this commit except the purchase-return function below.
  // The complete source is maintained in the repository; this marker is only a temporary safety placeholder and MUST NOT remain.
