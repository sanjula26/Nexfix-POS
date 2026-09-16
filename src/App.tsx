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
const Settings = lazy(() => import('./pages/Settings'));
const Units = lazy(() => import('./pages/Units'));
const Repairs = lazy(() => import('./pages/Repairs'));
const Quotations = lazy(() => import('./pages/Quotations'));
const WarrantyClaims = lazy(() => import('./pages/WarrantyClaims'));
const Kits = lazy(() => import('./pages/Kits'));

function SyncBootstrap() { useEffect(() => startSyncManager(), []); return null; }

function KioskSessionBootstrap() {
  const { user, ready, switchRole } = usePOS();
  const attempted = useRef(false);
  useEffect(() => {
    if (!ready || user || attempted.current) return;
    const hash = window.location.hash.split('?')[0];
    if (hash === '#/login' || hash === '#/signup') return;
    attempted.current = true;
    const result = switchRole('cashier');
    if (!result.ok) attempted.current = false;
  }, [ready, user, switchRole]);
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
  const previousUserId = useRef<string | null>(user?.id ?? null);
  useEffect(() => {
    if (!user) {
      previousUserId.current = null;
      return;
    }
    const timeoutMs = 30 * 60 * 1000;
    const rememberMs = 30 * 24 * 60 * 60 * 1000;
    const startedKey = 'nexfix_session_started_v1';
    const freshLogin = previousUserId.current === null;
    previousUserId.current = user.id;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let startedAt = Date.now();
    try {
      const raw = localStorage.getItem(startedKey);
      if (freshLogin) {
        localStorage.setItem(startedKey, String(Date.now()));
      } else if (raw) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) startedAt = parsed;
      }
    } catch { /* ignore */ }
    if (freshLogin) startedAt = Date.now();
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => signOut(), timeoutMs);
    };
    const events = ['pointerdown', 'keydown', 'touchstart', 'mousemove'];
    events.forEach(event => window.addEventListener(event, resetIdle));
    resetIdle();
    const rememberTimer = window.setTimeout(() => signOut(), Math.max(1000, rememberMs - Math.max(0, Date.now() - startedAt)));
    return () => {
      if (idleTimer) clearTimeout(idleTimer);
      window.clearTimeout(rememberTimer);
      events.forEach(event => window.removeEventListener(event, resetIdle));
    };
  }, [user, signOut]);
  return null;
}

function CloudSyncStateBridge() {
  const { state, user, connectivity } = usePOS();
  useEffect(() => {
    if (!user || connectivity !== 'online') return;
    scheduleCloudSync(state, user).catch(() => {});
    return () => cancelScheduledCloudSync();
  }, [state, user, connectivity]);
  return null;
}

function RouteFallback() {
  return <div className="min-h-screen grid place-items-center bg-[#f5f6fb] text-[#17133c] font-semibold">Loading…</div>;
}

function Protected() {
  const { user, ready } = usePOS(); const location = useLocation();
  if (!ready) return <RouteFallback />;
  if (!user) return <RouteFallback />;
  return <AppLayout />;
}

function AppRoutes() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route element={<Protected />}>
          <Route path="/" element={<Navigate to="/pos" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/mobile-dashboard" element={<MobileDashboard />} />
          <Route path="/pos" element={<POS />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/suppliers" element={<Suppliers />} />
          <Route path="/supplier-payments" element={<SupplierPayments />} />
          <Route path="/purchases" element={<Purchases />} />
          <Route path="/purchase-return" element={<PurchaseReturn />} />
          <Route path="/grn" element={<GRN />} />
          <Route path="/grn-report" element={<GRNReport />} />
          <Route path="/csv-import" element={<CSVImport />} />
          <Route path="/sales" element={<SalesHistory />} />
          <Route path="/exchanges" element={<Exchanges />} />
          <Route path="/expenses" element={<Expenses />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/pricetags" element={<PriceTags />} />
          <Route path="/users" element={<Users />} />
          <Route path="/cashier-balances" element={<CashierBalances />} />
          <Route path="/permissions" element={<Permissions />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/units" element={<Units />} />
          <Route path="/repairs" element={<Repairs />} />
          <Route path="/quotations" element={<Quotations />} />
          <Route path="/warranty-claims" element={<WarrantyClaims />} />
          <Route path="/kits" element={<Kits />} />
          <Route path="*" element={<Navigate to="/pos" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <POSProvider>
      <HashRouter>
        <SyncBootstrap />
        <KioskSessionBootstrap />
        <CloudAuthLifecycle />
        <SessionSecurity />
        <CloudSyncStateBridge />
        <ShopSwitcher />
        <AppRoutes />
      </HashRouter>
    </POSProvider>
  );
}
