import { lazy, Suspense, useEffect, useRef } from 'react';
import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { POSProvider, usePOS } from './lib/store';
import { startSyncManager } from './lib/syncManager';
import { scheduleCloudSync, cancelScheduledCloudSync } from './lib/cloudSyncBridge';
import { signOutFromCloud } from './lib/cloudAuth';
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

function CloudAuthLifecycle() {
  const { user } = usePOS();
  const hadLocalSession = useRef(Boolean(user));

  useEffect(() => {
    if (user) {
      hadLocalSession.current = true;
      return;
    }
    if (hadLocalSession.current) {
      hadLocalSession.current = false;
      void signOutFromCloud();
    }
  }, [user]);

  return null;
}

/**
 * Defense-in-depth for unattended POS terminals. The local "Remember me"
 * session is capped at 30 days, and any active session is signed out after
 * 30 minutes without terminal activity. Cloud auth is cleared by the
 * CloudAuthLifecycle above when the local session ends.
 */
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
      const raw = localStorage.getItem(startedKey);
      const parsed = raw ? Number(raw) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) startedAt = parsed;
      else localStorage.setItem(startedKey, String(startedAt));
    } catch { /* ignore storage failures */ }

    if (Date.now() - startedAt >= rememberMs) {
      signOut();
      return;
    }

    const arm = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => signOut(), timeoutMs);
    };

    const activityEvents = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel'];
    activityEvents.forEach(event => window.addEventListener(event, arm, { passive: true }));
    arm();

    const remaining = rememberMs - (Date.now() - startedAt);
    const expiryTimer = setTimeout(() => signOut(), remaining);

    return () => {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(expiryTimer);
      activityEvents.forEach(event => window.removeEventListener(event, arm));
    };
  }, [user, signOut]);

  useEffect(() => {
    if (user) return;
    try { localStorage.removeItem('nexfix_session_started_v1'); } catch { /* ignore */ }
  }, [user]);

  return null;
}

function CloudSyncStateBridge() {
  const { state, ready } = usePOS();
  const initial = useRef(true);

  useEffect(() => {
    if (!ready) return;
    if (initial.current) {
      initial.current = false;
      return;
    }
    scheduleCloudSync('state_change');
    return cancelScheduledCloudSync;
  }, [state, ready]);

  return null;
}

function Protected() { const { user } = usePOS(); const location = useLocation(); if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />; return <AppLayout />; }
function Guard({ perm, adminOnly, children }: { perm?: string; adminOnly?: boolean; children: React.ReactNode }) { const { user, can } = usePOS(); if (!user) return null; if (adminOnly && user.role !== 'admin') return <Navigate to={can('page:pos') ? '/pos' : '/'} replace />; if (perm && !can(perm)) return <Navigate to={can('page:pos') ? '/pos' : '/'} replace />; return <>{children}</>; }

function RouteFallback() {
  return <div className="min-h-[40vh] grid place-items-center text-sm text-slate-500">Loading…</div>;
}

export default function App() {
  return <POSProvider><SyncBootstrap /><CloudAuthLifecycle /><SessionSecurity /><CloudSyncStateBridge /><ShopSwitcher /><HashRouter><Suspense fallback={<RouteFallback />}><Routes><Route path="/login" element={<Login />} /><Route path="/signup" element={<Signup />} /><Route element={<Protected />}><Route path="/" element={<Guard perm="page:dashboard"><Dashboard /></Guard>} /><Route path="/mobile" element={<Guard perm="page:dashboard"><MobileDashboard /></Guard>} /><Route path="/pos" element={<Guard perm="page:pos"><POS /></Guard>} /><Route path="/inventory" element={<Guard perm="page:inventory"><Inventory /></Guard>} /><Route path="/units" element={<Guard perm="page:units"><Units /></Guard>} /><Route path="/repairs" element={<Guard perm="page:repairs"><Repairs /></Guard>} /><Route path="/quotations" element={<Guard perm="page:pos"><Quotations /></Guard>} /><Route path="/kits" element={<Guard perm="page:inventory"><Kits /></Guard>} /><Route path="/warranty-claims" element={<Guard perm="page:repairs"><WarrantyClaims /></Guard>} /><Route path="/customers" element={<Guard perm="page:customers"><Customers /></Guard>} /><Route path="/suppliers" element={<Guard perm="page:suppliers"><Suppliers /></Guard>} /><Route path="/supplier-payments" element={<Guard perm="page:suppliers"><SupplierPayments /></Guard>} /><Route path="/purchases" element={<Guard perm="page:purchases"><Purchases /></Guard>} /><Route path="/grn" element={<Guard perm="page:purchases"><GRN /></Guard>} /><Route path="/grn-report" element={<Guard perm="page:purchases"><GRNReport /></Guard>} /><Route path="/purchase-return" element={<Guard perm="page:purchases"><PurchaseReturn /></Guard>} /><Route path="/csv-import" element={<Guard adminOnly><CSVImport /></Guard>} /><Route path="/sales" element={<Guard perm="page:sales"><SalesHistory /></Guard>} /><Route path="/exchanges" element={<Guard perm="page:exchanges"><Exchanges /></Guard>} /><Route path="/expenses" element={<Guard perm="page:expenses"><Expenses /></Guard>} /><Route path="/reports" element={<Guard perm="page:reports"><Reports /></Guard>} /><Route path="/price-tags" element={<Guard perm="page:pricetags"><PriceTags /></Guard>} /><Route path="/users" element={<Guard adminOnly><Users /></Guard>} /><Route path="/cashier-balances" element={<Guard adminOnly><CashierBalances /></Guard>} /><Route path="/permissions" element={<Guard adminOnly><Permissions /></Guard>} /><Route path="/audit-log" element={<Guard adminOnly><AuditLog /></Guard>} /><Route path="/settings" element={<Guard adminOnly><Settings /></Guard>} /></Route><Route path="*" element={<Navigate to="/" replace />} /></Routes></Suspense></HashRouter></POSProvider>;
}
