import { lazy, Suspense, useEffect, useRef, type ReactNode } from 'react';
import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { POSProvider, usePOS } from './lib/store';
import { startSyncManager } from './lib/syncManager';
import { scheduleCloudSync, cancelScheduledCloudSync } from './lib/cloudSyncBridge';
import { signOutFromCloud } from './lib/cloudAuth';
import AppLayout from './components/AppLayout';
import Login from './pages/Login';
import Signup from './pages/Signup';
import ChangePassword from './pages/ChangePassword';

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
const MobileTodaySales = lazy(() => import('./pages/MobileTodaySales'));
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
const AuditLog = lazy(() => import('./pages/AuditLog'));

function CloudAuthLifecycle() {
  const { user } = usePOS();
  const hadLocalSession = useRef(Boolean(user));
  useEffect(() => {
    if (user) { hadLocalSession.current = true; return; }
    if (!hadLocalSession.current) return;
    hadLocalSession.current = false;
    void signOutFromCloud().catch(() => {});
  }, [user]);
  return null;
}

function SessionSecurity() {
  const { user, signOut } = usePOS();
  const previousUserId = useRef<string | null>(user?.id || null);
  useEffect(() => {
    if (!user) { previousUserId.current = null; return; }
    const freshLogin = previousUserId.current === null;
    previousUserId.current = user.id;
    const SESSION_STARTED = 'nexfix_session_started_v1';
    const IDLE_LIMIT = 30 * 60 * 1000;
    const REMEMBER_LIMIT = 30 * 24 * 60 * 60 * 1000;
    let startedAt = Number(localStorage.getItem(SESSION_STARTED) || 0);
    if (!startedAt || freshLogin) { startedAt = Date.now(); localStorage.setItem(SESSION_STARTED, String(startedAt)); }
    let idleTimer: number | undefined;
    let lastActivity = Date.now();
    const resetIdle = () => {
      lastActivity = Date.now();
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => { if (Date.now() - lastActivity >= IDLE_LIMIT) signOut(); }, IDLE_LIMIT);
    };
    const events = ['pointerdown', 'keydown', 'touchstart', 'mousemove', 'scroll'];
    events.forEach(event => window.addEventListener(event, resetIdle));
    resetIdle();
    // Never auto-signOut sooner than 5 minutes (avoids race right after login)
    const rememberTimer = window.setTimeout(() => signOut(), Math.max(5 * 60 * 1000, REMEMBER_LIMIT - Math.max(0, Date.now() - startedAt)));
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
    scheduleCloudSync();
    return () => cancelScheduledCloudSync();
  }, [state, user, connectivity]);
  return null;
}

function RouteFallback() {
  return <div className="min-h-screen grid place-items-center bg-[#f5f6fb] text-[#17133c] font-semibold">Loading…</div>;
}

function PermissionProtected({ permission, adminOnly, children }: { permission?: string; adminOnly?: boolean; children: ReactNode }) {
  const { user, can } = usePOS();
  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && user.role !== 'admin') return <Navigate to={can('page:dashboard') ? '/dashboard' : '/pos'} replace />;
  if (permission && !can(permission)) return <Navigate to={can('page:dashboard') ? '/dashboard' : '/pos'} replace />;
  return <>{children}</>;
}

function MobileSalesProtected() {
  const { user, ready, can } = usePOS();
  const location = useLocation();
  if (!ready) return <RouteFallback />;
  if (!user) { const next = `${location.pathname}${location.search}`; return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />; }
  if (user.mustChangePassword) return <Navigate to="/change-password" replace />;
  if (!can('page:sales')) return <Navigate to="/dashboard" replace />;
  return <MobileTodaySales />;
}

function Protected() {
  const { user, ready } = usePOS();
  const location = useLocation();
  if (!ready) return <RouteFallback />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.mustChangePassword && location.pathname !== '/change-password' && sessionStorage.getItem('nexfix_role_switch') !== '1') return <Navigate to="/change-password" replace />;
  return <AppLayout />;
}

function AppRoutes() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route element={<Protected />}>
          <Route path="/change-password" element={<ChangePassword />} />
        </Route>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/today" element={<MobileSalesProtected />} />
        <Route element={<Protected />}>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/mobile-dashboard" element={<MobileDashboard />} />
          <Route path="/pos" element={<POS />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/units" element={<Units />} />
          <Route path="/repairs" element={<Repairs />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/suppliers" element={<Suppliers />} />
          <Route path="/supplier-payments" element={<SupplierPayments />} />
          <Route path="/purchases" element={<Purchases />} />
          <Route path="/grn" element={<GRN />} />
          <Route path="/grn-report" element={<GRNReport />} />
          <Route path="/purchase-return" element={<PurchaseReturn />} />
          <Route path="/csv-import" element={<CSVImport />} />
          <Route path="/sales" element={<SalesHistory />} />
          <Route path="/exchanges" element={<Exchanges />} />
          <Route path="/expenses" element={<Expenses />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/price-tags" element={<PriceTags />} />
          <Route path="/quotations" element={<Quotations />} />
          <Route path="/warranty-claims" element={<PermissionProtected permission="page:repairs"><WarrantyClaims /></PermissionProtected>} />
          <Route path="/kits" element={<PermissionProtected permission="page:inventory"><Kits /></PermissionProtected>} />
          <Route path="/audit-log" element={<PermissionProtected adminOnly><AuditLog /></PermissionProtected>} />
          <Route path="/users" element={<Users />} />
          <Route path="/cashier-balances" element={<CashierBalances />} />
          <Route path="/permissions" element={<Permissions />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  useEffect(() => startSyncManager(), []);
  return (
    <POSProvider>
      <HashRouter>
        <CloudAuthLifecycle />
        <SessionSecurity />
        <CloudSyncStateBridge />
        <AppRoutes />
      </HashRouter>
    </POSProvider>
  );
}
