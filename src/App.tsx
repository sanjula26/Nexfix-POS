import { lazy, Suspense, useEffect, useRef, useLayoutEffect } from 'react';
import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { POSProvider, usePOS } from './lib/store';
import { startSyncManager } from './lib/syncManager';
import { scheduleCloudSync, cancelScheduledCloudSync } from './lib/cloudSyncBridge';
import { signOutFromCloud } from './lib/cloudAuth';
import { SEED_HASH_ADMIN } from './lib/utils';
import { idbSaveState } from './lib/db';
import AppLayout from './components/AppLayout';
import ShopSwitcher from './components/ShopSwitcher';
import Login from './pages/Login';
import Signup from './pages/Signup';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const MobileDashboard = lazy(() => import('./pages/MobileDashboard'));
const POS = lazy(() => import('./pages/POS'));
const Inventory = lazy(() => import('./pages/Inventory'));
const Customers = lazy(() => import('./pages/Customers'));
const Suppliers = lazy(() => import('./pages/Suppliers'));
const SupplierPayments = lazy(() => import('./pages/SupplierPayments'));
const GRN = lazy(() => import('./pages/GRN'));
const GRNReport = lazy(() => import('./pages/GRNReport'));
const Purchases = lazy(() => import('./pages/Purchases'));
const PurchaseReturn = lazy(() => import('./pages/PurchaseReturn'));
const CSVImport = lazy(() => import('./pages/CSVImport'));
const SalesHistory = lazy(() => import('./pages/SalesHistory'));
const Exchanges = lazy(() => import('./pages/Exchanges'));
const Expenses = lazy(() => import('./pages/Expenses'));
const Reports = lazy(() => import('./pages/Reports'));
const PriceTags = lazy(() => import('./pages/PriceTags'));
const Users = lazy(() => import('./pages/Users'));
const CashierBalances = lazy(() => import('./pages/CashierBalances'));
const Permissions = lazy(() => import('./pages/Permissions'));
const AuditLog = lazy(() => import('./pages/AuditLog'));
const Settings = lazy(() => import('./pages/Settings'));
const Units = lazy(() => import('./pages/Units'));
const Repairs = lazy(() => import('./pages/Repairs'));
const Quotations = lazy(() => import('./pages/Quotations'));
const WarrantyClaims = lazy(() => import('./pages/WarrantyClaims'));
const Kits = lazy(() => import('./pages/Kits'));

function SyncBootstrap() { useEffect(() => startSyncManager(), []); return null; }

function SessionRecovery() {
  const { user, ready, state, exportData, importData } = usePOS();

  useLayoutEffect(() => {
    if (!ready || user) return;
    try {
      const DEFAULT_EMAIL = 'admin@nexfixsolution.com';
      const LEGACY_DEFAULT_EMAIL = 'admin@nexfix.lk';
      // v5 fixes the previous recovery race by durably saving the repaired state
      // before the page is reloaded. v4 could set its marker/session and reload
      // before React's debounced persistence ran, leaving IDB with the bad hash.
      const REPAIR_MARKER = 'nexfix_default_admin_v5';
      const repaired = localStorage.getItem(REPAIR_MARKER) === '1';

      if (!repaired) {
        const next = JSON.parse(exportData()) as typeof state;
        const existing = next.users.find(u => {
          const email = (u.email || '').trim().toLowerCase();
          return email === DEFAULT_EMAIL || email === LEGACY_DEFAULT_EMAIL;
        });
        const userId = existing?.id || 'u-admin';

        if (existing) {
          existing.email = DEFAULT_EMAIL;
          existing.password = SEED_HASH_ADMIN;
          existing.role = 'admin';
          existing.active = true;
          existing.name = existing.name || 'Shop Administrator';
        } else {
          next.users = [{
            id: userId,
            name: 'Shop Administrator',
            email: DEFAULT_EMAIL,
            password: SEED_HASH_ADMIN,
            role: 'admin',
            active: true,
            createdAt: new Date().toISOString(),
          }, ...next.users];
        }

        void (async () => {
          // Persist to the durable store first because POSProvider hydrates IDB
          // before it considers localStorage. This preserves all other data and
          // changes only the known default administrator account.
          const saved = await idbSaveState(next);
          if (!saved) return;
          try {
            localStorage.setItem('nexfix_pos_v2', JSON.stringify(next));
            localStorage.setItem(REPAIR_MARKER, '1');
            localStorage.setItem('nexfix_session_v1', JSON.stringify({ userId, remember: true }));
            sessionStorage.removeItem('nexfix_session_v1');
          } catch {
            // IDB is already repaired; browser-storage failures are non-fatal.
          }
          window.location.reload();
        })();
        return;
      }

      if (state.users.length === 0) {
        const next = JSON.parse(exportData()) as typeof state;
        const userId = 'u-admin';
        next.users = [{
          id: userId,
          name: 'Shop Administrator',
          email: DEFAULT_EMAIL,
          password: SEED_HASH_ADMIN,
          role: 'admin',
          active: true,
          createdAt: new Date().toISOString(),
        }, ...next.users];

        void (async () => {
          const saved = await idbSaveState(next);
          if (!saved) return;
          try {
            localStorage.setItem('nexfix_pos_v2', JSON.stringify(next));
            localStorage.setItem('nexfix_session_v1', JSON.stringify({ userId, remember: true }));
            sessionStorage.removeItem('nexfix_session_v1');
          } catch {
            // IDB is already repaired; browser-storage failures are non-fatal.
          }
          window.location.reload();
        })();
        return;
      }

      const sessionRaw = localStorage.getItem('nexfix_session_v1') || sessionStorage.getItem('nexfix_session_v1');
      const stateRaw = localStorage.getItem('nexfix_pos_v2');
      if (!sessionRaw || !stateRaw) return;

      const session = JSON.parse(sessionRaw) as { userId?: string };
      const snapshot = JSON.parse(stateRaw) as { users?: Array<{ id?: string; active?: boolean }> };
      const sessionUser = snapshot.users?.find(u => u.id === session.userId && u.active);
      if (sessionUser) importData(stateRaw);
    } catch {
      // Ignore malformed browser storage and keep the normal login flow.
    }
  }, [ready, user, state.users.length, exportData, importData]);

  return null;
}

function CloudAuthLifecycle() {
  const { user } = usePOS();
  const hadLocalSession = useRef(Boolean(user));
  useEffect(() => {
    if (user) { hadLocalSession.current = true; return; }
    if (hadLocalSession.current) { hadLocalSession.current = false; void signOutFromCloud(); }
  }, [user]);
  return null;
}

function SessionSecurity() {
  const { user, signOut } = usePOS();
  useEffect(() => {
    if (!user) return;
    const timeoutMs = 30 * 60 * 1000;
    const rememberMs = 30 * 24 * 60 * 60 * 1000;
    const startedKey = 'nexfix_session_started_v1';
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let startedAt = Date.now();
    try {
      const raw = localStorage.getItem(startedKey); const parsed = raw ? Number(raw) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) startedAt = parsed; else localStorage.setItem(startedKey, String(startedAt));
    } catch { /* ignore storage failures */ }
    if (Date.now() - startedAt >= rememberMs) { signOut(); return; }
    const arm = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(() => signOut(), timeoutMs); };
    const activityEvents = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel'];
    activityEvents.forEach(event => window.addEventListener(event, arm, { passive: true })); arm();
    const expiryTimer = setTimeout(() => signOut(), rememberMs - (Date.now() - startedAt));
    return () => { if (idleTimer) clearTimeout(idleTimer); clearTimeout(expiryTimer); activityEvents.forEach(event => window.removeEventListener(event, arm)); };
  }, [user, signOut]);
  useEffect(() => { if (!user) { try { localStorage.removeItem('nexfix_session_started_v1'); } catch { /* ignore storage failures */ } } }, [user]);
  return null;
}

function CloudSyncStateBridge() {
  const { state, ready } = usePOS(); const initial = useRef(true);
  useEffect(() => { if (!ready) return; if (initial.current) { initial.current = false; return; } scheduleCloudSync('state_change'); return cancelScheduledCloudSync; }, [state, ready]);
  return null;
}

function Protected() {
  const { user, ready } = usePOS(); const location = useLocation();
  if (!ready) return <RouteFallback />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <AppLayout />;
}
function Guard({ perm, adminOnly, children }: { perm?: string; adminOnly?: boolean; children: React.ReactNode }) { const { user, can } = usePOS(); if (!user) return null; if (adminOnly && user.role !== 'admin') return <Navigate to={can('page:pos') ? '/pos' : '/'} replace />; if (perm && !can(perm)) return <Navigate to={can('page:pos') ? '/pos' : '/'} replace />; return <>{children}</>; }
function RouteFallback() { return <div className="min-h-[40vh] grid place-items-center text-sm text-slate-500">Loading…</div>; }

export default function App() {
  return <POSProvider><SyncBootstrap /><SessionRecovery /><CloudAuthLifecycle /><SessionSecurity /><CloudSyncStateBridge /><ShopSwitcher /><HashRouter><Suspense fallback={<RouteFallback />}><Routes><Route path="/login" element={<Login />} /><Route path="/signup" element={<Signup />} /><Route element={<Protected />}><Route path="/" element={<Guard perm="page:dashboard"><Dashboard /></Guard>} /><Route path="/mobile" element={<Guard perm="page:dashboard"><MobileDashboard /></Guard>} /><Route path="/pos" element={<Guard perm="page:pos"><POS /></Guard>} /><Route path="/inventory" element={<Guard perm="page:inventory"><Inventory /></Guard>} /><Route path="/units" element={<Guard perm="page:units"><Units /></Guard>} /><Route path="/repairs" element={<Guard perm="page:repairs"><Repairs /></Guard>} /><Route path="/quotations" element={<Guard perm="page:pos"><Quotations /></Guard>} /><Route path="/kits" element={<Guard perm="page:inventory"><Kits /></Guard>} /><Route path="/warranty-claims" element={<Guard perm="page:repairs"><WarrantyClaims /></Guard>} /><Route path="/customers" element={<Guard perm="page:customers"><Customers /></Guard>} /><Route path="/suppliers" element={<Guard perm="page:suppliers"><Suppliers /></Guard>} /><Route path="/supplier-payments" element={<Guard perm="page:suppliers"><SupplierPayments /></Guard>} /><Route path="/purchases" element={<Guard perm="page:purchases"><Purchases /></Guard>} /><Route path="/grn" element={<Guard perm="page:purchases"><GRN /></Guard>} /><Route path="/grn-report" element={<Guard perm="page:purchases"><GRNReport /></Guard>} /><Route path="/purchase-return" element={<Guard perm="page:purchases"><PurchaseReturn /></Guard>} /><Route path="/csv-import" element={<Guard adminOnly><CSVImport /></Guard>} /><Route path="/sales" element={<Guard perm="page:sales"><SalesHistory /></Guard>} /><Route path="/exchanges" element={<Guard perm="page:exchanges"><Exchanges /></Guard>} /><Route path="/expenses" element={<Guard perm="page:expenses"><Expenses /></Guard>} /><Route path="/reports" element={<Guard perm="page:reports"><Reports /></Guard>} /><Route path="/price-tags" element={<Guard perm="page:pricetags"><PriceTags /></Guard>} /><Route path="/users" element={<Guard adminOnly><Users /></Guard>} /><Route path="/cashier-balances" element={<Guard adminOnly><CashierBalances /></Guard>} /><Route path="/permissions" element={<Guard adminOnly><Permissions /></Guard>} /><Route path="/settings" element={<Guard adminOnly><Settings /></Guard>} /></Route><Route path="*" element={<Navigate to="/" replace />} /></Routes></Suspense></HashRouter></POSProvider>;
}