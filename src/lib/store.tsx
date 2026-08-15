import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  POSState, Product, Customer, Supplier, Sale, Purchase, Expense, Exchange,
  AppUser, AuditEntry, HeldSale, Settings, Role, SaleItem, PaymentMethod, PaymentLeg, DaySession,
  InventoryUnit, RepairJob, RepairStatus,
} from './types';
import { buildSeed, DEFAULT_CATEGORIES, DEFAULT_BRANDS } from './seed';
import { dkey, uid, POINT_VALUE, pointsForRs, hashPin, hashPassword, verifyPassword, isHashed } from './utils';
import { idbLoadState, idbSaveState, idbAvailable, idbGetMeta, idbSetMeta, type BackupMeta } from './db';
import { downloadBackup, startAutoBackup } from './backup';
import {
  getConnectivity, onConnectivityChange, queueWrite, flushSyncQueue, registerServiceWorker,
  type Connectivity,
} from './offline';
import { syncToGoogleDrive } from './driveSync';

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
  signIn: (email: string, password: string, remember: boolean) => { ok: boolean; error?: string };
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
  deletePurchase: (id: string) => void;
  // expenses
  addExpense: (e: Omit<Expense, 'id' | 'date' | 'by'>) => void;
  deleteExpense: (id: string) => void;
  // exchanges
  processExchange: (saleId: string, itemIdx: number[], reason: string, mode: 'refund' | 'replace') => void;
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
  saveBrand: (name: string) => void;
  removeBrand: (name: string) => void;
}

const Ctx = createContext<StoreCtx | null>(null);

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
    },
    kitItems: s.kitItems || [],
    quotations: s.quotations || [],
    warrantyClaims: s.warrantyClaims || [],
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
        if (!cancelled) setBackupMeta(meta);
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
    }, 250);
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, [state, ready]);

  // Connectivity listeners + auto-flush queue when back online
  useEffect(() => {
    const unsub = onConnectivityChange(async (status) => {
      setConnectivity(status);
      if (status === 'online') {
        const { flushed } = await flushSyncQueue();
        setPendingQueueCount(0);
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

  const signIn = useCallback((email: string, password: string, remember: boolean) => {
    const u = state.users.find(x => x.email.toLowerCase() === email.trim().toLowerCase());
    if (!u) return { ok: false, error: 'No account found for this email' };
    // Support both hashed (new) and legacy plaintext during transition
    const passwordOk = isHashed(u.password)
      ? verifyPassword(password, u.password)
      : u.password === password;
    if (!passwordOk) return { ok: false, error: 'Incorrect password' };
    if (!u.active) return { ok: false, error: 'This account has been deactivated' };
    const sess = { userId: u.id, remember };
    setSession(sess);
    try {
      if (remember) localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
      else sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess));
    } catch { /* ignore */ }
    // Auto-upgrade plaintext password to hash on successful login
    if (!isHashed(u.password)) {
      setState(s => ({
        ...s,
        users: s.users.map(x => x.id === u.id ? { ...x, password: hashPassword(password) } : x),
        audit: [{ id: uid(), time: new Date().toISOString(), user: u.email, action: 'LOGIN', entity: 'Auth', details: `${u.name} signed in` }, ...s.audit].slice(0, 500),
      }));
    } else {
      setState(s => ({
        ...s,
        audit: [{ id: uid(), time: new Date().toISOString(), user: u.email, action: 'LOGIN', entity: 'Auth', details: `${u.name} signed in` }, ...s.audit].slice(0, 500),
      }));
    }
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
    setState(s => {
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
  }, [pushAudit, state.suppliers]);

  /* ---------------- sales ---------------- */
  const completeSale = useCallback((input: NewSaleInput): Sale | null => {
    if (!user || input.lines.length === 0) return null;
    const s = state;
    const items: SaleItem[] = [];
    const soldUnitIds: string[] = [];
    for (const l of input.lines) {
      const p = s.products.find(x => x.id === l.productId);
      if (!p) return null;
      // Hard block selling more than available stock
      if (l.qty <= 0 || l.qty > p.stock) return null;
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
        warrantyMonths: p.warrantyMonths,
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
    const profit = items.reduce((sum, it) => sum + (it.price - it.cost) * it.qty, 0)
      - lineDiscount - discount + shipping;
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
    const sale: Sale = {
      id: uid(), billNo, date: new Date().toISOString(),
      cashierId: byUser.id, cashierName: byUser.name,
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

    const updatedProducts = s.products.map(p => {
      const line = input.lines.find(l => l.productId === p.id);
      return line ? { ...p, stock: Math.max(0, p.stock - line.qty) } : p;
    });

    setState(prev => ({
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
    setState(s => ({
      ...s,
      sales: s.sales.map(x => (x.id === saleId ? { ...x, status: 'refunded' } : x)),
      products: s.products.map(p => {
        const it = sale.items.find(i => i.productId === p.id);
        return it ? { ...p, stock: p.stock + it.qty } : p;
      }),
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
    if (!po || po.status === 'received') return;
    setState(s => ({
      ...s,
      purchases: s.purchases.map(x => (x.id === id ? { ...x, status: 'received' } : x)),
      products: s.products.map(p => {
        const it = po.items.find(i => i.productId === p.id);
        return it ? { ...p, stock: p.stock + it.qty, cost: it.cost } : p;
      }),
    }));
    pushAudit('RECEIVE', 'Purchase', `Received ${po.poNo} from ${po.supplierName}`);
  }, [state.purchases, pushAudit]);

  const deletePurchase = useCallback((id: string) => {
    const po = state.purchases.find(x => x.id === id);
    if (!po) return;
    setState(s => {
      // If PO was already received, reverse the stock that was added
      let products = s.products;
      if (po.status === 'received') {
        products = s.products.map(p => {
          const it = po.items.find(i => i.productId === p.id);
          return it ? { ...p, stock: Math.max(0, p.stock - it.qty) } : p;
        });
      }
      return { ...s, purchases: s.purchases.filter(x => x.id !== id), products };
    });
    pushAudit('DELETE', 'Purchase', `Deleted ${po.poNo}${po.status === 'received' ? ' · stock reversed' : ''}`);
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
  const processExchange = useCallback((saleId: string, itemIdx: number[], reason: string, mode: 'refund' | 'replace') => {
    const sale = state.sales.find(x => x.id === saleId);
    if (!sale || itemIdx.length === 0) return;
    setState(s => {
      const exItems = itemIdx.map(i => {
        const it = sale.items[i];
        return { productId: it.productId, name: it.name, qty: it.qty, amount: it.price * it.qty - (it.discount || 0) };
      });
      const refund = mode === 'refund' ? exItems.reduce((sum, i) => sum + i.amount, 0) : 0;
      const seq = s.counters.ex + 1;
      const ex: Exchange = {
        id: uid(), exNo: `EX-${String(seq).padStart(4, '0')}`, date: new Date().toISOString(),
        billNo: sale.billNo, customerName: sale.customerName, reason,
        items: exItems, refund, additional: 0, by: user?.name || 'Unknown',
      };
      return {
        ...s,
        exchanges: [ex, ...s.exchanges],
        counters: { ...s.counters, ex: seq },
        sales: s.sales.map(x => (x.id === saleId ? { ...x, status: 'exchanged' } : x)),
        // Both refund and replace restock the returned items
        products: s.products.map(p => {
          const it = exItems.find(i => i.productId === p.id);
          return it ? { ...p, stock: p.stock + it.qty } : p;
        }),
      };
    });
    pushAudit('EXCHANGE', 'Exchange', `${mode === 'refund' ? 'Returned' : 'Exchanged'} ${itemIdx.length} item(s) on ${sale.billNo}`);
  }, [state.sales, pushAudit, user?.name]);

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
    const { flushed } = await flushSyncQueue();
    setPendingQueueCount(0);
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
    savePurchase, receivePurchase, deletePurchase,
    addExpense, deleteExpense, processExchange,
    saveUser, toggleUserActive, deleteUser,
    setPermission, updateSettings, closeSession, logAudit, clearAudit,
    exportData, importData, resetData,
    connectivity, ready, backupMeta, runManualBackup, setAutoBackupHours,
    flushOfflineQueue, pendingQueueCount,
    saveUnit, deleteUnit, findUnitByCode,
    saveRepair, updateRepairStatus, deleteRepair,
    saveCategory, removeCategory, saveBrand, removeBrand,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePOS() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('usePOS must be used inside POSProvider');
  return ctx;
}
