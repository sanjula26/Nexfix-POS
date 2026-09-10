import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutGrid, ShoppingCart, Package, Users, Truck, ClipboardList, ReceiptText,
  ArrowLeftRight, Wallet, BarChart3, Tags, UserPlus, ShieldCheck, UserCog,
  Landmark, KeyRound, ScrollText, Settings, LogOut, Globe, Sparkles, Eye,
  EyeOff, Wifi, Activity, Bell, Sun, Moon, Menu, X, Lock, LockKeyhole,
  Loader2, AlertCircle, ShieldAlert, Wrench, Cpu, Search, FileText,
} from 'lucide-react';
import { usePOS } from '../lib/store';
import { fmtNum } from '../lib/utils';
import { Avatar, Modal } from './ui';
import CommandPalette from './CommandPalette';

interface NavDef {
  to: string; label: string; icon: React.ElementType; perm?: string; group: string; adminOnly?: boolean; badge?: boolean;
}

const NAV: NavDef[] = [
  { to: '/', label: 'Dashboard', icon: LayoutGrid, perm: 'page:dashboard', group: 'Operations' },
  { to: '/pos', label: 'POS / Sales', icon: ShoppingCart, perm: 'page:pos', group: 'Operations' },
  { to: '/inventory', label: 'Inventory', icon: Package, perm: 'page:inventory', group: 'Operations' },
  { to: '/kits', label: 'Kits / BOM', icon: Package, perm: 'page:inventory', group: 'Operations' },
  { to: '/units', label: 'IMEI / Serial', icon: Cpu, perm: 'page:units', group: 'Operations' },
  { to: '/repairs', label: 'Repairs', icon: Wrench, perm: 'page:repairs', group: 'Operations' },
  { to: '/quotations', label: 'Quotations', icon: FileText, perm: 'page:pos', group: 'Operations' },
  { to: '/warranty-claims', label: 'Warranty Claims', icon: ShieldCheck, perm: 'page:repairs', group: 'Operations' },
  { to: '/customers', label: 'Customers', icon: Users, perm: 'page:customers', group: 'Operations' },
  { to: '/suppliers', label: 'Suppliers', icon: Truck, perm: 'page:suppliers', group: 'Operations' },
  { to: '/supplier-payments', label: 'Supplier Payments', icon: Wallet, perm: 'page:suppliers', group: 'Operations' },
  { to: '/purchases', label: 'Purchases', icon: ClipboardList, perm: 'page:purchases', group: 'Operations' },
  { to: '/grn', label: 'Goods Received Notes', icon: ClipboardList, perm: 'page:purchases', group: 'Operations' },
  { to: '/sales', label: 'Sales History', icon: ReceiptText, perm: 'page:sales', group: 'Operations' },
  { to: '/exchanges', label: 'Exchanges', icon: ArrowLeftRight, perm: 'page:exchanges', group: 'Operations' },
  { to: '/expenses', label: 'Expenses', icon: Wallet, perm: 'page:expenses', group: 'Operations' },
  { to: '/reports', label: 'Reports', icon: BarChart3, perm: 'page:reports', group: 'Operations' },
  { to: '/price-tags', label: 'Price Tags', icon: Tags, perm: 'page:pricetags', group: 'Operations' },
  { to: '/signup', label: 'Customer Signup', icon: UserPlus, group: 'Operations' },
  { to: '/users', label: 'Users', icon: UserCog, group: 'Administration', adminOnly: true },
  { to: '/cashier-balances', label: 'Day Cash & Drawer', icon: Landmark, group: 'Administration', adminOnly: true },
  { to: '/permissions', label: 'Permissions', icon: KeyRound, group: 'Administration', adminOnly: true },
  { to: '/audit-log', label: 'Audit Log', icon: ScrollText, group: 'Administration', adminOnly: true },
  { to: '/settings', label: 'Settings', icon: Settings, group: 'System', adminOnly: true },
];

const TITLES: [RegExp, string][] = [
  [/^\/$/, 'Dashboard'], [/^\/pos/, 'Point of Sale'], [/^\/inventory/, 'Inventory'],
  [/^\/units/, 'IMEI / Serial Units'], [/^\/repairs/, 'Repairs / Service'],
  [/^\/customers/, 'Customers'], [/^\/suppliers/, 'Suppliers'], [/^\/supplier-payments/, 'Supplier Payments'], [/^\/grn/, 'Goods Received Notes'], [/^\/purchases/, 'Purchases'],
  [/^\/sales/, 'Sales History'], [/^\/exchanges/, 'Exchanges / Returns'], [/^\/expenses/, 'Expenses'],
  [/^\/reports/, 'Reports & Analytics'], [/^\/price-tags/, 'Price Tags'], [/^\/signup/, 'Customer Signup'],
  [/^\/users/, 'Users'], [/^\/cashier-balances/, 'Day Cash & Drawer'], [/^\/permissions/, 'Permissions'],
  [/^\/audit-log/, 'Audit Log'], [/^\/settings/, 'Settings'],
];

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const date = now.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
  const time = now.toLocaleTimeString('en-GB');
  return (
    <span className="hidden md:inline-flex items-center gap-2 text-xs font-medium text-sub bg-raised border border-line rounded-full px-3.5 py-1.5 num">
      <Activity size={13} className="text-violet-500" />
      {date}
      <span className="text-faint">·</span>
      <span className="text-ink font-semibold">{time}</span>
    </span>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { user, viewingAs, can, switchRole, signOut, state, setAdminPrompt } = usePOS();
  const navigate = useNavigate();
  const lowStock = state.products.filter(p => p.active && p.stock <= p.reorderLevel).length;

  const visible = NAV.filter(n => {
    if (n.adminOnly) return user?.role === 'admin';
    if (!n.perm) return true;
    return can(n.perm);
  });
  const groups = ['Operations', 'Administration', 'System'].map(g => ({
    name: g, items: visible.filter(v => v.group === g),
  })).filter(g => g.items.length > 0);

  return (
    <aside
      className="flex flex-col h-full w-[270px] shrink-0 text-white"
      style={{ background: 'linear-gradient(180deg, #1a1440 0%, #0d0a24 100%)' }}
    >
      {/* brand */}
      <div className="flex items-center gap-3 px-5 pt-5 pb-4">
        <div className="relative">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-violet-500 via-indigo-500 to-sky-400 flex items-center justify-center shadow-lg shadow-violet-900/50">
            <Globe size={21} strokeWidth={2.2} />
          </div>
          <span className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-emerald-400 border-[2.5px] border-[#17123c]" />
        </div>
        <div>
          <div className="font-display font-extrabold text-[17px] tracking-wide leading-none">NEXFIX</div>
          <div className="flex items-center gap-1 text-[10px] font-semibold tracking-[0.14em] text-[#8f93bd] mt-1.5">
            <Sparkles size={10} className="text-violet-400" /> POS &middot; V3.1
          </div>
        </div>
      </div>

      {/* nav */}
      <nav className="flex-1 overflow-y-auto sidebar-scroll px-3 pb-4">
        {groups.map(g => (
          <div key={g.name} className="mt-3">
            <div className="flex items-center gap-2 px-3 pt-3 pb-2">
              <span className={`w-1 h-1 rounded-full ${g.name === 'Administration' ? 'bg-amber-400' : 'bg-violet-400'}`} />
              <span className="text-[10px] font-bold tracking-[0.16em] text-[#7f83ad] uppercase">{g.name}</span>
              {g.name === 'Administration' && (
                <span className="text-[9px] font-bold bg-amber-400/15 text-amber-400 border border-amber-400/30 rounded px-1.5 py-0.5 tracking-wider">ADMIN</span>
              )}
            </div>
            <div className="space-y-1">
              {g.items.map(item => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  onClick={onNavigate}
                  className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                >
                  {({ isActive }) => (
                    <>
                      <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
                        isActive ? 'bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-md shadow-violet-950/60' : 'bg-white/[0.06] text-[#9aa0cd]'
                      }`}>
                        <item.icon size={16} strokeWidth={2.1} />
                      </span>
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.to === '/inventory' && lowStock > 0 && (
                        <span className="text-[10px] font-bold bg-amber-400/15 text-amber-400 rounded-full px-1.5 py-0.5 num">{lowStock}</span>
                      )}
                      {isActive && <span className="w-1.5 h-1.5 rounded-full bg-violet-300 shrink-0" />}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* role switch */}
      <div className="px-3 pb-3 space-y-3">
        <div className="grid grid-cols-2 gap-2 bg-black/25 rounded-xl p-1.5 border border-white/[0.06]">
          {(['admin', 'cashier'] as const).map(r => {
            const locked = r === 'admin' && viewingAs === 'cashier';
            return (
              <button
                key={r}
                onClick={() => {
                  if (locked) setAdminPrompt(true);
                  else switchRole(r);
                }}
                className={`relative flex items-center justify-center gap-1.5 rounded-lg py-2 text-[11px] font-bold tracking-wider uppercase transition-all ${
                  viewingAs === r
                    ? r === 'admin'
                      ? 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-md shadow-violet-950/50'
                      : 'bg-gradient-to-r from-emerald-500 to-teal-600 text-white shadow-md shadow-emerald-950/50'
                    : locked
                      ? 'text-[#c9a48a] hover:text-amber-300'
                      : 'text-[#8f93bd] hover:text-white'
                }`}
                title={locked ? 'Admin view is password protected' : undefined}
              >
                {viewingAs === r ? <Eye size={12} /> : locked ? <Lock size={12} /> : <EyeOff size={12} />}
                {r}
                {locked && (
                  <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-amber-400 text-[#17123c] flex items-center justify-center shadow">
                    <Lock size={9} strokeWidth={3} />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* user card */}
        <div className="bg-black/30 border border-white/[0.07] rounded-2xl p-3.5">
          <div className="flex items-center gap-3">
            <Avatar name={user?.name || 'U'} size={38} />
            <div className="min-w-0">
              <div className="text-[13px] font-bold text-white truncate">{user?.name}</div>
              <div className="text-[11px] text-[#8f93bd] truncate">{user?.email}</div>
            </div>
          </div>
          <div className="mt-2.5">
            <span className={`badge ${viewingAs === 'admin'
              ? 'bg-violet-500/15 text-violet-300 border border-violet-400/30'
              : 'bg-emerald-500/15 text-emerald-300 border border-emerald-400/30'}`}>
              <ShieldCheck size={11} /> {viewingAs.toUpperCase()}
            </span>
          </div>
        </div>

        <button
          onClick={() => { signOut(); navigate('/login'); }}
          className="nav-item !text-[#b9bce0] hover:!text-rose-300 hover:!bg-rose-500/10"
        >
          <span className="w-8 h-8 rounded-lg bg-white/[0.06] flex items-center justify-center shrink-0">
            <LogOut size={16} strokeWidth={2.1} />
          </span>
          Sign out
        </button>
      </div>
    </aside>
  );
}

/* ---------- ADMIN elevation prompt (session-nullifying) ---------- */
const MAX_ATTEMPTS = 3;
const LOCKOUT_SECS = 30;
const IDLE_SECS = 30;

function AdminUnlockModal() {
  const { adminPrompt, setAdminPrompt, switchRole, logAudit } = usePOS();
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [error, setError] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [busy, setBusy] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);
  const [lockUntil, setLockUntil] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const idleRef = useRef<number | undefined>(undefined);

  const lockSecsLeft = lockUntil ? Math.max(0, Math.ceil((lockUntil - now) / 1000)) : 0;

  const reset = useCallback(() => {
    setPin(''); setError(''); setAttempts(0); setBusy(false); setLockUntil(null); setShowPin(false);
  }, []);

  const close = useCallback((reason?: 'timeout') => {
    if (reason === 'timeout') {
      logAudit('TIMEOUT', 'Auth', 'Admin unlock prompt timed out — stayed in CASHIER mode');
    }
    setAdminPrompt(false);
  }, [logAudit, setAdminPrompt]);

  /* timers run only while the prompt is visible */
  useEffect(() => {
    if (!adminPrompt) { reset(); return; }
    const tick = setInterval(() => setNow(Date.now()), 500);
    idleRef.current = window.setTimeout(() => close('timeout'), IDLE_SECS * 1000);
    return () => { clearInterval(tick); if (idleRef.current) clearTimeout(idleRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminPrompt]);

  const armIdle = () => {
    if (idleRef.current) clearTimeout(idleRef.current);
    idleRef.current = window.setTimeout(() => close('timeout'), IDLE_SECS * 1000);
  };

  useEffect(() => {
    if (lockUntil && lockSecsLeft === 0) { setLockUntil(null); setError(''); }
  }, [lockSecsLeft, lockUntil]);

  const tryUnlock = () => {
    if (!pin || busy || lockSecsLeft > 0) return;
    setBusy(true); setError('');
    setTimeout(() => {
      const res = switchRole('admin', pin);
      setBusy(false);
      if (res.ok) { setAdminPrompt(false); return; }
      armIdle();
      const n = attempts + 1;
      setShakeKey(k => k + 1);
      setPin('');
      if (n >= MAX_ATTEMPTS) {
        setAttempts(0);
        setLockUntil(Date.now() + LOCKOUT_SECS * 1000);
        logAudit('LOCKOUT', 'Auth', `ADMIN unlock locked ${LOCKOUT_SECS}s after ${MAX_ATTEMPTS} failed attempts`);
        setError('Too many failed attempts');
      } else {
        setAttempts(n);
        setError(res.error || 'Incorrect admin password');
      }
    }, 380);
  };

  return (
    <Modal
      open={adminPrompt}
      onClose={() => close()}
      title="Admin access required"
      sub="The ADMIN role is password protected"
      locked
    >
      <motion.div
        key={shakeKey}
        animate={shakeKey ? { x: [0, -9, 9, -6, 6, 0] } : { x: 0 }}
        transition={{ duration: 0.4 }}
      >
        {/* security notice */}
        <div className="flex items-center gap-3.5 rounded-2xl bg-violet-500/[0.07] border border-violet-500/20 p-4 mb-4">
          <span className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white flex items-center justify-center shadow-lg shadow-violet-600/30 shrink-0">
            <LockKeyhole size={20} />
          </span>
          <div>
            <p className="text-[13px] font-bold text-ink">Confirm Password</p>
            <p className="text-[11.5px] text-sub mt-0.5">
              Cashier access is <b className="text-violet-500">suspended</b> while this prompt is open. All attempts are recorded in the audit log.
            </p>
          </div>
        </div>

        <div className="space-y-3.5">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-bold tracking-wider uppercase text-sub">Admin password</span>
              {/* attempt dots */}
              <span className="flex items-center gap-1" title={`${MAX_ATTEMPTS} attempts before a ${LOCKOUT_SECS}s lockout`}>
                {[0, 1, 2].map(i => (
                  <span key={i} className={`w-2 h-2 rounded-full transition-colors ${i < attempts ? 'bg-rose-500' : 'bg-line'}`} />
                ))}
                <span className="text-[9.5px] text-faint font-semibold ml-1">{attempts}/{MAX_ATTEMPTS}</span>
              </span>
            </div>
            <div className="relative">
              <Lock size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
              <input
                type={showPin ? 'text' : 'password'}
                className={`input pl-9 pr-10 !py-3 font-mono tracking-widest ${error ? '!border-rose-400 !ring-2 !ring-rose-500/20' : ''}`}
                placeholder="••••••••"
                value={pin}
                autoFocus
                disabled={lockSecsLeft > 0}
                onChange={e => { setPin(e.target.value); setError(''); armIdle(); }}
                onKeyDown={e => { if (e.key === 'Enter') tryUnlock(); }}
              />
              <button
                type="button"
                onClick={() => setShowPin(s => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-faint hover:text-ink"
                disabled={lockSecsLeft > 0}
              >
                {showPin ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          <AnimatePresence mode="wait">
            {lockSecsLeft > 0 ? (
              <motion.div
                key="lockout"
                initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                className="flex items-center gap-2 rounded-xl bg-rose-500/10 border border-rose-500/25 px-3.5 py-2.5 text-[13px] font-semibold text-rose-500"
              >
                <ShieldAlert size={15} /> Locked — try again in <span className="num font-extrabold">{lockSecsLeft}s</span>
              </motion.div>
            ) : error ? (
              <motion.p
                key="err"
                initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                className="flex items-center gap-1.5 text-[13px] font-semibold text-rose-500"
              >
                <AlertCircle size={14} /> {error} — staying in CASHIER mode{attempts > 0 ? ` (${MAX_ATTEMPTS - attempts} attempt${MAX_ATTEMPTS - attempts === 1 ? '' : 's'} left)` : ''}
              </motion.p>
            ) : null}
          </AnimatePresence>

          <div className="flex gap-2.5 pt-1">
            <button className="btn btn-primary flex-1 !py-3" onClick={tryUnlock} disabled={!pin || busy || lockSecsLeft > 0}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
              Confirm Password
            </button>
            <button className="btn btn-soft" onClick={() => close()}>
              Cancel
            </button>
          </div>
          <p className="text-[10.5px] text-faint text-center">
            Prompt auto-cancels after {IDLE_SECS}s of inactivity · Demo default: <b className="text-sub font-mono">admin123</b> · Change under Settings → Security
          </p>
        </div>
      </motion.div>
    </Modal>
  );
}

export default function AppLayout() {
  const { user, viewingAs, state, toggleTheme, dark, adminPrompt, connectivity, ready } = usePOS();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const title = TITLES.find(([re]) => re.test(location.pathname))?.[1] || 'Dashboard';
  const lowStock = useMemo(
    () => state.products.filter(p => p.active && p.stock <= p.reorderLevel),
    [state.products],
  );

  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  if (!user) return null;

  return (
    <div className="flex h-screen overflow-hidden bg-base">
      {/* while the admin prompt is open, the current session's UI is fully suspended */}
      <div
        inert={adminPrompt ? true : undefined}
        aria-hidden={adminPrompt}
        className={`flex h-full w-full transition-all duration-300 ${adminPrompt ? 'pointer-events-none select-none blur-[6px] saturate-[0.65] scale-[0.992] opacity-70' : ''}`}
      >
      {/* desktop sidebar */}
      <div className="hidden lg:block h-full">
        <Sidebar />
      </div>
      {/* mobile drawer */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <div className="relative h-full">
            <Sidebar onNavigate={() => setMobileOpen(false)} />
            <button className="absolute top-4 -right-11 icon-btn !bg-black/40 !text-white" onClick={() => setMobileOpen(false)}>
              <X size={18} />
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        {/* topbar */}
        <header className="shrink-0 h-16 bg-surface/85 backdrop-blur border-b border-line flex items-center gap-3 px-4 sm:px-6 z-20">
          <button className="icon-btn lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Menu">
            <Menu size={18} />
          </button>
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="w-1 h-6 rounded-full bg-gradient-to-b from-violet-500 to-indigo-500" />
            <h1 className="font-display font-extrabold text-[15px] sm:text-[17px] text-ink truncate tracking-tight">{title}</h1>
          </div>

          <span className={`hidden sm:inline-flex badge ${viewingAs === 'admin'
            ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30'
            : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30'}`}>
            <Eye size={11} /> VIEWING AS {viewingAs.toUpperCase()}
            <span className="w-px h-3 bg-current opacity-30" />
            <EyeOff size={11} className="opacity-60" />
          </span>

          <div className="flex-1" />

          <span className={`hidden sm:inline-flex badge border ${
            connectivity === 'online'
              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25'
              : 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/25'
          }`}>
            <Wifi size={11} /> {connectivity === 'online' ? 'Online' : 'Offline'}
            <span className={`w-1.5 h-1.5 rounded-full ${connectivity === 'online' ? 'bg-emerald-500 blink' : 'bg-rose-500'}`} />
          </span>
          {!ready && (
            <span className="hidden sm:inline-flex badge bg-amber-500/10 text-amber-600 border border-amber-500/25">
              Loading storage…
            </span>
          )}

          <Clock />

          <button
            onClick={() => navigate('/inventory?low=1')}
            className={`badge !py-1.5 !px-3 transition-all hover:brightness-110 cursor-pointer ${
              lowStock.length > 0
                ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30'
                : 'bg-raised text-faint border border-line'
            }`}
            title={lowStock.length ? 'View low stock items' : 'All products well stocked'}
          >
            <Bell size={12} />
            <span className="num">{lowStock.length > 0 ? `${fmtNum(lowStock.length)} low-stock` : 'stock OK'}</span>
          </button>

          <button
            type="button"
            className="hidden sm:inline-flex items-center gap-1.5 rounded-xl border border-line bg-raised px-2.5 py-1.5 text-[11px] font-semibold text-sub hover:text-ink transition-colors"
            title="Command palette (Ctrl+K)"
            onClick={() => window.dispatchEvent(new Event('nexfix:open-palette'))}
          >
            <Search size={13} />
            <span className="hidden md:inline">Search</span>
            <kbd className="text-[9px] font-mono opacity-70 border border-line rounded px-1">⌘K</kbd>
          </button>
          <button className="icon-btn border !border-line bg-raised" onClick={toggleTheme} aria-label="Toggle theme">
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </header>

        {/* content */}
        <main className="flex-1 overflow-y-auto">
          <div key={location.pathname} className="page-enter px-4 sm:px-6 xl:px-8 py-6 max-w-[1500px] mx-auto">
            <Outlet />
          </div>
        </main>
      </div>
      </div>

      {/* admin elevation prompt — renders above the suspended (inert) shell */}
      <AdminUnlockModal />
      <CommandPalette />
    </div>
  );
}
