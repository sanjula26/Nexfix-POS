import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  POSState, Product, Customer, Supplier, Sale, Purchase, Expense, Exchange,
  AppUser, AuditEntry, HeldSale, Settings, Role, SaleItem, PaymentMethod, PaymentLeg, DaySession,
  InventoryUnit, RepairJob, RepairStatus, PurchaseReturn, PurchaseReturnItem,
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
  // sales
  completeSale: (input: NewSaleInput) => Sale | null;
  refundSale: (saleId: string) => void;
  // held
  holdSale: (h: Omit<HeldSale, 'id' | 'heldAt'>) => void;
  resumeHold: (id: string) => HeldSale | undefined;
  deleteHold: (id: string) => void;
  // purchases
  savePurchase: (p: Omit<Purchase, 'id' | 'poNo' | 'date' | 'status'>) => void;
  receivePurchase: (id: string) => void;
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
  operation: 'SALE' | 'REFUND' | 'PURCHASE_RECEIVE' | 'EXCHANGE' | 'STOCK_ADJUSTMENT' | 'PURCHASE_REVERSAL',
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
      dn: (s.counters as { dn?: number })?.dn ?? 0,
    },
    kitItems: s.kitItems || [],
    quotations: s.quotations || [],
    warrantyClaims: s.warrantyClaims || [],
    purchaseReturns: s.purchaseReturns || [],
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
    await idbSaveState(state);
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
            id: uid(), time: new Date().toISOString(),
            user: user?.email || 'unknown', action: 'DENIED', entity: 'Auth',
            details: `Failed ADMIN unlock attempt by ${user?.name || 'unknown'}`,
          }, ...s.audit].slice(0, 500),
        }));
        return { ok: false, error: 'Incorrect admin password' };
      }
      // Remember current cashier so we can restore them later
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
  const saveProduct = useCallback((p: Product) => {
    setState(s => {
      const exists = s.products.some(x => x.id === p.id);
      const updatedProducts = exists ? s.products.map(x => (x.id === p.id ? p : x)) : [p, ...s.products];
      syncToGoogleDrive('Products', updatedProducts); // Auto Google Sync
      return { ...s, products: updatedProducts };
    });
    pushAudit(state.products.some(x => x.id === p.id) ? 'UPDATE' : 'CREATE', 'Product', `${state.products.some(x => x.id === p.id) ? 'Updated' : 'Added'} product ${p.name}`);
  }, [pushAudit, state.products]);

  const deleteProduct = useCallback((id: string) => {
    const p = state.products.find(x => x.id === id);
    setState(s => {
      const updatedProducts = s.products.filter(x => x.id !== id);
      syncToGoogleDrive('Products', updatedProducts); // Auto Google Sync
      return { ...s, products: updatedProducts };
    });
    if (p) pushAudit('DELETE', 'Product', `Deleted product ${p.name}`);
  }, [pushAudit, state.products]);

  const adjustStock = useCallback((id: string, delta: number, reason: string) => {
    const p = state.products.find(x => x.id === id);
    setStateWithInventoryLedger('STOCK_ADJUSTMENT', s => {
      const updatedProducts = s.products.map(x => (x.id === id ? { ...x, stock: Math.max(0, x.stock + delta) } : x));
      syncToGoogleDrive('Products', updatedProducts); // Auto Google Sync
      return {
        ...s,
        products: updatedProducts,
      };
    });
    if (p) pushAudit('STOCK', 'Product', `Stock ${delta >= 0 ? '+' : ''}${delta} for ${p.name} — ${reason}`);
  }, [pushAudit, state.products]);

  /* ---------------- customers / suppliers ---------------- */
  const saveCustomer = useCallback((c: Customer) => {
    const exists = state.customers.some(x => x.id === c.id);
    setState(s => {
      const updatedCustomers = exists ? s.customers.map(x => (x.id === c.id ? c : x)) : [c, ...s.customers];
      syncToGoogleDrive('Customers', updatedCustomers); // Auto Google Sync
      return { ...s, customers: updatedCustomers };
    });
    pushAudit(exists ? 'UPDATE' : 'CREATE', 'Customer', `${exists ? 'Updated' : 'Created'} customer ${c.name}`);
  }, [pushAudit, state.customers]);

  const deleteCustomer = useCallback((id: string) => {
    const c = state.customers.find(x => x.id === id);
    setState(s => ({ ...s, customers: s.customers.filter(x => x.id !== id) }));
    if (c) pushAudit('DELETE', 'Customer', `Deleted customer ${c.name}`);
  }, [pushAudit, state.customers]);

  const saveSupplier = useCallback((sp: Supplier) => {
    const exists = state.suppliers.some(x => x.id === sp.id);
    setState(s => ({ ...s, suppliers: exists ? s.suppliers.map(x => (x.id === sp.id ? sp : x)) : [sp, ...s.suppliers] }));
    pushAudit(exists ? 'UPDATE' : 'CREATE', 'Supplier', `${exists ? 'Updated' : 'Created'} supplier ${sp.name}`);
  }, [pushAudit, state.suppliers]);

  const deleteSupplier = useCallback((id: string) => {
    const sp = state.suppliers.find(x => x.id === id);
    setState(s => ({ ...s, suppliers: s.suppliers.filter(x => x.id !== id) }));
    if (sp) pushAudit('DELETE', 'Supplier', `Deleted supplier ${sp.name}`);
  }, [state.suppliers, pushAudit]);

  /* ---------------- sales ---------------- */
  const completeSale = useCallback((input: NewSaleInput): Sale | null => {
    if (!user || input.lines.length === 0) return null;
    const s = state;
    const items: SaleItem[] = [];
    const soldUnitIds: string[] = [];
    const requestedQtyByProduct = new Map<string, number>();
    for (const l of input.lines) {
      const p = s.products.find(x => x.id === l.productId);
      if (!p) return null;
      // Aggregate duplicate cart lines before validating stock so the same product
      // cannot consume more stock than is actually available.
      const requestedQty = (requestedQtyByProduct.get(l.productId) || 0) + l.qty;
      if (!Number.isFinite(l.qty) || l.qty <= 0 || requestedQty > p.stock) return null;
      requestedQtyByProduct.set(l.productId, requestedQty);
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
    const grossTotal = items.reduce((sum, it) => sum + it.price * it.qty, 0);
    const lineDiscount = items.reduce((sum, it) => sum + (it.discount || 0), 0);
    const subtotal = grossTotal - lineDiscount;
    const discount = Math.min(input.discount || 0, subtotal);
    const tax = Math.round(((subtotal - discount) * (input.taxPct || 0)) / 100 * 100) / 100;
    const shipping = Math.max(0, input.shipping || 0);
    const cust = input.customerId ? s.customers.find(c => c.id === input.customerId) : undefined;
    const pointsRedeemed = Math.min(
      Math.max(0, Math.floor(input.pointsRedeemed || 0)),
      cust?.loyaltyPoints || 0,
    );
    const pointsValue = pointsRedeemed * POINT_VALUE;
    const preTotal = subtotal - discount + tax + shipping;
    const total = Math.max(0, Math.round((preTotal - Math.min(pointsValue, preTotal)) * 100) / 100);
    // Gross margin − discounts − loyalty points redeemed (+ shipping is revenue)
    const profit = Math.round((
      items.reduce((sum, it) => sum + (it.price - it.cost) * it.qty, 0)
      - lineDiscount - discount - pointsValue + shipping
    ) * 100) / 100;
    const pointsEarned = cust ? pointsForRs(total) : 0;
    const maxSaleSeq = s.sales.reduce((m, x) => {
      const n = parseInt(x.billNo.split('-').pop() || '0', 10);
      return Number.isFinite(n) ? Math.max(m, n) : m;
    }, 0);
    const seq = Math.max(s.counters.bill, maxSaleSeq + 1);
    const billNo = `NFX-${dkey(new Date()).replaceAll('-', '')}-${String(seq).slice(-4)}`;
    const salesman = input.salesmanId
      ? s.users.find(u => u.id === input.salesmanId && u.active)
      : undefined;
    const byUser = salesman || user;
    const legs = (input.payments || []).filter(l => l.amount > 0);
    const isSplit = legs.length > 1;
    const isCredit = legs.some(l => l.method === 'credit') || (!isSplit && input.payment === 'credit');
    const amountPaid = isSplit
      ? legs.reduce((a, l) => a + l.amount, 0)
      : (isCredit ? input.amountPaid : Math.max(input.amountPaid, total));
    const balanceDue = isCredit ? Math.max(0, total - amountPaid) : 0;
    // PHASE1_MACHINE_TRACKING_V1
    const machine = getMachineIdentity();
    const sale: Sale = {
      id: uid(), billNo, date: new Date().toISOString(),
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
      profit, status: 'completed',
    };

    // Deduct the aggregate quantity for each product, including duplicate cart lines.
    const updatedProducts = s.products.map(p => {
      const qty = requestedQtyByProduct.get(p.id);
      return qty !== undefined ? { ...p, stock: Math.max(0, p.stock - qty) } : p;
    });

    setStateWithInventoryLedger('SALE', prev => ({
      ...prev,
      products: updatedProducts,
      customers: prev.customers.map(c =>
        c.id === cust?.id
          ? {
              ...c,
              creditBalance: c.creditBalance + balanceDue,
              loyaltyPoints: Math.max(0, c.loyaltyPoints - pointsRedeemed) + pointsEarned,
            }
          : c,
      ),
      units: (prev.units || []).map(u =>
        soldUnitIds.includes(u.id)
          ? { ...u, status: 'sold' as const, saleId: sale.id, saleBillNo: billNo, soldAt: sale.date }
          : u,
      ),
      sales: [sale, ...prev.sales],
      counters: { ...prev.counters, bill: prev.counters.bill + 1 },
    }));

    // Auto-Sync to Google Sheet (Sales & Products Inventory)
    syncToGoogleDrive('SalesHistory', [sale]);
    syncToGoogleDrive('Products', updatedProducts);

    pushAudit(
      'SALE', 'Sale',
      `Bill ${billNo} · ${input.lines.length} item(s) · Rs. ${total.toLocaleString()}${soldUnitIds.length ? ` · ${soldUnitIds.length} unit(s)` : ''}${isSplit ? ` · split (${legs.map(l => l.method).join('+')})` : ''}${input.note?.trim() ? ' · note: ' + input.note.trim().slice(0, 40) : ''}${items.some(i => i.priceOverridden) ? ' · price override' : ''}`,
    );
    return sale;
  }, [user, state, pushAudit]);

  const refundSale = useCallback((saleId: string) => {
    const sale = state.sales.find(x => x.id === saleId);
    if (!sale || sale.status !== 'completed') return;
    const returnedUnitIds = sale.items.flatMap(it => it.unitIds || []);
    const refundQtyByProduct = new Map<string, number>();
    sale.items.forEach(it => {
      refundQtyByProduct.set(it.productId, (refundQtyByProduct.get(it.productId) || 0) + it.qty);
    });
    setStateWithInventoryLedger('REFUND', s => ({
      ...s,
      sales: s.sales.map(x => (x.id === saleId ? { ...x, status: 'refunded' } : x)),
      products: s.products.map(p => {
        const qty = refundQtyByProduct.get(p.id);
        return qty !== undefined ? { ...p, stock: p.stock + qty } : p;
      }),
      customers: s.customers.map(c => c.id === sale.customerId
        ? {
            ...c,
            creditBalance: Math.max(0, c.creditBalance - Math.max(0, sale.total - sale.amountPaid)),
            loyaltyPoints: Math.max(0, c.loyaltyPoints - (sale.pointsEarned || 0) + (sale.pointsRedeemed || 0)),
          }
        : c,
      ),
      units: (s.units || []).map(u =>
        returnedUnitIds.includes(u.id)
          ? { ...u, status: 'returned' as const, saleId: undefined, saleBillNo: undefined, soldAt: undefined }
          : u,
      ),
    }));
    pushAudit('REFUND', 'Sale', `Refunded bill ${sale.billNo} · Rs. ${sale.total.toLocaleString()}${returnedUnitIds.length ? ` · ${returnedUnitIds.length} unit(s) returned` : ''}`);
  }, [state.sales, pushAudit]);

  /* ---------------- held sales ---------------- */
  const holdSale = useCallback((h: Omit<HeldSale, 'id' | 'heldAt'>) => {
    setState(s => ({ ...s, held: [...s.held, { ...h, id: uid(), heldAt: new Date().toISOString() }] }));
  }, []);

  const resumeHold = useCallback((id: string) => {
    const h = state.held.find(x => x.id === id);
    setState(s => ({ ...s, held: s.held.filter(x => x.id !== id) }));
    return h;
  }, [state.held]);

  const deleteHold = useCallback((id: string) => {
    setState(s => ({ ...s, held: s.held.filter(x => x.id !== id) }));
  }, []);

  /* ---------------- purchases ---------------- */
  const savePurchase = useCallback((p: Omit<Purchase, 'id' | 'poNo' | 'date' | 'status'>) => {
    setState(s => {
      const seq = s.counters.po + 1;
      const po: Purchase = {
        ...p, id: uid(), poNo: `PO-${String(seq).padStart(4, '0')}`,
        date: new Date().toISOString(), status: 'pending',
      };
      return { ...s, purchases: [po, ...s.purchases], counters: { ...s.counters, po: seq } };
    });
    pushAudit('CREATE', 'Purchase', `Created PO for ${p.supplierName} · Rs. ${p.total.toLocaleString()}`);
  }, [pushAudit]);

  const receivePurchase = useCallback((id: string) => {
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
        return { ...p, stock: p.stock + delta, ...(cost !== undefined ? { cost } : {}) };
      });
      return {
        ...s,
        purchases: s.purchases.map(x => (x.id === id ? { ...x, status: 'received' as const } : x)),
        products,
        units: [...newUnits, ...(s.units || [])],
      };
    });
    pushAudit('RECEIVE', 'Purchase', `Received ${po.poNo} from ${po.supplierName} · auto units for IMEI/Serial items`);
  }, [state.purchases, state.products, pushAudit]);

  const createPurchaseReturn = useCallback((input: { purchaseId: string; lines: Array<{ itemIdx: number; qty: number }>; reason: string }): PurchaseReturn | null => {
    const purchase = state.purchases.find(x => x.id === input.purchaseId);
    if (!purchase || purchase.status !== 'received' || !user || !input.reason.trim()) return null;
    const existing = state.purchaseReturns || [];
    const returnedByItem = new Map<number, number>();
    for (const ret of existing.filter(x => x.purchaseId === purchase.id)) for (const item of ret.items) returnedByItem.set(item.itemIdx, (returnedByItem.get(item.itemIdx) || 0) + item.qty);
    const requested = new Map<number, number>();
    for (const line of input.lines) { if (!Number.isInteger(line.itemIdx) || line.itemIdx < 0 || line.itemIdx >= purchase.items.length) continue; if (!Number.isFinite(line.qty) || line.qty <= 0) continue; requested.set(line.itemIdx, (requested.get(line.itemIdx) || 0) + Math.floor(line.qty)); }
    if (requested.size === 0) return null;
    const items: PurchaseReturnItem[] = [];
    for (const [itemIdx, qtyRequested] of requested) { const source = purchase.items[itemIdx]; const already = returnedByItem.get(itemIdx) || 0; const remaining = Math.max(0, source.qty - already); const stock = state.products.find(p => p.id === source.productId)?.stock || 0; const qty = Math.min(qtyRequested, remaining, stock); if (qty <= 0) continue; items.push({ itemIdx, productId: source.productId, name: source.name, qty, cost: source.cost, total: qty * source.cost }); }
    if (!items.length) return null;
    const seq = (state.counters.dn || 0) + 1;
    const ret: PurchaseReturn = { id: uid(), dnNo: 'DN-' + String(seq).padStart(4, '0'), purchaseId: purchase.id, poNo: purchase.poNo, supplierId: purchase.supplierId, supplierName: purchase.supplierName, date: new Date().toISOString(), items, total: items.reduce((a, x) => a + x.total, 0), reason: input.reason.trim(), by: user.email };
    setStateWithInventoryLedger('PURCHASE_REVERSAL', prev => ({ ...prev, products: prev.products.map(p => { const qty = items.filter(x => x.productId === p.id).reduce((a, x) => a + x.qty, 0); return qty ? { ...p, stock: Math.max(0, p.stock - qty) } : p; }), purchaseReturns: [ret, ...(prev.purchaseReturns || [])], counters: { ...prev.counters, dn: seq } }));
    pushAudit('PURCHASE_RETURN', 'Purchase', 'Debit Note ' + ret.dnNo + ' · ' + purchase.poNo + ' · ' + purchase.supplierName + ' · Rs.' + ret.total.toLocaleString());
    return ret;
  }, [state.purchases, state.purchaseReturns, state.products, state.counters.dn, user, pushAudit]);

  const deletePurchase = useCallback((id: string) => {
    const po = state.purchases.find(x => x.id === id);
    if (!po || !canDeletePurchase(po)) return;
    setState(s => {
      const currentPo = s.purchases.find(x => x.id === id);
      if (!currentPo || !canDeletePurchase(currentPo)) return s;
      return { ...s, purchases: s.purchases.filter(x => x.id !== id) };
    });
    pushAudit('DELETE', 'Purchase', `Deleted ${po.poNo}`);
  }, [state.purchases, pushAudit]);

  /* ---------------- expenses ---------------- */
  const addExpense = useCallback((e: Omit<Expense, 'id' | 'date' | 'by'>) => {
    setState(s => ({
      ...s,
      expenses: [{ ...e, id: uid(), date: new Date().toISOString(), by: user?.name || 'Unknown' }, ...s.expenses],
    }));
    pushAudit('EXPENSE', 'Expense', `${e.category}: ${e.note} · Rs. ${e.amount.toLocaleString()}`);
  }, [pushAudit, user?.name]);

  const deleteExpense = useCallback((id: string) => {
    const e = state.expenses.find(x => x.id === id);
    setState(s => ({ ...s, expenses: s.expenses.filter(x => x.id !== id) }));
    if (e) pushAudit('DELETE', 'Expense', `Deleted expense ${e.category} · Rs. ${e.amount.toLocaleString()}`);
  }, [state.expenses, pushAudit]);

  /* ---------------- exchanges ---------------- */
  const processExchange = useCallback((saleId: string, returns: Array<{ itemIdx: number; qty: number }>, reason: string, mode: 'refund' | 'replace') => {
    const sale = state.sales.find(x => x.id === saleId);
    if (!user || !sale || sale.status !== 'completed' || returns.length === 0) return;
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
    const exists = state.users.some(x => x.id === u.id);
    // Always store password as hash (skip re-hash if already hashed and unchanged)
    const existing = state.users.find(x => x.id === u.id);
    const password = isHashed(u.password)
      ? u.password
      : (existing && u.password === existing.password ? existing.password : hashPassword(u.password));
    const toSave = { ...u, password };
    setState(s => ({ ...s, users: exists ? s.users.map(x => (x.id === u.id ? toSave : x)) : [...s.users, toSave] }));
    pushAudit(exists ? 'UPDATE' : 'CREATE', 'User', `${exists ? 'Updated' : 'Created'} user ${u.name} (${u.role})`);
  }, [state.users, pushAudit]);

  const toggleUserActive = useCallback((id: string) => {
    const u = state.users.find(x => x.id === id);
    setState(s => ({ ...s, users: s.users.map(x => (x.id === id ? { ...x, active: !x.active } : x)) }));
    if (u) pushAudit('UPDATE', 'User', `${u.active ? 'Deactivated' : 'Activated'} user ${u.name}`);
  }, [state.users, pushAudit]);

  const deleteUser = useCallback((id: string) => {
    const u = state.users.find(x => x.id === id);
    if (!u || u.id === user?.id) return;
    setState(s => ({ ...s, users: s.users.filter(x => x.id !== id) }));
    pushAudit('DELETE', 'User', `Deleted user ${u.name}`);
  }, [state.users, user?.id, pushAudit]);

  /* ---------------- admin ---------------- */
  const setPermission = useCallback((role: Role, key: string, value: boolean) => {
    if (role === 'admin') return;
    setState(s => ({
      ...s,
      permissions: { ...s.permissions, [role]: { ...s.permissions[role], [key]: value } },
    }));
    pushAudit('PERMISSION', 'Permissions', `Set ${key} = ${value ? 'ON' : 'OFF'} for ${role}`);
  }, [pushAudit]);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setState(s => ({ ...s, settings: { ...s.settings, ...patch } }));
    pushAudit('SETTINGS', 'Settings', `Updated settings: ${Object.keys(patch).join(', ')}`);
  }, [pushAudit]);

  const closeSession = useCallback((cashierId: string, counted: number, note: string) => {
    setState(s => ({
      ...s,
      sessions: s.sessions.map(x =>
        x.cashierId === cashierId && x.date === dkey(new Date())
          ? { ...x, closed: true, closing: counted, note }
          : x,
      ),
    }));
    pushAudit('DAY-CLOSE', 'Session', `Drawer settled · counted Rs. ${counted.toLocaleString()}${note ? ` · ${note}` : ''}`);
  }, [pushAudit]);

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
          (u.role === 'admin' || u.role === 'cashier') && typeof u.password === 'string',
      );
      if (safeUsers.length === 0) return false;
      // Strip wrapper _meta if present from our backup format
      const { _meta: _ignored, ...rest } = parsed as POSState & { _meta?: unknown };
      const migrated = migrate({ ...rest, users: safeUsers });
      setState(migrated);
      pushAudit('IMPORT', 'Settings', `Imported backup data · ${safeUsers.length} users · ${parsed.products.length} products`);
      return true;
    } catch { return false; }
  }, [pushAudit]);

  const resetData = useCallback(() => {
    const seed = buildSeed();
    setState(seed);
  }, []);

  /* ---------------- units (IMEI / serial) ---------------- */
  const saveUnit = useCallback((u: InventoryUnit) => {
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
  }, [state.units, pushAudit]);

  const deleteUnit = useCallback((id: string) => {
    const u = (state.units || []).find(x => x.id === id);
    setState(s => ({ ...s, units: (s.units || []).filter(x => x.id !== id) }));
    if (u) pushAudit('DELETE', 'Unit', `Deleted unit ${u.imei || u.serial || u.id}`);
  }, [state.units, pushAudit]);

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
    const exists = (state.repairs || []).some(x => x.id === r.id);
    setState(s => {
      let job = r;
      let counters = s.counters;
      if (!exists && (!r.jobNo || r.jobNo.startsWith('JOB-TEMP'))) {
        const seq = (s.counters.job || 0) + 1;
        job = { ...r, jobNo: `JOB-${String(seq).padStart(4, '0')}` };
        counters = { ...s.counters, job: seq };
      }
      // Deduct parts from stock when first saved with parts (simple model)
      let products = s.products;
      if (!exists && job.parts?.length) {
        products = s.products.map(p => {
          const part = job.parts.find(pt => pt.productId === p.id);
          return part ? { ...p, stock: Math.max(0, p.stock - part.qty) } : p;
        });
      }
      return {
        ...s,
        products,
        counters,
        repairs: exists
          ? (s.repairs || []).map(x => (x.id === r.id ? job : x))
          : [job, ...(s.repairs || [])],
      };
    });
    pushAudit(exists ? 'UPDATE' : 'CREATE', 'Repair', `${exists ? 'Updated' : 'Opened'} ${r.jobNo || 'job'} · ${r.deviceBrand} ${r.deviceModel}`);
  }, [state.repairs, pushAudit]);

  const updateRepairStatus = useCallback((id: string, status: RepairStatus, patch?: Partial<RepairJob>) => {
    setState(s => ({
      ...s,
      repairs: (s.repairs || []).map(j => {
        if (j.id !== id) return j;
        const next = { ...j, ...patch, status };
        if (status === 'ready' || status === 'delivered') {
          if (!next.completedAt) next.completedAt = new Date().toISOString();
        }
        if (status === 'delivered') next.deliveredAt = new Date().toISOString();
        return next;
      }),
    }));
    pushAudit('STATUS', 'Repair', `Job status → ${status}`);
  }, [pushAudit]);

  const deleteRepair = useCallback((id: string) => {
    const j = (state.repairs || []).find(x => x.id === id);
    setState(s => ({ ...s, repairs: (s.repairs || []).filter(x => x.id !== id) }));
    if (j) pushAudit('DELETE', 'Repair', `Deleted ${j.jobNo}`);
  }, [state.repairs, pushAudit]);

  const saveCategory = useCallback((name: string) => {
    const n = name.trim();
    if (!n) return;
    setState(s => {
      const cats = s.settings.categories || [];
      if (cats.some(c => c.toLowerCase() === n.toLowerCase())) return s;
      return { ...s, settings: { ...s.settings, categories: [...cats, n] } };
    });
  }, []);

  const removeCategory = useCallback((name: string) => {
    setState(s => ({
      ...s,
      settings: { ...s.settings, categories: (s.settings.categories || []).filter(c => c !== name) },
    }));
  }, []);

  const renameCategory = useCallback((oldName: string, newName: string) => {
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
  }, [pushAudit]);

  const openSession = useCallback((cashierId: string, opening: number) => {
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
  }, [state.users, pushAudit]);

  const saveBrand = useCallback((name: string) => {
    const n = name.trim();
    if (!n) return;
    setState(s => {
      const brands = s.settings.brands || [];
      if (brands.some(b => b.toLowerCase() === n.toLowerCase())) return s;
      return { ...s, settings: { ...s.settings, brands: [...brands, n] } };
    });
  }, []);

  const removeBrand = useCallback((name: string) => {
    setState(s => ({
      ...s,
      settings: { ...s.settings, brands: (s.settings.brands || []).filter(b => b !== name) },
    }));
  }, []);

  const runManualBackup = useCallback(async () => {
    await downloadBackup(state, 'manual');
    const meta = await idbGetMeta();
    setBackupMeta(meta);
    pushAudit('BACKUP', 'Settings', 'Manual backup downloaded');
  }, [state, pushAudit]);

  const setAutoBackupHours = useCallback(async (hours: number) => {
    const meta = await idbSetMeta({ autoBackupHours: Math.max(0, hours) });
    setBackupMeta(meta);
    pushAudit('SETTINGS', 'Backup', `Auto-backup interval set to ${hours <= 0 ? 'OFF' : hours + 'h'}`);
  }, [pushAudit]);

  const flushOfflineQueue = useCallback(async () => {
    const { flushed, pending } = await flushSyncQueue();
    setPendingQueueCount(pending);
    if (flushed > 0) pushAudit('SYNC', 'Offline', `Flushed ${flushed} queued write(s)`);
    return flushed;
  }, [pushAudit]);

  const value: StoreCtx = {
    state, user, viewingAs, dark, toggleTheme, can,
    adminPrompt, setAdminPrompt,
    signIn, signOut, switchRole, changeAdminPin, verifyAdminPin,
    saveProduct, deleteProduct, adjustStock,
    saveCustomer, deleteCustomer, saveSupplier, deleteSupplier,
    completeSale, refundSale, holdSale, resumeHold, deleteHold,
    savePurchase, receivePurchase, createPurchaseReturn, deletePurchase,
    addExpense, deleteExpense, processExchange,
    saveUser, toggleUserActive, deleteUser,
    setPermission, updateSettings, closeSession, logAudit, clearAudit,
    exportData, importData, resetData,
    connectivity, ready, backupMeta, runManualBackup, setAutoBackupHours,
    flushOfflineQueue, pendingQueueCount,
    saveUnit, deleteUnit, findUnitByCode,
    saveRepair, updateRepairStatus, deleteRepair,
    saveCategory, removeCategory, renameCategory, openSession, saveBrand, removeBrand,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePOS() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('usePOS must be used inside POSProvider');
  return ctx;
}
