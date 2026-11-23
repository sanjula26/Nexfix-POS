import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { buildCreditSettlementSyncFingerprint } from './lib/creditSettlementSyncFingerprint';
import { buildNormalizedCatalogSyncFingerprint } from './lib/cloudSyncFingerprint';
import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AlertTriangle, Download, Loader2, Sparkles } from 'lucide-react';
import { setDesktopProfilePrimary } from './lib/db';
import {
  discoverDesktopPOSProfiles,
  getDesktopPOSMigrationJournal,
  getDesktopPOSProfileStatus,
  readDesktopProfilePayload,
  transitionDesktopPOSStorageMigration,
  unlockDesktopPOSProfileWithOS,
  unlockDesktopPOSProfileWithPassphrase,
  unlockDesktopPOSProfileWithRecoveryKey,
  type DesktopPOSMigrationPurpose,
} from './lib/desktopProfileStorage';
import { POSProvider, usePOS } from './lib/store';
import { startSyncManager } from './lib/syncManager';
import { scheduleCloudSync, cancelScheduledCloudSync } from './lib/cloudSyncBridge';
import { syncNormalizedCatalog } from './lib/cloudSync';
import { refreshDesktopUpdaterCredentials } from './lib/cloudAuth';
import AppLayout from './components/AppLayout';
import Login from './pages/Login';
import ChangePassword from './pages/ChangePassword';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const MobileDashboard = lazy(() => import('./pages/MobileDashboard'));
const POS = lazy(() => import('./pages/POS'));
const Inventory = lazy(() => import('./pages/Inventory'));
const Customers = lazy(() => import('./pages/Customers'));
const Suppliers = lazy(() => import('./pages/Suppliers'));
const SupplierPayments = lazy(() => import('./pages/SupplierPayments'));
const CreditSettle = lazy(() => import('./pages/CreditSettle'));
const CreditStatements = lazy(() => import('./pages/CreditStatements'));
const GRN = lazy(() => import('./pages/GRN'));
const GRNReport = lazy(() => import('./pages/GRNReport'));
const Purchases = lazy(() => import('./pages/Purchases'));
const PurchaseReturn = lazy(() => import('./pages/PurchaseReturn'));
const CSVImport = lazy(() => import('./pages/CSVImport'));
const SalesHistory = lazy(() => import('./pages/SalesHistory'));
const MobileTodaySales = lazy(() => import('./pages/MobileTodaySales'));
const TodaySalesLinks = lazy(() => import('./pages/TodaySalesLinks'));
const Exchanges = lazy(() => import('./pages/Exchanges'));
const Expenses = lazy(() => import('./pages/Expenses'));
const Reports = lazy(() => import('./pages/Reports'));
const SalesmanCommission = lazy(() => import('./pages/SalesmanCommission'));
const LowStockSuggestions = lazy(() => import('./pages/LowStockSuggestions'));
const PriceTags = lazy(() => import('./pages/PriceTags'));
const Users = lazy(() => import('./pages/Users'));
const CashierBalances = lazy(() => import('./pages/CashierBalances'));
const DayCloseReport = lazy(() => import('./pages/DayCloseReport'));
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
  useEffect(() => {
    if (!user) return;
    // Local POS authentication is independent from the one-time cloud account
    // session. Keep the cloud session across local cashier/admin logout and
    // app restarts; explicit Cloud sign-out in Settings remains the sign-out path.
    // Updater authorization belongs to this physical PC, not the local role.
    void refreshDesktopUpdaterCredentials().catch(() => {});
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
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Do not upload the entire POSState after every local mutation. The legacy
  // snapshot contains sales, products, customers, units, repairs and settings,
  // so syncing it on every product/customer/stock edit can consume the
  // Supabase Free-plan egress quota quickly. Normalized sales/GRN/return
  // operations are already cloud-authoritative; keep the snapshot for the
  // meaningful transaction boundaries that mobile/legacy views need.
  const cloudSnapshotTrigger = useMemo(() => JSON.stringify({
    sales: state.sales.map(s => [s.id, s.status, s.date, s.total]),
    purchases: state.purchases.map(p => [p.id, p.status, p.date]),
    repairs: state.repairs.map(r => [r.id, r.status, r.receivedAt, r.completedAt, r.deliveredAt]),
    // Catalog metadata is also a cloud dependency for cashier sales. Track
    // these fields so admin/manager edits are reconciled before another POS
    // machine tries to transact against the normalized catalog.
    products: state.products.map(p => [p.id, p.name, p.sku, p.barcode, p.cost, p.price, p.reorderLevel, p.trackImei, p.trackSerial, p.trackExpiry, p.warrantyMonths, p.isKit, p.isService, p.active, p.supplierId]),
    creditSettlement: buildCreditSettlementSyncFingerprint(state.customers, state.customerCreditPayments || []),
    suppliers: state.suppliers.map(s => [s.id, s.name, s.contactPerson, s.phone, s.email, s.address]),
    kits: (state.kitItems || []).map(k => [k.id, k.kitProductId, k.componentProductId, k.qty]),
    units: (state.units || []).map(u => [u.id, u.productId, u.imei, u.serial, u.expiryDate, u.status, u.cost]),
  }), [state.sales, state.purchases, state.repairs, state.products, state.customers, state.customerCreditPayments, state.suppliers, state.kitItems, state.units]);

  const catalogSyncTrigger = useMemo(
    () => buildNormalizedCatalogSyncFingerprint(state),
    [state.products, state.customers, state.suppliers, state.kitItems, state.settings.branchId],
  );
  const lastCatalogSyncKeyRef = useRef<string | null>(null);
  const inFlightCatalogSyncKeyRef = useRef<string | null>(null);
  const userId = user?.id;
  const userRole = user?.role;

  // Snapshot writes are reserved for transaction/history boundaries. Catalog
  // reconciliation has its own narrower trigger below so a sale, credit
  // settlement, repair status change, or stock-only change cannot re-upload
  // every product/customer/supplier row.
  useEffect(() => {
    if (!userId || connectivity !== 'online') {
      cancelScheduledCloudSync();
      return;
    }
    scheduleCloudSync();
    return () => cancelScheduledCloudSync();
  }, [cloudSnapshotTrigger, userId, connectivity]);

  useEffect(() => {
    if (!userId || (userRole !== 'admin' && userRole !== 'manager') || connectivity !== 'online') {
      lastCatalogSyncKeyRef.current = null;
      return;
    }
    const syncKey = `${userId}:${catalogSyncTrigger}`;
    if (lastCatalogSyncKeyRef.current === syncKey) return;

    let cancelled = false;
    let timer: number | undefined;
    let attempts = 0;
    const runCatalogSync = async () => {
      if (cancelled || lastCatalogSyncKeyRef.current === syncKey) return;
      // Serialize catalog reconciliations. If another fingerprint is being
      // reconciled, wait briefly rather than racing an older state over it.
      if (inFlightCatalogSyncKeyRef.current) {
        timer = window.setTimeout(() => void runCatalogSync(), 250);
        return;
      }

      inFlightCatalogSyncKeyRef.current = syncKey;
      let succeeded = false;
      try {
        const result = await syncNormalizedCatalog(stateRef.current);
        succeeded = result.ok;
      } catch {
        // A rejected network request is handled by the same bounded retry path.
      } finally {
        if (inFlightCatalogSyncKeyRef.current === syncKey) {
          inFlightCatalogSyncKeyRef.current = null;
        }
      }

      if (succeeded) {
        // A completed sync is valid for this user/fingerprint even if a
        // render cleanup happened while the request was in flight.
        lastCatalogSyncKeyRef.current = syncKey;
        return;
      }
      if (cancelled) return;

      attempts += 1;
      if (attempts < 3) {
        timer = window.setTimeout(() => void runCatalogSync(), 2000 * 2 ** (attempts - 1));
      }
    };

    timer = window.setTimeout(() => void runCatalogSync(), 500);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [catalogSyncTrigger, userId, userRole, connectivity]);

  return null;
}

function RouteFallback() {
  return <div className="min-h-screen grid place-items-center bg-[#f5f6fb] text-[#17133c] font-semibold">Loading…</div>;
}

function DesktopUpdateNotice() {
  const { user } = usePOS();
  const [update, setUpdate] = useState<{status:'hidden'|'available'|'downloading'|'downloaded'|'error';version?:string;percent?:number;message?:string}>({status:'hidden'});
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string>(() => {
    try { return sessionStorage.getItem('nexfix_dismissed_update_version') || ''; } catch { return ''; }
  });
  const desktopApi = useMemo(() => (window as Window & {
    nexfixDesktop?: {
      isPackaged?: boolean;
      isPortable?: boolean;
      getUpdateStatus?: () => Promise<{supported?:boolean;authorized?:boolean;available?:boolean;version?:string|null;downloading?:boolean}>;
      checkForUpdates?: () => Promise<{supported?:boolean;available?:boolean;version?:string|null;error?:string}>;
      downloadAndInstallUpdate?: () => Promise<{supported?:boolean;started?:boolean;error?:string}>;
      onUpdateEvent?: (listener:(event:{type:string;version?:string;percent?:number;message?:string})=>void)=>()=>void;
    };
  }).nexfixDesktop, []);

  useEffect(() => {
    if (!user || !desktopApi?.isPackaged) {
      setUpdate({status:'hidden'});
      return;
    }
    let alive = true;
    const apply = (event:{type:string;version?:string;percent?:number;message?:string}) => {
      if (!alive) return;
      if (event.type === 'available') {
        const version = event.version || '';
        if (version && version === dismissedUpdateVersion) return;
        setUpdate({status:'available',version});
      }
      else if (event.type === 'progress') setUpdate({status:'downloading',percent:Math.max(0,Math.min(100,Number(event.percent||0)))});
      else if (event.type === 'downloaded') setUpdate({status:'downloaded',version:event.version});
      else if (event.type === 'error') setUpdate({status:'error',message:event.message || 'The update service could not be reached.'});
      else if (event.type === 'not-available') setUpdate({status:'hidden'});
    };
    const unsubscribe = desktopApi.onUpdateEvent?.(apply);
    void desktopApi.getUpdateStatus?.().then(status => {
      if (!alive || !status?.available) return;
      const version = status.version || '';
      if (version && version === dismissedUpdateVersion) return;
      setUpdate({status:'available',version:version || undefined});
    }).catch(() => {});
    // CloudAuthLifecycle restores/loads the one-time device updater credential
    // before the main process performs its authorized check. Do not race that
    // async provisioning with a credential-less check from this component.
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [user, desktopApi, dismissedUpdateVersion]);

  if (!user || !desktopApi?.isPackaged || update.status === 'hidden') return null;

  const dismissUpdate = () => {
    const version = update.version || '';
    if (version) {
      setDismissedUpdateVersion(version);
      try { sessionStorage.setItem('nexfix_dismissed_update_version', version); } catch { /* optional */ }
    }
    setUpdate({status:'hidden'});
  };

  const updateNow = async () => {
    if (desktopApi.isPortable) {
      setUpdate({status:'error',message:'Updates require the installed Setup edition.'});
      return;
    }
    setUpdate(current => ({...current,status:'downloading',percent:0}));
    const result = await desktopApi.downloadAndInstallUpdate?.();
    if (result?.error) setUpdate({status:'error',message:result.error});
  };

  return (
    <div className="fixed right-4 top-4 z-[200] w-[min(420px,calc(100vw-2rem))]">
      <div className="overflow-hidden rounded-2xl border border-cyan-400/35 bg-white/95 shadow-[0_18px_60px_rgba(2,8,23,0.20)] backdrop-blur-xl dark:border-cyan-300/25 dark:bg-[#071225]/95 dark:shadow-[0_18px_60px_rgba(2,8,23,0.60)]">
        <div className="h-1 bg-gradient-to-r from-cyan-400 via-sky-500 to-indigo-500" />
        <div className="p-4">
          {update.status === 'available' && (
            <>
              <div className="flex items-start gap-3">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-cyan-500/10 text-cyan-600 dark:text-cyan-300"><Sparkles size={18} /></div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-black text-[#17133c] dark:text-white">New Nexfix POS update available</p>
                  <p className="mt-1 text-xs text-[#6f7391] dark:text-slate-400">Version {update.version || 'new'} is ready. Update now to keep this POS current.</p>
                </div>
                <button type="button" onClick={dismissUpdate} aria-label="Close update notification" title="Close" className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white">
                  ×
                </button>
              </div>
              <button type="button" onClick={() => void updateNow()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-400 via-sky-500 to-indigo-500 py-2.5 text-xs font-extrabold text-white shadow-[0_10px_24px_rgba(14,165,233,0.22)] transition hover:brightness-110">
                <Download size={15} /> Update now
              </button>
            </>
          )}
          {update.status === 'downloading' && (
            <div>
              <div className="flex items-center gap-2 text-sm font-black text-[#17133c] dark:text-white"><Loader2 size={16} className="animate-spin text-cyan-500" /> Updating Nexfix POS…</div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-sky-500 to-indigo-500 transition-all" style={{width:`${update.percent || 0}%`}} /></div>
              <p className="mt-1 text-right text-[11px] font-bold text-slate-500 dark:text-slate-400">{Math.round(update.percent || 0)}%</p>
            </div>
          )}
          {update.status === 'downloaded' && (
            <div className="flex items-center gap-2 text-sm font-black text-[#17133c] dark:text-white"><Loader2 size={16} className="animate-spin text-cyan-500" /> Update downloaded. Restarting…</div>
          )}
          {update.status === 'error' && (
            <div className="flex items-start gap-2.5">
              <AlertTriangle size={17} className="mt-0.5 shrink-0 text-amber-500" />
              <div><p className="text-sm font-bold text-[#17133c] dark:text-white">Update check needs attention</p><p className="mt-1 text-xs text-[#6f7391] dark:text-slate-400">{update.message}</p></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PermissionDenied() {
  return (
    <div className="min-h-screen grid place-items-center bg-[#f5f6fb] text-[#17133c] p-6">
      <div className="card max-w-md w-full p-6 text-center">
        <h1 className="text-lg font-extrabold">Access denied</h1>
        <p className="text-sm text-sub mt-2">Your account does not have permission to open this page.</p>
      </div>
    </div>
  );
}

function PermissionProtected({ permission, adminOnly, children }: { permission?: string; adminOnly?: boolean; children: ReactNode }) {
  const { user, can } = usePOS();
  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && user.role !== 'admin') {
    if (can('page:dashboard')) return <Navigate to="/dashboard" replace />;
    if (can('page:pos')) return <Navigate to="/pos" replace />;
    return <PermissionDenied />;
  }
  if (permission && !can(permission)) {
    if (can('page:dashboard')) return <Navigate to="/dashboard" replace />;
    if (can('page:pos')) return <Navigate to="/pos" replace />;
    return <PermissionDenied />;
  }
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
  if (user.mustChangePassword && location.pathname !== '/change-password') return <Navigate to="/change-password" replace />;
  return <AppLayout />;
}

function AppRoutes() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<Protected />}>
          <Route path="/change-password" element={<ChangePassword />} />
        </Route>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/today" element={<MobileSalesProtected />} />
        <Route path="/today-links" element={<PermissionProtected adminOnly><TodaySalesLinks /></PermissionProtected>} />
        <Route element={<Protected />}>
          <Route path="/dashboard" element={<PermissionProtected permission="page:dashboard"><Dashboard /></PermissionProtected>} />
          <Route path="/mobile-dashboard" element={<PermissionProtected permission="page:dashboard"><MobileDashboard /></PermissionProtected>} />
          <Route path="/pos" element={<PermissionProtected permission="page:pos"><POS /></PermissionProtected>} />
          <Route path="/inventory" element={<PermissionProtected permission="page:inventory"><Inventory /></PermissionProtected>} />
          <Route path="/units" element={<PermissionProtected permission="page:units"><Units /></PermissionProtected>} />
          <Route path="/repairs" element={<PermissionProtected permission="page:repairs"><Repairs /></PermissionProtected>} />
          <Route path="/customers" element={<PermissionProtected permission="page:customers"><Customers /></PermissionProtected>} />
          <Route path="/suppliers" element={<PermissionProtected permission="page:suppliers"><Suppliers /></PermissionProtected>} />
          <Route path="/supplier-payments" element={<PermissionProtected permission="page:suppliers"><SupplierPayments /></PermissionProtected>} />
          <Route path="/credit-settle" element={<PermissionProtected permission="page:customers"><CreditSettle /></PermissionProtected>} />
          <Route path="/credit-statements" element={<PermissionProtected permission="page:customers"><CreditStatements /></PermissionProtected>} />
          <Route path="/purchases" element={<PermissionProtected permission="page:purchases"><Purchases /></PermissionProtected>} />
          <Route path="/grn" element={<PermissionProtected permission="page:purchases"><GRN /></PermissionProtected>} />
          <Route path="/grn-report" element={<PermissionProtected permission="page:purchases"><GRNReport /></PermissionProtected>} />
          <Route path="/purchase-return" element={<PermissionProtected permission="page:purchases"><PurchaseReturn /></PermissionProtected>} />
          <Route path="/csv-import" element={<PermissionProtected adminOnly><CSVImport /></PermissionProtected>} />
          <Route path="/sales" element={<PermissionProtected permission="page:sales"><SalesHistory /></PermissionProtected>} />
          <Route path="/exchanges" element={<PermissionProtected permission="page:exchanges"><Exchanges /></PermissionProtected>} />
          <Route path="/expenses" element={<PermissionProtected permission="page:expenses"><Expenses /></PermissionProtected>} />
          <Route path="/reports" element={<PermissionProtected permission="page:reports"><Reports /></PermissionProtected>} />
          <Route path="/salesman-commission" element={<PermissionProtected permission="page:reports"><SalesmanCommission /></PermissionProtected>} />
          <Route path="/low-stock" element={<PermissionProtected permission="page:reports"><LowStockSuggestions /></PermissionProtected>} />
          <Route path="/price-tags" element={<PermissionProtected permission="page:pricetags"><PriceTags /></PermissionProtected>} />
          <Route path="/quotations" element={<PermissionProtected permission="page:pos"><Quotations /></PermissionProtected>} />
          <Route path="/warranty-claims" element={<PermissionProtected permission="page:repairs"><WarrantyClaims /></PermissionProtected>} />
          <Route path="/kits" element={<PermissionProtected permission="page:inventory"><Kits /></PermissionProtected>} />
          <Route path="/audit-log" element={<PermissionProtected adminOnly><AuditLog /></PermissionProtected>} />
          <Route path="/users" element={<PermissionProtected adminOnly><Users /></PermissionProtected>} />
          <Route path="/cashier-balances" element={<PermissionProtected permission="page:pos"><CashierBalances /></PermissionProtected>} />
          <Route path="/day-close-report" element={<PermissionProtected adminOnly><DayCloseReport /></PermissionProtected>} />
          <Route path="/permissions" element={<PermissionProtected adminOnly><Permissions /></PermissionProtected>} />
          <Route path="/settings" element={<PermissionProtected adminOnly><Settings /></PermissionProtected>} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  );
}

type OverflowFolderStatus = {
  ok?: boolean;
  configured?: boolean;
  available?: boolean;
  folderPath?: string | null;
  storageMode?: 'indexeddb' | 'folder_primary' | 'unknown';
  profileDirectoryName?: string | null;
  profileId?: string | null;
  profileDirectory?: string | null;
  error?: string;
  canceled?: boolean;
};

const PRIMARY_PROFILE_PURPOSES: DesktopPOSMigrationPurpose[] = [
  'app_state', 'sync_queue', 'meta', 'restore_checkpoint',
];

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function verifyAndActivatePrimaryProfile(status: OverflowFolderStatus, directory: string): Promise<void> {
  const active = await getDesktopPOSProfileStatus();
  if (!active.unlocked || active.profile?.profileId !== status.profileId || active.profile?.directory !== directory) {
    throw new Error('The unlocked encrypted profile does not match the configured primary POS profile.');
  }
  let journal = await getDesktopPOSMigrationJournal();
  if (!journal || journal.profileId !== status.profileId) {
    throw new Error('The primary POS profile has no matching migration journal.');
  }
  if (journal.phase !== 'ready_to_cutover' && journal.phase !== 'folder_primary') {
    throw new Error('The primary POS migration was interrupted before all data was verified. Do not use an older IndexedDB copy.');
  }

  for (const purpose of PRIMARY_PROFILE_PURPOSES) {
    const entry = journal.entries[purpose];
    if (entry.status !== 'verified' || !entry.sha256 || !Number.isFinite(entry.bytes) || !Number.isFinite(entry.revision)) {
      throw new Error(`The primary POS ${purpose} data has no completed verification record.`);
    }
    const serialized = await readDesktopProfilePayload(purpose);
    if (serialized === null) throw new Error(`The primary POS ${purpose} file is missing.`);
    const bytes = new TextEncoder().encode(serialized).byteLength;
    const sha256 = await sha256Hex(serialized);
    if (bytes !== entry.bytes || sha256 !== entry.sha256) {
      throw new Error(`The primary POS ${purpose} data failed its integrity check.`);
    }
    const value = JSON.parse(serialized);
    if (purpose === 'app_state' &&
        (!value || !Array.isArray(value.products) || !Array.isArray(value.users) || !Array.isArray(value.sales))) {
      throw new Error('The primary POS state file has an unsupported data shape.');
    }
    if (purpose === 'sync_queue' && !Array.isArray(value)) {
      throw new Error('The primary POS offline queue has an unsupported data shape.');
    }
    if (purpose === 'meta' &&
        (!value || !Number.isFinite(value.autoBackupHours) || !Number.isFinite(value.backupCount))) {
      throw new Error('The primary POS backup metadata has an unsupported data shape.');
    }
    if (purpose === 'restore_checkpoint' && value !== null &&
        (!value || !Array.isArray(value.products) || !Array.isArray(value.users) || !Array.isArray(value.sales))) {
      throw new Error('The primary POS restore checkpoint has an unsupported data shape.');
    }
  }

  if (journal.phase === 'ready_to_cutover') {
    journal = await transitionDesktopPOSStorageMigration('folder_primary');
  }
  if (journal.phase !== 'folder_primary') {
    throw new Error('The encrypted POS profile did not complete its primary-storage cutover.');
  }
  setDesktopProfilePrimary(true);
}

function DesktopOverflowFolderSetup({ children }: { children: ReactNode }) {
  const desktopApi = useMemo(() => (window as Window & {
    nexfixDesktop?: {
      isDesktop?: boolean;
      getPOSOverflowFolder?: () => Promise<OverflowFolderStatus>;
      choosePOSOverflowFolder?: () => Promise<OverflowFolderStatus>;
    };
  }).nexfixDesktop, []);
  const [loading, setLoading] = useState(Boolean(desktopApi?.isDesktop && desktopApi.getPOSOverflowFolder));
  const [choosing, setChoosing] = useState(false);
  const [folderStatus, setFolderStatus] = useState<OverflowFolderStatus | null>(null);
  const [error, setError] = useState('');
  const [primaryBooting, setPrimaryBooting] = useState(false);
  const [primaryReady, setPrimaryReady] = useState(false);
  const [primaryUnlockRequired, setPrimaryUnlockRequired] = useState(false);
  const [primaryDirectory, setPrimaryDirectory] = useState('');
  const [unlockMode, setUnlockMode] = useState<'passphrase' | 'recovery'>('passphrase');
  const [unlockSecret, setUnlockSecret] = useState('');
  const [unlockError, setUnlockError] = useState('');
  const [primaryStorageError, setPrimaryStorageError] = useState('');

  useEffect(() => {
    if (!desktopApi?.isDesktop || !desktopApi.getPOSOverflowFolder) return;
    let active = true;
    void desktopApi.getPOSOverflowFolder().then(result => {
      if (!active) return;
      setFolderStatus(result);
      if (!result?.ok) setError(result?.error || 'Saved storage folder status could not be checked.');
    }).catch(() => {
      if (active) setError('Saved storage folder status could not be checked. Please choose the folder again.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [desktopApi]);

  useEffect(() => {
    const onPrimaryStorageError = (event: Event) => {
      const message = (event as CustomEvent<{ message?: string }>).detail?.message;
      setPrimaryStorageError(message || 'The encrypted primary POS storage could not be read.');
      setPrimaryReady(false);
    };
    const onPrimaryStorageCommitted = () => {
      void desktopApi?.getPOSOverflowFolder?.().then(setFolderStatus).catch(() => {
        setPrimaryStorageError('The new primary POS storage location could not be reloaded.');
      });
    };
    window.addEventListener('nexfix:storage-primary-error', onPrimaryStorageError);
    window.addEventListener('nexfix:storage-primary-committed', onPrimaryStorageCommitted);
    return () => {
      window.removeEventListener('nexfix:storage-primary-error', onPrimaryStorageError);
      window.removeEventListener('nexfix:storage-primary-committed', onPrimaryStorageCommitted);
    };
  }, [desktopApi]);

  useEffect(() => {
    if (!folderStatus) return;
    if (folderStatus.storageMode !== 'folder_primary') {
      setDesktopProfilePrimary(false);
      setPrimaryReady(false);
      setPrimaryBooting(false);
      setPrimaryUnlockRequired(false);
      setPrimaryDirectory('');
      setPrimaryStorageError('');
      setUnlockError('');
      return;
    }
    // Do not turn the file-backed adapter off during a runtime cutover or
    // while a primary drive is reconnecting. Only verified rollback to
    // IndexedDB mode may clear the backend flag.
    setPrimaryReady(false);
    if (!folderStatus.available || !folderStatus.folderPath || !folderStatus.profileDirectory || !folderStatus.profileId) {
      setPrimaryBooting(false);
      return;
    }
    let active = true;
    setPrimaryBooting(true);
    setPrimaryUnlockRequired(false);
    setPrimaryStorageError('');
    setUnlockError('');
    void (async () => {
      const discovery = await discoverDesktopPOSProfiles(folderStatus.folderPath!);
      if (discovery.available.length !== 1 || discovery.duplicates.length > 0 || discovery.invalid.length > 0) {
        throw new Error('The selected folder must contain exactly one valid encrypted POS profile. No data was changed.');
      }
      const profile = discovery.available.find(item =>
        item.profileId === folderStatus.profileId && item.directory === folderStatus.profileDirectory,
      );
      if (!profile) throw new Error('The configured primary POS profile was not found in the selected folder.');
      if (active) setPrimaryDirectory(profile.directory);
      const profileStatus = await getDesktopPOSProfileStatus();
      if (profileStatus.unlocked && profileStatus.profile?.profileId !== folderStatus.profileId) {
        throw new Error('A different encrypted POS profile is already open in this app session.');
      }
      if (!profileStatus.unlocked) {
        try {
          await unlockDesktopPOSProfileWithOS(profile.directory);
        } catch {
          if (active) {
            setPrimaryUnlockRequired(true);
            setUnlockError('Automatic Windows unlock is unavailable. Enter the profile passphrase or recovery key.');
          }
          return;
        }
      }
      await verifyAndActivatePrimaryProfile(folderStatus, profile.directory);
      if (active) {
        setPrimaryReady(true);
        setPrimaryUnlockRequired(false);
        setUnlockSecret('');
      }
    })().catch(error => {
      if (active) setPrimaryStorageError(error instanceof Error ? error.message : 'Primary POS storage verification failed.');
    }).finally(() => {
      if (active) setPrimaryBooting(false);
    });
    return () => { active = false; };
  }, [folderStatus]);

  const unlockPrimaryProfile = async () => {
    if (!primaryDirectory || !folderStatus || !unlockSecret.trim() || primaryBooting) return;
    setPrimaryBooting(true);
    setUnlockError('');
    try {
      if (unlockMode === 'passphrase') {
        await unlockDesktopPOSProfileWithPassphrase(primaryDirectory, unlockSecret);
      } else {
        await unlockDesktopPOSProfileWithRecoveryKey(primaryDirectory, unlockSecret);
      }
    } catch (error) {
      setUnlockError(error instanceof Error ? error.message : 'The profile could not be unlocked.');
      setPrimaryBooting(false);
      return;
    }
    try {
      await verifyAndActivatePrimaryProfile(folderStatus, primaryDirectory);
      setPrimaryReady(true);
      setPrimaryUnlockRequired(false);
      setUnlockSecret('');
      setUnlockError('');
    } catch (error) {
      setPrimaryStorageError(error instanceof Error ? error.message : 'Primary POS storage verification failed.');
    } finally {
      setPrimaryBooting(false);
    }
  };

  const chooseFolder = async () => {
    if (!desktopApi?.choosePOSOverflowFolder || choosing) return;
    setChoosing(true);
    setError('');
    try {
      const result = await desktopApi.choosePOSOverflowFolder();
      if (!result?.ok) {
        setError(result?.error || 'The selected folder could not be saved. Please try again.');
      } else if (!result.canceled && result.configured && result.available) {
        setFolderStatus(result);
      } else if (result.error) {
        setError(result.error);
      }
    } catch {
      setError('The folder could not be selected. Please try again.');
    } finally {
      setChoosing(false);
    }
  };

  if (!desktopApi?.isDesktop) return <>{children}</>;
  if (loading) return <RouteFallback />;

  // Never fall back to IndexedDB after the durable config says the folder is
  // primary. The file-backed DB adapter/startup unlock must be ready first.
  if (folderStatus?.ok && folderStatus.configured && folderStatus.storageMode === 'folder_primary') {
    if (!folderStatus.available) {
      return (
        <div className="min-h-screen grid place-items-center bg-[#f5f6fb] p-5 text-[#17133c] dark:bg-[#080d1c] dark:text-white">
          <div className="w-full max-w-xl rounded-2xl border border-red-300 bg-white p-6 shadow-xl dark:border-red-300/20 dark:bg-[#101a2d] sm:p-8">
            <AlertTriangle size={28} className="mb-4 text-red-600" />
            <h1 className="text-xl font-black">Primary POS storage folder is disconnected</h1>
            <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
              Nexfix has already marked the selected folder as the primary data location. POS is paused to protect your latest sales. Reconnect the original drive, or select a folder containing the same verified POS profile.
            </p>
            {error && <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-400/10 dark:text-red-200">{error}</p>}
            <button type="button" onClick={() => void chooseFolder()} disabled={choosing || !desktopApi?.choosePOSOverflowFolder}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-3 text-sm font-extrabold text-white disabled:opacity-60">
              {choosing ? 'Verifying original storage…' : 'Reconnect original storage folder'}
            </button>
          </div>
        </div>
      );
    }
    if (primaryStorageError) {
      return (
        <div className="min-h-screen grid place-items-center bg-[#f5f6fb] p-5 text-[#17133c] dark:bg-[#080d1c] dark:text-white">
          <div className="w-full max-w-xl rounded-2xl border border-red-300 bg-white p-6 shadow-xl dark:border-red-300/20 dark:bg-[#101a2d] sm:p-8">
            <AlertTriangle size={28} className="mb-4 text-red-600" />
            <h1 className="text-xl font-black">Primary POS storage verification failed</h1>
            <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
              Nexfix has stopped POS instead of opening an older IndexedDB copy. Reconnect the original folder or restore the verified profile before continuing.
            </p>
            <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-400/10 dark:text-red-200">{primaryStorageError}</p>
          </div>
        </div>
      );
    }
    if (primaryBooting || (!primaryReady && !primaryUnlockRequired)) return <RouteFallback />;
    if (primaryUnlockRequired) {
      return (
        <div className="min-h-screen grid place-items-center bg-[#f5f6fb] p-5 text-[#17133c] dark:bg-[#080d1c] dark:text-white">
          <div className="w-full max-w-xl rounded-2xl border border-amber-300 bg-white p-6 shadow-xl dark:border-amber-300/20 dark:bg-[#101a2d] sm:p-8">
            <AlertTriangle size={28} className="mb-4 text-amber-600" />
            <h1 className="text-xl font-black">Unlock primary POS storage</h1>
            <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
              The original encrypted POS profile is present. This Windows account cannot unlock it automatically, so use the profile passphrase or recovery key. This is separate from your normal POS login.
            </p>
            <div className="mt-5 flex gap-2">
              <button type="button" onClick={() => setUnlockMode('passphrase')} className={`flex-1 rounded-lg border px-3 py-2 text-sm font-bold ${unlockMode === 'passphrase' ? 'border-cyan-500 bg-cyan-50 text-cyan-800' : 'border-slate-300 text-slate-600'}`}>Passphrase</button>
              <button type="button" onClick={() => setUnlockMode('recovery')} className={`flex-1 rounded-lg border px-3 py-2 text-sm font-bold ${unlockMode === 'recovery' ? 'border-cyan-500 bg-cyan-50 text-cyan-800' : 'border-slate-300 text-slate-600'}`}>Recovery key</button>
            </div>
            <input type="password" value={unlockSecret} onChange={event => setUnlockSecret(event.target.value)}
              placeholder={unlockMode === 'passphrase' ? 'POS profile passphrase' : 'POS profile recovery key'}
              className="mt-4 w-full rounded-lg border border-slate-300 bg-white px-3 py-3 text-sm text-slate-900 outline-none focus:border-cyan-500" />
            {unlockError && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{unlockError}</p>}
            <button type="button" onClick={() => void unlockPrimaryProfile()} disabled={primaryBooting || !unlockSecret.trim()}
              className="mt-5 w-full rounded-xl bg-cyan-600 px-4 py-3 text-sm font-extrabold text-white disabled:opacity-60">
              {primaryBooting ? 'Verifying encrypted data…' : 'Unlock and verify POS data'}
            </button>
          </div>
        </div>
      );
    }
    return <>{children}</>;
  }

  if (folderStatus?.storageMode === 'unknown' || (folderStatus?.ok === false && folderStatus.configured)) {
    return (
      <div className="min-h-screen grid place-items-center bg-[#f5f6fb] p-5 text-[#17133c] dark:bg-[#080d1c] dark:text-white">
        <div className="w-full max-w-xl rounded-2xl border border-red-300 bg-white p-6 shadow-xl dark:border-red-300/20 dark:bg-[#101a2d] sm:p-8">
          <AlertTriangle size={28} className="mb-4 text-red-600" />
          <h1 className="text-xl font-black">POS storage configuration needs repair</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
            Nexfix cannot safely determine which storage location is primary. POS is paused to avoid opening a stale database copy.
          </p>
          {error && <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-400/10 dark:text-red-200">{error}</p>}
        </div>
      </div>
    );
  }

  if (folderStatus?.ok && folderStatus.configured && folderStatus.available && folderStatus.storageMode === 'indexeddb') return <>{children}</>;

  // Before cutover, IndexedDB remains primary, so a disconnected overflow
  // destination is a warning only and POS can continue safely.
  if (folderStatus?.ok && folderStatus.configured && !folderStatus.available && folderStatus.storageMode === 'indexeddb') {
    return (
      <>
        <div role="alert" className="fixed inset-x-0 top-0 z-[300] flex flex-wrap items-center justify-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-3 text-center text-sm text-amber-900 shadow-sm dark:border-amber-300/20 dark:bg-amber-950 dark:text-amber-100">
          <span>The selected extra-storage folder is disconnected. POS is continuing with IndexedDB; reconnect the drive or choose another folder before overflow migration is enabled.</span>
          <button type="button" onClick={() => void chooseFolder()} disabled={choosing}
            className="rounded-lg border border-amber-500/40 px-3 py-1.5 text-xs font-bold hover:bg-amber-100 disabled:opacity-60 dark:hover:bg-amber-900">
            {choosing ? 'Checking folder…' : 'Reconnect / choose folder'}
          </button>
        </div>
        {children}
      </>
    );
  }

  return (
    <div className="min-h-screen grid place-items-center bg-[#f5f6fb] p-5 text-[#17133c] dark:bg-[#080d1c] dark:text-white">
      <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-white/10 dark:bg-[#101a2d] sm:p-8">
        <div className="mb-4 grid h-12 w-12 place-items-center rounded-xl bg-cyan-500/10 text-cyan-600 dark:text-cyan-300">
          <AlertTriangle size={23} />
        </div>
        <h1 className="text-xl font-black">Choose a POS storage folder</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
          Before opening Nexfix POS, select a folder on this computer or an attached drive. This folder is prepared for extra storage if the browser database becomes full.
        </p>
        <div className="mt-4 rounded-xl border border-cyan-200 bg-cyan-50 p-4 text-sm leading-6 text-cyan-950 dark:border-cyan-300/20 dark:bg-cyan-300/10 dark:text-cyan-100">
          <strong>Important:</strong> IndexedDB will continue to store your normal POS data first. Nexfix will use the selected folder only after a safe, verified storage migration is implemented and the database approaches its limit. Your current POS data will not be moved by selecting this folder.
        </div>
        {folderStatus?.configured && !folderStatus.available && (
          <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-300/10 dark:text-amber-200">
            The previously selected folder is not available. Reconnect its drive or choose another folder.
          </p>
        )}
        {(error || (desktopApi?.isDesktop && !desktopApi.getPOSOverflowFolder
          ? 'This Nexfix desktop build does not include the storage-folder setup service. Update the app before continuing.'
          : '')) && <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-400/10 dark:text-red-200">{error || 'This Nexfix desktop build does not include the storage-folder setup service. Update the app before continuing.'}</p>}
        <button type="button" onClick={() => void chooseFolder()} disabled={choosing || !desktopApi?.choosePOSOverflowFolder}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-4 py-3 text-sm font-extrabold text-white shadow-lg transition hover:brightness-110 disabled:cursor-wait disabled:opacity-60">
          {choosing ? <Loader2 size={17} className="animate-spin" /> : null}
          {choosing ? 'Checking folder…' : 'Select storage folder'}
        </button>
        <p className="mt-3 text-center text-xs text-slate-500 dark:text-slate-400">
          Choose a normal writable folder, not the drive root itself. You can use an internal drive or an attached external drive.
        </p>
      </div>
    </div>
  );
}

function POSApplication() {
  useEffect(() => startSyncManager(), []);
  return (
    <POSProvider>
      <HashRouter>
        <CloudAuthLifecycle />
        <SessionSecurity />
        <CloudSyncStateBridge />
        <DesktopUpdateNotice />
        <AppRoutes />
      </HashRouter>
    </POSProvider>
  );
}

export default function App() {
  return (
    <DesktopOverflowFolderSetup>
      <POSApplication />
    </DesktopOverflowFolderSetup>
  );
}
