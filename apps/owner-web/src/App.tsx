import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { HashRouter, Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { BarChart3, CalendarDays, ChevronRight, CircleDollarSign, Download, FileText, LayoutDashboard, LogOut, Menu, Package, RefreshCw, Settings, Users, Wallet, Wrench, type LucideIcon } from 'lucide-react';
import './styles.css';

const url = (import.meta.env.VITE_SUPABASE_URL || '').trim();
const publicKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();
const client: SupabaseClient | null = url && publicKey ? createClient(url, publicKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  global: { headers: { 'x-client-info': 'nexfix-owner-web' } },
}) : null;
const TIME_ZONE = (import.meta.env.VITE_OWNER_WEB_TIME_ZONE || 'Asia/Colombo').trim();
const PAGE_SIZE = 50;

type Shop = { id: string; name: string; currency: string | null };
type Sale = { id: string; bill_no: string; customer_name: string | null; total: number; created_at: string; status: string };
type DailyAggregate = { sale_date: string; completed_sales_count: number; gross_total: number };
type Branch = { id: string; name: string; code: string; is_default: boolean };
type BranchDaily = { branch_id: string; sale_date: string; completed_sales_count: number; gross_total: number };
type BranchValuation = { branch_id: string; branch_name: string; product_id: string; product_name: string; sku: string; qty: number; cost_unit: number; selling_unit: number; cost_value: number; selling_value: number; potential_profit: number; reorder_level: number; low_stock: boolean };
type BranchFilterValue = { branchId: string; setBranchId: (id: string) => void; branches: Branch[]; branchDaily: BranchDaily[]; branchLoading: boolean; refreshBranchSnapshot: () => Promise<void> };
const BranchFilter = createContext<BranchFilterValue | null>(null);
function useBranchFilter() { const value = useContext(BranchFilter); if (!value) throw new Error('Branch filter provider missing'); return value; }
type SalesPage = { rows: Sale[]; count: number };
type CreditCustomer = { customer_id: string; customer_name: string; phone: string | null; email: string | null; credit_balance: number; open_invoice_balance: number; reconciled: boolean; updated_at: string };
type SaleLine = { id: string; name: string; qty: number; price: number; cost: number | null; discount: number | null; warranty_months: number | null };
type SalePayment = { id: string; method: string; amount: number };
type DaySession = { id: string; cashier_id: string; cashier_name: string | null; session_date: string; opening: number; closing: number | null; closed: boolean | null; note: string | null; created_at: string; branch_id: string };
type ExpenseRow = { id: string; category: string; note: string | null; amount: number; expense_date: string; created_at: string; branch_id: string };
type CloudMember = { user_id: string; role: string; active: boolean; created_at: string; email?: string; full_name?: string | null; profile_role?: string | null; profile_active?: boolean };
type AuthValue = { session: Session | null; shop: Shop | null; loading: boolean; error: string; refresh: () => Promise<void>; client: SupabaseClient | null };
const Auth = createContext<AuthValue | null>(null);
function useAuth() { const value = useContext(Auth); if (!value) throw new Error('Auth provider missing'); return value; }

function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [tenantLoading, setTenantLoading] = useState(false);
  const [shop, setShop] = useState<Shop | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!client) { setAuthLoading(false); return; }
    let alive = true;
    void client.auth.getSession().then(({ data, error: authError }) => {
      if (!alive) return;
      if (authError) setError(authError.message);
      setSession(data.session); setAuthLoading(false);
    });
    const { data } = client.auth.onAuthStateChange((_event, next) => {
      if (!alive) return;
      setSession(next); setAuthLoading(false);
    });
    return () => { alive = false; data.subscription.unsubscribe(); };
  }, []);

  const refresh = async () => {
    if (!client || !session?.user.id) { setShop(null); setError(''); return; }
    setTenantLoading(true); setError('');
    try {
      // Tenant authority is the signed-in user's active membership, never a URL or cached ID.
      const { data, error: memberError } = await client.from('shop_memberships')
        .select('shop_id,role,active,created_at').eq('user_id', session.user.id).eq('active', true).order('created_at');
      if (memberError) throw memberError;
      const memberships = data || [];
      if (!memberships.length) throw new Error('This account has no active shop membership. Ask the shop administrator to provision access.');
      if (memberships.length !== 1) throw new Error('Phase 1 supports one shop per account. This account has multiple active shop memberships; contact the administrator.');
      const { data: row, error: shopError } = await client.from('shops').select('id,name,currency').eq('id', memberships[0].shop_id).maybeSingle();
      if (shopError) throw shopError;
      if (!row) throw new Error('The active membership points to a shop that is not readable. Check shop membership and RLS.');
      setShop({ id: row.id, name: row.name || 'NexFix Shop', currency: row.currency || 'LKR' });
    } catch (cause) {
      setShop(null); setError(cause instanceof Error ? cause.message : 'Could not verify shop membership.');
    } finally { setTenantLoading(false); }
  };
  useEffect(() => {
    if (!session) { setShop(null); setError(''); setTenantLoading(false); return; }
    void refresh();
    // Membership is always re-resolved from Supabase for the active user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  return <Auth.Provider value={{ session, shop, loading: authLoading || tenantLoading, error, refresh, client }}>{children}</Auth.Provider>;
}

function dayKey(date: Date, zone = TIME_ZONE) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (name: string) => p.find((item) => item.type === name)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function addDays(key: string, n: number) {
  const [y, m, d] = key.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1, d + n));
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
}
function midnightIso(key: string, zone = TIME_ZONE) {
  const [y, m, d] = key.split('-').map(Number); const target = Date.UTC(y, m - 1, d); let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess));
    const part = (name: string) => Number(p.find((item) => item.type === name)?.value || 0);
    const represented = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
    const correction = target - represented; guess += correction; if (!correction) break;
  }
  return new Date(guess).toISOString();
}
function money(value: number, currency: string | null | undefined) {
  return new Intl.NumberFormat('en-LK', { style: 'currency', currency: currency || 'LKR', maximumFractionDigits: 2 }).format(value);
}
function dateTime(value: string) { return new Intl.DateTimeFormat('en-LK', { dateStyle: 'medium', timeStyle: 'short', timeZone: TIME_ZONE }).format(new Date(value)); }
function csvCell(value: unknown) { return '"' + String(value ?? '').replace(/"/g, '""') + '"'; }
function exportCsv(filename: string, rows: unknown[][]) {
  const blob = new Blob(['\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const href = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = href; anchor.download = filename; anchor.click(); URL.revokeObjectURL(href);
}
async function getDailyAggregates(db: SupabaseClient, shopId: string, from: string, to: string, branchId: string): Promise<DailyAggregate[]> {
  const { data, error } = await db.rpc('get_owner_branch_daily_sales', { p_shop_id: shopId, p_from: from, p_to: to, p_branch_id: branchId === 'all' ? null : branchId });
  if (error) throw error;
  const totals = new Map<string, DailyAggregate>();
  for (const row of (data || []) as BranchDaily[]) { const item = totals.get(row.sale_date) || { sale_date: row.sale_date, completed_sales_count: 0, gross_total: 0 }; item.completed_sales_count += Number(row.completed_sales_count || 0); item.gross_total += Number(row.gross_total || 0); totals.set(row.sale_date, item); }
  return [...totals.values()].sort((a,b)=>a.sale_date.localeCompare(b.sale_date));
}
async function getSalesPage(db: SupabaseClient, shopId: string, from: string, to: string, page: number, pageSize: number, branchId: string): Promise<SalesPage> {
  const start = page * pageSize;
  let query = db.from('sales').select('id,bill_no,customer_name,total,created_at,status', { count: 'exact' })
    .eq('shop_id', shopId).eq('status', 'completed').gte('created_at', from).lt('created_at', to);
  if (branchId !== 'all') query = query.eq('branch_id', branchId);
  const { data, error, count } = await query.order('created_at', { ascending: false }).range(start, start + pageSize - 1);
  if (error) throw error;
  return { rows: (data || []) as Sale[], count: count || 0 };
}
function Spinner({ label = 'Checking secure shop access…' }: { label?: string }) { return <div className="loading"><span className="spinner" />{label}</div>; }
function ConfigMissing() { return <div className="center-screen"><section className="login-card"><div className="logo">N</div><p className="eyebrow">NEXFIX OWNER WEB</p><h1>Configuration required</h1><p>Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in the deployment environment. Use only the public anon/publishable key—never a service-role key.</p></section></div>; }
function SignOut() {
  const { client: db } = useAuth(); const navigate = useNavigate(); const [busy, setBusy] = useState(false);
  const signOut = async () => { if (!db) return; setBusy(true); const { error } = await db.auth.signOut(); setBusy(false); if (error) window.alert(error.message); else navigate('/login', { replace: true }); };
  return <button className="signout" onClick={() => void signOut()} disabled={busy} title="Sign out"><LogOut size={16} />{busy ? 'Signing out' : 'Sign out'}</button>;
}
function Login() {
  const { session, client: db } = useAuth(); const navigate = useNavigate(); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { if (session) navigate('/dashboard', { replace: true }); }, [session, navigate]);
  if (!db) return <ConfigMissing />;
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    const { error: signInError } = await db.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false); if (signInError) { setError(signInError.message); return; } navigate('/dashboard', { replace: true });
  };
  return <div className="center-screen"><section className="login-card"><div className="logo">N</div><p className="eyebrow">NEXFIX SOLUTION</p><h1>Owner Web</h1><p>Sign in with your shop's Supabase account. Desktop POS passwords are separate.</p><form onSubmit={(e) => void submit(e)}><label>Email address<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@yourshop.com" /></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="Supabase password" /></label>{error && <div className="error" role="alert">{error}</div>}<button className="primary wide" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in securely'} <ChevronRight size={17} /></button></form><small className="login-foot">Read-only access · Active shop membership required</small></section></div>;
}
function Blocked() {
  const { error, refresh } = useAuth(); const [busy, setBusy] = useState(false);
  return <div className="center-screen"><section className="login-card"><div className="logo">N</div><p className="eyebrow">SHOP ACCESS CHECK</p><h1>We couldn't verify your shop</h1><p className="error">{error || 'No active shop membership was found.'}</p><p>No sales data was loaded. Shop access comes from the signed-in account's active membership, not a URL or cached shop ID.</p><div className="actions"><button className="primary" onClick={() => { setBusy(true); void refresh().finally(() => setBusy(false)); }} disabled={busy}>{busy ? 'Checking…' : 'Try again'}</button><SignOut /></div></section></div>;
}
function Guard() {
  const { session, shop, loading, error } = useAuth();
  if (!client) return <ConfigMissing />;
  if (loading) return <Spinner />;
  if (!session) return <Navigate to="/login" replace />;
  if (error || !shop) return <Blocked />;
  return <Outlet />;
}
type NavItem = { label: string; path?: string; icon: LucideIcon; soon?: boolean };
const nav: { label: string; items: NavItem[] }[] = [
  { label: 'OVERVIEW', items: [{ label: 'Dashboard', path: '/dashboard', icon: LayoutDashboard }] },
  { label: 'SALES', items: [{ label: 'Invoices / Sales', path: '/sales', icon: FileText }, { label: 'Sales report', path: '/reports', icon: BarChart3 }] },
  { label: 'MANAGEMENT', items: [{ label: 'Customers / Credit', path: '/customers', icon: Users }, { label: 'Day-end history', path: '/day-end', icon: Wallet }, { label: 'Expenses', path: '/expenses', icon: CircleDollarSign }, { label: 'POS users', path: '/employees', icon: Users }, { label: 'Inventory', icon: Package, soon: true }, { label: 'Repairs', icon: Wrench, soon: true }, { label: 'Settings', icon: Settings, soon: true }] },
];
function Shell() {
  const { session, shop, client: db } = useAuth(); const location = useLocation(); const [mobile, setMobile] = useState(false);
  const [branches,setBranches] = useState<Branch[]>([]); const [branchId,setBranchId] = useState('all'); const [branchDaily,setBranchDaily] = useState<BranchDaily[]>([]); const [branchLoading,setBranchLoading] = useState(false); const [branchError,setBranchError] = useState('');
  useEffect(()=>{ let alive=true; const load=async()=>{if(!db||!shop)return;setBranchLoading(true);setBranchError('');try{const {data,error}=await db.from('branches').select('id,name,code,is_default').eq('shop_id',shop.id).eq('active',true).order('name');if(error)throw error;const rows=(data||[]) as Branch[];if(!alive)return;setBranches(rows);setBranchId(current=>rows.length<=1?(rows[0]?.id||'all'):(current==='all'||rows.some(b=>b.id===current)?current:(rows.find(b=>b.is_default)?.id||rows[0]?.id||'all')));const today=dayKey(new Date());const snap=await db.rpc('get_owner_branch_daily_sales',{p_shop_id:shop.id,p_from:today,p_to:today,p_branch_id:null});if(snap.error)throw snap.error;if(alive)setBranchDaily((snap.data||[]) as BranchDaily[]);}catch(e){if(alive)setBranchError(e instanceof Error?e.message:'Could not load branches.');}finally{if(alive)setBranchLoading(false);}};void load();return()=>{alive=false;};},[db,shop?.id]);
  const refreshBranchSnapshot=async()=>{if(!db||!shop)return;setBranchLoading(true);setBranchError('');try{const today=dayKey(new Date());const {data,error}=await db.rpc('get_owner_branch_daily_sales',{p_shop_id:shop.id,p_from:today,p_to:today,p_branch_id:null});if(error)throw error;setBranchDaily((data||[]) as BranchDaily[]);}catch(e){setBranchError(e instanceof Error?e.message:'Could not refresh today’s branch sales.');}finally{setBranchLoading(false);}};
  useEffect(() => setMobile(false), [location.pathname]);
  const title = location.pathname.startsWith('/sales/') ? 'Invoice detail' : location.pathname === '/sales' ? 'Invoices / Sales' : location.pathname === '/reports' ? 'Sales report' : location.pathname === '/customers' ? 'Customers / Credit' : location.pathname === '/day-end' ? 'Cashier day-end history' : location.pathname === '/expenses' ? 'Expenses' : location.pathname === '/employees' ? 'POS users' : 'Dashboard';
  return <BranchFilter.Provider value={{branchId,setBranchId,branches,branchDaily,branchLoading,refreshBranchSnapshot}}><div className="shell">{mobile && <button className="backdrop" aria-label="Close navigation" onClick={() => setMobile(false)} />}<aside className={mobile ? 'sidebar open' : 'sidebar'}><div className="brand"><div className="logo small">N</div><div><b>NexFix</b><small>OWNER WEB</small></div><button className="close-menu" onClick={() => setMobile(false)}><span>×</span></button></div><div className="shop-chip"><span className="shop-avatar">{(shop?.name || 'N').slice(0,1)}</span><div><b>{shop?.name}</b><small>Shop-scoped · Read only</small></div><i /></div>{branches.length>0&&<section className="branch-switch"><label htmlFor="owner-branch">Switch branch</label><select id="owner-branch" value={branchId} onChange={e=>setBranchId(e.target.value)} disabled={branchLoading}>{branches.length>1&&<option value="all">All branches</option>}{branches.map(b=><option value={b.id} key={b.id}>{b.name}{b.is_default?' (Default)':''}</option>)}</select><small>Currently viewing: {branchId==='all'?'All branches':branches.find(b=>b.id===branchId)?.name||'Selected branch'}</small><button className="branch-refresh" onClick={()=>void refreshBranchSnapshot()} disabled={branchLoading}><RefreshCw size={12}/>{branchLoading?'Refreshing…':'Refresh today snapshot'}</button>{branchError&&<small className="error">{branchError}</small>}<small>Today: {money(branchDaily.filter(r=>branchId==='all'||r.branch_id===branchId).reduce((n,r)=>n+Number(r.gross_total||0),0),shop?.currency)} · {branchDaily.filter(r=>branchId==='all'||r.branch_id===branchId).reduce((n,r)=>n+Number(r.completed_sales_count||0),0)} invoices</small></section>}<nav>{nav.map((group) => <div className="nav-group" key={group.label}><small>{group.label}</small>{group.items.map((item) => { const Icon = item.icon; return item.soon ? <div className="nav-item disabled" key={item.label}><Icon size={17}/><span>{item.label}</span><em>Soon</em></div> : <NavLink key={item.path} to={item.path!} className={({isActive}) => 'nav-item ' + (isActive ? 'active' : '')}><Icon size={17}/><span>{item.label}</span></NavLink>; })}</div>)}</nav><div className="sidebar-bottom"><div className="read-only"><span>✓</span><div><b>Read-only mode</b><small>POS operations stay on desktop</small></div></div><div className="account"><div className="avatar">{(session?.user.email || 'N').slice(0,1).toUpperCase()}</div><div className="account-text"><b>{session?.user.email}</b><small>Supabase account</small></div><SignOut /></div></div></aside><main><header><button className="menu" onClick={() => setMobile(true)} aria-label="Open menu"><Menu size={21}/></button><div><p className="eyebrow">NEXFIX / OWNER WEB</p><h1>{title}</h1></div><span className="secure"><i/>Secure cloud session</span></header><section className="content"><Outlet /></section><footer>NexFix Owner Web · Read-only cloud view · Shop timezone: {TIME_ZONE}</footer></main></div></BranchFilter.Provider>;
}
function useSalesLoaders() {
  const { client: db, shop } = useAuth(); const { branchId } = useBranchFilter();
  return {
    aggregates: (from: string, to: string) => {
      if (!db || !shop) return Promise.reject(new Error('Shop session is not ready.'));
      return getDailyAggregates(db, shop.id, from, to, branchId);
    },
    page: (from: string, to: string, page: number, pageSize = PAGE_SIZE) => {
      if (!db || !shop) return Promise.reject(new Error('Shop session is not ready.'));
      return getSalesPage(db, shop.id, from, to, page, pageSize, branchId);
    },
  };
}
function Banner({ error, retry }: { error: string; retry: () => void }) { return <div className="banner error"><b>Could not load cloud sales.</b><span>{error}</span><button onClick={retry}>Try again</button></div>; }
function Stat({ label, value, note, icon: Icon, tone }: { label: string; value: string; note: string; icon: LucideIcon; tone: string }) { return <article className="stat"><div className={'stat-icon ' + tone}><Icon size={19}/></div><p>{label}</p><strong>{value}</strong><small>{note}</small></article>; }
function SalesTable({ sales, currency, loading, empty = 'No completed cloud invoices found.' }: { sales: Sale[]; currency: string; loading: boolean; empty?: string }) {
  if (loading) return <div className="empty"><span className="spinner"/>Loading invoices…</div>;
  if (!sales.length) return <div className="empty"><FileText size={25}/>{empty}</div>;
  return <div className="table-scroll"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Date</th><th className="right">Total</th><th>Status</th></tr></thead><tbody>{sales.map((s) => <tr key={s.id}><td><Link className="bill-link" to={'/sales/'+s.id}><b className="bill">{s.bill_no}</b><small>View detail</small></Link></td><td>{s.customer_name || 'Walk-in customer'}</td><td>{dateTime(s.created_at)}</td><td className="right amount">{money(Number(s.total), currency)}</td><td><span className="status">Completed</span></td></tr>)}</tbody></table></div>;
}
function Dashboard() {
  const { shop } = useAuth(); const { branchId, branches, refreshBranchSnapshot } = useBranchFilter(); const loaders = useSalesLoaders();
  const [daily, setDaily] = useState<DailyAggregate[]>([]); const [recent, setRecent] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [updated, setUpdated] = useState('');
  const today = dayKey(new Date()); const month = today.slice(0,7) + '-01'; const chartStart = addDays(today, -13);
  const reload = async () => {
    void refreshBranchSnapshot();
    setLoading(true); setError('');
    try {
      const [aggregates, recentPage] = await Promise.all([
        loaders.aggregates(month < chartStart ? month : chartStart, today),
        loaders.page(midnightIso(addDays(today,-29)), midnightIso(addDays(today,1)), 0, 5),
      ]);
      setDaily(aggregates); setRecent(recentPage.rows); setUpdated(new Date().toISOString());
    } catch (e) { setError(e instanceof Error ? e.message : 'Unknown query error'); }
    finally { setLoading(false); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, [shop?.id, branchId]);
  const byDay = new Map<string, DailyAggregate>(daily.map((d): [string, DailyAggregate] => [d.sale_date, d]));
  const todayRow = byDay.get(today); const monthRows = daily.filter((d) => d.sale_date >= month && d.sale_date <= today);
  const todayTotal = Number(todayRow?.gross_total || 0); const todayCount = Number(todayRow?.completed_sales_count || 0);
  const monthTotal = monthRows.reduce((sum, d) => sum + Number(d.gross_total || 0), 0);
  const monthCount = monthRows.reduce((sum, d) => sum + Number(d.completed_sales_count || 0), 0);
  const days = Array.from({length:14},(_,i) => { const key=addDays(chartStart,i); const row=byDay.get(key); return {key,label:new Intl.DateTimeFormat('en',{weekday:'short',timeZone:'UTC'}).format(new Date(key+'T12:00:00Z')),amount:Number(row?.gross_total || 0),count:Number(row?.completed_sales_count || 0)}; });
  const max = Math.max(1,...days.map((d)=>d.amount)); const currency = shop?.currency || 'LKR';
  return <div className="stack"><div className="welcome"><div><p className="eyebrow">SALES OVERVIEW</p><h2>Good to see you.</h2><p>Here's what's happening at {shop?.name} · {branchId==='all'?'all branches':branches.find(b=>b.id===branchId)?.name||'selected branch'}.</p></div><button className="secondary" onClick={() => void reload()} disabled={loading}><RefreshCw size={15}/>{loading?'Loading…':'Refresh data'}</button></div>
    {error && <Banner error={error} retry={() => void reload()}/>}<div className="notice"><span>i</span><p>Completed cloud invoice totals only. Amounts are gross invoice totals; partial returns are not netted. Offline POS sales appear after sync.</p>{updated && <small>Updated {dateTime(updated)}</small>}</div>
    <div className="stats"><Stat label="Today's sales" value={loading?'—':money(todayTotal,currency)} note={loading?'Loading aggregates':todayCount+' completed invoices'} icon={CircleDollarSign} tone="blue"/><Stat label="Month to date" value={loading?'—':money(monthTotal,currency)} note={loading?'Loading aggregates':monthCount+' completed invoices'} icon={Wallet} tone="violet"/><Stat label="Invoices today" value={loading?'—':String(todayCount)} note="Completed invoices only" icon={FileText} tone="green"/><Stat label="Cash in hand" value="Not available" note="Available after POS day-end sync" icon={CircleDollarSign} tone="amber"/></div>
    <section className="panel"><div className="panel-head"><div><h3>Sales over the last 14 days</h3><p>Daily completed invoice aggregates · {TIME_ZONE}</p></div><Link to="/reports">View report <ChevronRight size={15}/></Link></div>{loading?<div className="empty"><span className="spinner"/>Loading daily aggregates…</div>:<div className="chart"><div className="y-labels"><span>{money(max,currency)}</span><span>{money(max/2,currency)}</span><span>{money(0,currency)}</span></div><div className="bars">{days.map((d)=><div className="bar-col" key={d.key} title={d.key+' · '+money(d.amount,currency)+' · '+d.count+' invoices'}><div className="bar-track"><div className="bar-fill" style={{height:(d.amount?Math.max(3,d.amount/max*100):0)+'%'}}/></div><span>{d.label}</span><small>{d.key.slice(8)}</small></div>)}</div></div>}</section>
    <section className="panel"><div className="panel-head"><div><h3>Recent invoices</h3><p>Latest 5 completed invoices · limited columns</p></div><Link to="/sales">All invoices <ChevronRight size={15}/></Link></div><SalesTable sales={recent} currency={currency} loading={loading}/></section>
    <div className="deferred"><div><b>Gross profit</b><p>Deferred until cloud profit and return accounting are reconciled.</p><em>Not verified</em></div><div><b>Payment mix</b><p>Deferred until payment allocation and return accounting are reconciled.</p><em>Not verified</em></div></div>
  </div>;
}
function DateFilters({ from, to, setFrom, setTo, today, submit, busy, label }: {from:string;to:string;setFrom:(v:string)=>void;setTo:(v:string)=>void;today:string;submit:()=>void;busy:boolean;label:string}) {
  return <form className="filters" onSubmit={(e)=>{e.preventDefault();submit();}}><label>From date<input type="date" value={from} max={to} onChange={(e)=>setFrom(e.target.value)} required/></label><label>To date<input type="date" value={to} min={from} max={today} onChange={(e)=>setTo(e.target.value)} required/></label><button className="primary" type="submit" disabled={busy}><CalendarDays size={15}/>{label}</button></form>;
}
function checkRange(from:string,to:string) {
  if (from>to) throw new Error('Start date must be before or equal to end date.');
  if ((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000>365) throw new Error('Choose a date range of 366 days or less.');
}
function SalesPage() {
  const {shop}=useAuth(); const {branchId,branches}=useBranchFilter(); const loaders=useSalesLoaders(); const today=dayKey(new Date());
  const [from,setFrom]=useState(addDays(today,-29)); const [to,setTo]=useState(today); const [sales,setSales]=useState<Sale[]>([]);
  const [loading,setLoading]=useState(true); const [error,setError]=useState(''); const [page,setPage]=useState(0); const [totalCount,setTotalCount]=useState(0);
  const load=async(nextPage=page)=>{setLoading(true);setError('');try{checkRange(from,to);const result=await loaders.page(midnightIso(from),midnightIso(addDays(to,1)),nextPage);setSales(result.rows);setTotalCount(result.count);setPage(nextPage);}catch(e){setError(e instanceof Error?e.message:'Could not load sales.');}finally{setLoading(false);}};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{void load(0);},[shop?.id,branchId]);
  const currency=shop?.currency||'LKR'; const count=Math.max(1,Math.ceil(totalCount/PAGE_SIZE));
  return <div className="stack"><div className="welcome"><div><p className="eyebrow">CLOUD SALES</p><h2>Invoices / Sales</h2><p>Read-only invoices synced from {shop?.name} · {branchId==='all'?'all branches':branches.find(b=>b.id===branchId)?.name||'selected branch'}.</p></div><button className="secondary" disabled={loading||!sales.length} onClick={()=>exportCsv('nexfix-sales-'+from+'-to-'+to+'-page-'+(page+1)+'.csv',[['Invoice','Customer','Created at','Total','Status'],...sales.map(s=>[s.bill_no,s.customer_name||'Walk-in customer',dateTime(s.created_at),Number(s.total).toFixed(2),'Completed'])])}><Download size={15}/>Export page CSV</button></div>
    <section className="panel filter-panel"><DateFilters from={from} to={to} setFrom={(v)=>{setFrom(v);setPage(0);}} setTo={(v)=>{setTo(v);setPage(0);}} today={today} submit={()=>void load(0)} busy={loading} label="Apply range"/><div className="summary"><small>{loading?'Loading…':totalCount+' completed invoices · page '+(page+1)+' of '+count}</small><b>{loading?'—':money(sales.reduce((sum,s)=>sum+Number(s.total||0),0),currency)}</b><small>Visible page total · gross invoice total, partial returns not netted</small></div></section>{error&&<Banner error={error} retry={()=>void load(page)}/>}
    <section className="panel"><div className="panel-head"><div><h3>Sales transactions</h3><p>{from} to {to} · {TIME_ZONE} · 50 rows per page</p></div><span className="pill">{totalCount} invoices</span></div><SalesTable sales={sales} currency={currency} loading={loading}/>{!loading&&totalCount>PAGE_SIZE&&<div className="pagination"><span>Page {page+1} of {count}</span><button className="secondary" disabled={page===0} onClick={()=>void load(page-1)}>Previous</button><button className="secondary" disabled={page+1>=count} onClick={()=>void load(page+1)}>Next</button></div>}</section>
  </div>;
}
function ReportPage() {
  const {shop,client:db}=useAuth(); const {branchId,branches}=useBranchFilter(); const loaders=useSalesLoaders(); const today=dayKey(new Date());
  const [valuation,setValuation]=useState<BranchValuation[]>([]); const [valuationLoading,setValuationLoading]=useState(true); const [valuationError,setValuationError]=useState('');
  const [from,setFrom]=useState(addDays(today,-13)); const [to,setTo]=useState(today); const [dailyRows,setDailyRows]=useState<DailyAggregate[]>([]);
  const [range,setRange]=useState(''); const [loading,setLoading]=useState(true); const [error,setError]=useState('');
  const load=async()=>{setLoading(true);setError('');setValuationLoading(true);setValuationError('');try{checkRange(from,to);const rows=await loaders.aggregates(from,to);setDailyRows(rows);setRange(from+' to '+to);if(!db||!shop)throw new Error('Shop session is not ready.');const stock=await db.rpc('get_owner_branch_stock_valuation',{p_shop_id:shop.id,p_branch_id:branchId==='all'?null:branchId});if(stock.error)throw stock.error;setValuation((stock.data||[]) as BranchValuation[]);}catch(e){setError(e instanceof Error?e.message:'Could not load report.');setValuationError(e instanceof Error?e.message:'Could not load stock valuation.');}finally{setLoading(false);setValuationLoading(false);}};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{void load();},[shop?.id,branchId]);
  const currency=shop?.currency||'LKR'; const daily=useMemo(()=>{if(!range)return[];const n=Math.min(366,Math.floor((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000)+1);const byDay=new Map<string, DailyAggregate>(dailyRows.map((r):[string,DailyAggregate]=>[r.sale_date,r]));return Array.from({length:Math.max(1,n)},(_,i)=>{const key=addDays(from,i);const row=byDay.get(key);return{key,count:Number(row?.completed_sales_count||0),amount:Number(row?.gross_total||0)};});},[dailyRows,from,to,range]); const gross=daily.reduce((sum,d)=>sum+d.amount,0); const count=daily.reduce((sum,d)=>sum+d.count,0); const max=Math.max(1,...daily.map(d=>d.amount));
  return <div className="stack"><div className="welcome"><div><p className="eyebrow">REPORTING</p><h2>Sales report</h2><p>Choose a date range to review daily completed-sales aggregates.</p></div><button className="secondary" disabled={loading||!range} onClick={()=>exportCsv('nexfix-report-'+from+'-to-'+to+'.csv',[['Date','Completed invoices','Gross invoice total'],...daily.map(d=>[d.key,d.count,d.amount.toFixed(2)])])}><Download size={15}/>Export report CSV</button></div>
    <section className="panel filter-panel"><DateFilters from={from} to={to} setFrom={setFrom} setTo={setTo} today={today} submit={()=>void load()} busy={loading} label="Run report"/><div className="summary"><small>Completed invoice total</small><b>{loading?'—':money(gross,currency)}</b><small>{loading?'Loading aggregates':count+' invoices · '+range}</small></div></section>{error&&<Banner error={error} retry={()=>void load()}/>}
    <div className="stats"><Stat label="Sales total" value={loading?'—':money(gross,currency)} note="Gross completed invoice total" icon={CircleDollarSign} tone="blue"/><Stat label="Invoice count" value={loading?'—':String(count)} note="Completed invoices only" icon={FileText} tone="green"/><Stat label="Average invoice" value={loading?'—':money(count?gross/count:0,currency)} note="Total divided by invoice count" icon={BarChart3} tone="violet"/><Stat label="Cash in hand" value="Not available" note="Available after POS day-end sync" icon={Wallet} tone="amber"/></div>
    <section className="panel"><div className="panel-head"><div><h3>Stock valuation by branch</h3><p>Branch stock × product cost/price; all-branch rows reconcile to branch_stock</p></div><button className="secondary" disabled={valuationLoading||!valuation.length} onClick={()=>exportCsv('nexfix-stock-valuation-'+(branchId==='all'?'all-branches':branchId)+'.csv',[['Branch','Product','SKU','Qty','Unit cost','Unit selling price','Cost value','Selling value','Potential profit','Reorder level','Low stock'],...valuation.map(v=>[v.branch_name,v.product_name,v.sku,Number(v.qty),Number(v.cost_unit),Number(v.selling_unit),Number(v.cost_value),Number(v.selling_value),Number(v.potential_profit),Number(v.reorder_level),v.low_stock?'Yes':'No'])])}><Download size={15}/>Export stock CSV</button></div>{valuationError&&<Banner error={valuationError} retry={()=>void load()}/>}<div className="stats"><Stat label="Stock cost value" value={valuationLoading?'—':money(valuation.reduce((n,v)=>n+Number(v.cost_value||0),0),currency)} note="Current branch quantities × cost" icon={Wallet} tone="blue"/><Stat label="Selling value" value={valuationLoading?'—':money(valuation.reduce((n,v)=>n+Number(v.selling_value||0),0),currency)} note="Potential revenue if all stock sells" icon={CircleDollarSign} tone="violet"/><Stat label="Potential profit" value={valuationLoading?'—':money(valuation.reduce((n,v)=>n+Number(v.potential_profit||0),0),currency)} note="Selling value minus cost value" icon={BarChart3} tone="green"/><Stat label="Low-stock products" value={valuationLoading?'—':String(valuation.filter(v=>v.low_stock).length)} note="Quantity at/below reorder level" icon={Package} tone="amber"/></div>{valuationLoading?<div className="empty"><span className="spinner"/>Loading stock valuation…</div>:<div className="table-scroll"><table><thead><tr><th>Branch</th><th>Product</th><th>SKU</th><th className="right">Qty</th><th className="right">Cost value</th><th className="right">Selling value</th><th className="right">Potential profit</th><th>Stock</th></tr></thead><tbody>{valuation.map(v=><tr key={v.branch_id+'-'+v.product_id}><td>{v.branch_name}</td><td>{v.product_name}</td><td>{v.sku||'—'}</td><td className="right">{Number(v.qty).toLocaleString()}</td><td className="right">{money(Number(v.cost_value),currency)}</td><td className="right">{money(Number(v.selling_value),currency)}</td><td className="right">{money(Number(v.potential_profit),currency)}</td><td>{v.low_stock?<span className="low-stock">Low stock</span>:<span className="status">In stock</span>}</td></tr>)}</tbody></table>{!valuation.length&&<div className="empty">No active branch stock rows found.</div>}</div>}</section>
    <section className="panel"><div className="panel-head"><div><h3>Daily sales breakdown</h3><p>Shop-local date · aggregate query only · {branchId==='all'?'all branches':branches.find(b=>b.id===branchId)?.name||'selected branch'}</p></div></div>{loading?<div className="empty"><span className="spinner"/>Loading daily aggregates…</div>:<div className="daily-list">{daily.map(d=><div className="daily-row" key={d.key}><span>{d.key}</span><div className="daily-track"><div style={{width:(d.amount?Math.max(1,d.amount/max*100):0)+'%'}}/></div><small>{d.count} inv.</small><b>{money(d.amount,currency)}</b></div>)}</div>}</section>
  </div>;
}

function InvoiceDetailPage() {
  const { saleId } = useParams(); const { shop, client: db } = useAuth(); const { branchId, branches } = useBranchFilter();
  const [sale,setSale] = useState<(Sale & {customer_id:string|null;cashier_name:string|null;subtotal:number;discount:number;tax:number;shipping:number;amount_paid:number;change_amount:number;note:string|null;branch_id:string})|null>(null);
  const [items,setItems] = useState<SaleLine[]>([]); const [payments,setPayments] = useState<SalePayment[]>([]);
  const [loading,setLoading] = useState(true); const [error,setError] = useState('');
  const load = async () => {
    if(!db||!shop||!saleId)return; setLoading(true);setError('');
    try {
      let q=db.from('sales').select('id,bill_no,customer_id,customer_name,cashier_name,subtotal,discount,tax,shipping,total,amount_paid,change_amount,created_at,status,note,branch_id').eq('shop_id',shop.id).eq('id',saleId);
      if(branchId!=='all')q=q.eq('branch_id',branchId);
      const found=await q.maybeSingle();if(found.error)throw found.error;if(!found.data)throw new Error('Invoice not found in this shop or selected branch.');
      const [lineResult,paymentResult]=await Promise.all([
        db.from('sale_items').select('id,name,qty,price,cost,discount,warranty_months').eq('sale_id',saleId).order('name'),
        db.from('sale_payments').select('id,method,amount').eq('sale_id',saleId).order('method'),
      ]);
      if(lineResult.error)throw lineResult.error;if(paymentResult.error)throw paymentResult.error;
      setSale(found.data as typeof sale & {});setItems((lineResult.data||[]) as SaleLine[]);setPayments((paymentResult.data||[]) as SalePayment[]);
    } catch(e) {setError(e instanceof Error?e.message:'Could not load invoice detail.');setSale(null);setItems([]);setPayments([]);}
    finally{setLoading(false);}
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{void load();},[db,shop?.id,saleId,branchId]);
  const currency=shop?.currency||'LKR';
  return <div className="stack"><div className="welcome"><div><p className="eyebrow">READ-ONLY TRANSACTION</p><h2>{sale?.bill_no||'Invoice detail'}</h2><p>Shop and selected-branch scoped invoice detail.</p></div><Link className="secondary" to="/sales">Back to invoices</Link></div>
    {error&&<Banner error={error} retry={()=>void load()}/>}
    {loading?<div className="empty"><span className="spinner"/>Loading invoice…</div>:sale&&<><div className="stats"><Stat label="Invoice total" value={money(Number(sale.total),currency)} note={sale.status} icon={FileText} tone="blue"/><Stat label="Amount paid" value={money(Number(sale.amount_paid||0),currency)} note="Synced invoice field" icon={CircleDollarSign} tone="green"/><Stat label="Recorded change" value={money(Number(sale.change_amount||0),currency)} note="As recorded by POS" icon={Wallet} tone="violet"/><Stat label="Cashier" value={sale.cashier_name||'Not recorded'} note={dateTime(sale.created_at)} icon={Users} tone="amber"/></div>
      <section className="panel"><div className="panel-head"><div><h3>Invoice information</h3><p>Branch: {branches.find(b=>b.id===sale.branch_id)?.name||'Branch not in current active list'}</p></div><span className="pill">{sale.status}</span></div><div className="detail-grid"><div><small>Customer</small><b>{sale.customer_name||'Walk-in customer'}</b></div><div><small>Invoice date</small><b>{dateTime(sale.created_at)}</b></div><div><small>Subtotal</small><b>{money(Number(sale.subtotal||0),currency)}</b></div><div><small>Discount</small><b>{money(Number(sale.discount||0),currency)}</b></div><div><small>Tax</small><b>{money(Number(sale.tax||0),currency)}</b></div><div><small>Shipping</small><b>{money(Number(sale.shipping||0),currency)}</b></div><div><small>Note</small><b>{sale.note||'—'}</b></div></div></section>
      <section className="panel"><div className="panel-head"><div><h3>Items</h3><p>Synced invoice lines · {items.length} rows</p></div></div>{items.length?<div className="table-scroll"><table><thead><tr><th>Item</th><th className="right">Qty</th><th className="right">Unit price</th><th className="right">Discount</th><th className="right">Line total</th></tr></thead><tbody>{items.map(i=><tr key={i.id}><td>{i.name}{i.warranty_months?' · '+i.warranty_months+' month warranty':''}</td><td className="right">{Number(i.qty).toLocaleString()}</td><td className="right">{money(Number(i.price),currency)}</td><td className="right">{money(Number(i.discount||0),currency)}</td><td className="right amount">{money(Number(i.qty)*Number(i.price)-Number(i.discount||0),currency)}</td></tr>)}</tbody></table></div>:<div className="empty">No synced invoice line items are available.</div>}</section>
      <section className="panel"><div className="panel-head"><div><h3>Recorded payments</h3><p>Payment rows recorded by the POS; no settlement ledger is inferred.</p></div></div>{payments.length?<div className="table-scroll"><table><thead><tr><th>Method</th><th className="right">Amount</th></tr></thead><tbody>{payments.map(p=><tr key={p.id}><td>{p.method}</td><td className="right amount">{money(Number(p.amount),currency)}</td></tr>)}</tbody></table></div>:<div className="empty">No separate payment rows synced for this invoice.</div>}<div className="detail-total"><span>Recorded payment rows total</span><b>{money(payments.reduce((n,p)=>n+Number(p.amount||0),0),currency)}</b></div></section>
      <div className="notice"><span>i</span><p>Read-only detail. Return/refund history is not shown because direct return-table access is intentionally blocked; this page does not calculate a net-of-returns balance.</p></div>
    </>}
  </div>;
}
function CustomersPage() {
  const {shop,client:db}=useAuth();const [rows,setRows]=useState<CreditCustomer[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [updated,setUpdated]=useState('');
  const load=async()=>{if(!db||!shop)return;setLoading(true);setError('');try{const {data,error:queryError}=await db.rpc('get_owner_credit_customers',{p_shop_id:shop.id});if(queryError)throw queryError;setRows((data||[]) as CreditCustomer[]);setUpdated(new Date().toISOString());}catch(e){setError(e instanceof Error?e.message:'Could not load cloud credit customers.');}finally{setLoading(false);}};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{void load();},[db,shop?.id]);
  const currency=shop?.currency||'LKR';const verified=rows.filter(r=>r.reconciled);const verifiedTotal=verified.reduce((n,r)=>n+Number(r.credit_balance||0),0);
  return <div className="stack"><div className="welcome"><div><p className="eyebrow">CUSTOMER CREDIT</p><h2>Customers / outstanding</h2><p>Cloud customer balances reconciled against completed invoices' unpaid amounts.</p></div><button className="secondary" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/>{loading?'Refreshing…':'Refresh balances'}</button></div>
    <div className="notice"><span>i</span><p>Credit is shop-level, not branch-level. This view compares the customer credit balance with completed invoice totals minus recorded amount paid. It does not claim a separate settlement ledger exists.</p>{updated&&<small>Updated {dateTime(updated)}</small>}</div>
    {error&&<Banner error={error} retry={()=>void load()}/>}
    <div className="stats"><Stat label="Verified outstanding" value={loading?'—':money(verifiedTotal,currency)} note={verified.length+' reconciled customers'} icon={CircleDollarSign} tone="blue"/><Stat label="Customers with differences" value={loading?'—':String(rows.filter(r=>!r.reconciled).length)} note="Needs POS reconciliation" icon={Users} tone="amber"/><Stat label="Credit customers" value={loading?'—':String(rows.length)} note="Customers with open or mismatched balances" icon={FileText} tone="violet"/><Stat label="Branch filter" value="Shop-level" note="Credit is not allocated by branch" icon={Wallet} tone="green"/></div>
    <section className="panel"><div className="panel-head"><div><h3>Credit balances</h3><p>Unreconciled amounts are marked and excluded from verified outstanding total.</p></div><button className="secondary" disabled={loading||!rows.length} onClick={()=>exportCsv('nexfix-credit-customers.csv',[['Customer','Phone','Email','Customer credit balance','Completed invoices outstanding','Difference','Reconciled'],...rows.map(r=>[r.customer_name,r.phone,r.email,Number(r.credit_balance),Number(r.open_invoice_balance),Number(r.credit_balance)-Number(r.open_invoice_balance),r.reconciled?'Yes':'No'])])}><Download size={15}/>Export CSV</button></div>{loading?<div className="empty"><span className="spinner"/>Loading customer balances…</div>:rows.length?<div className="table-scroll"><table><thead><tr><th>Customer</th><th>Phone</th><th>Email</th><th className="right">Credit balance</th><th className="right">Open invoice balance</th><th>Reconciliation</th></tr></thead><tbody>{rows.map(r=><tr key={r.customer_id}><td><b>{r.customer_name}</b></td><td>{r.phone||'—'}</td><td>{r.email||'—'}</td><td className="right amount">{money(Number(r.credit_balance),currency)}</td><td className="right">{money(Number(r.open_invoice_balance),currency)}</td><td>{r.reconciled?<span className="status">Matched</span>:<span className="low-stock">Needs review</span>}</td></tr>)}</tbody></table></div>:<div className="empty">No credit customers with an outstanding balance are available in cloud data.</div>}</section>
  </div>;
}
function DayEndPage() {
  const {shop,client:db}=useAuth();const {branchId,branches}=useBranchFilter();const [rows,setRows]=useState<DaySession[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState('');
  const load=async()=>{if(!db||!shop)return;setLoading(true);setError('');try{let q=db.from('day_sessions').select('id,cashier_id,cashier_name,session_date,opening,closing,closed,note,created_at,branch_id').eq('shop_id',shop.id);if(branchId!=='all')q=q.eq('branch_id',branchId);const {data,error:queryError}=await q.order('session_date',{ascending:false}).order('created_at',{ascending:false}).limit(100);if(queryError)throw queryError;setRows((data||[]) as DaySession[]);}catch(e){setError(e instanceof Error?e.message:'Could not load synced day-end sessions.');}finally{setLoading(false);}};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{void load();},[db,shop?.id,branchId]);
  const currency=shop?.currency||'LKR';
  return <div className="stack"><div className="welcome"><div><p className="eyebrow">POS DAY-END</p><h2>Cashier balance history</h2><p>Synced opening/closing sessions · {branchId==='all'?'all branches':branches.find(b=>b.id===branchId)?.name||'selected branch'}.</p></div><button className="secondary" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/>{loading?'Refreshing…':'Refresh history'}</button></div><div className="notice"><span>i</span><p>Opening and closing values are shown as recorded. The difference is only closing minus opening; it is not represented as a cash reconciliation or expected-cash calculation.</p></div>{error&&<Banner error={error} retry={()=>void load()}/>}<section className="panel"><div className="panel-head"><div><h3>Day-end sessions</h3><p>Most recent 100 synced sessions</p></div><span className="pill">{rows.length} records</span></div>{loading?<div className="empty"><span className="spinner"/>Loading day-end history…</div>:rows.length?<div className="table-scroll"><table><thead><tr><th>Date</th><th>Cashier</th><th>Opening</th><th>Closing</th><th>Difference</th><th>Status</th><th>Note</th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td>{r.session_date}</td><td>{r.cashier_name||r.cashier_id.slice(0,8)}</td><td className="right">{money(Number(r.opening),currency)}</td><td className="right">{r.closing===null?'Not closed':money(Number(r.closing),currency)}</td><td className="right">{r.closing===null?'—':money(Number(r.closing)-Number(r.opening),currency)}</td><td>{r.closed?<span className="status">Closed</span>:<span className="low-stock">Open / unknown</span>}</td><td>{r.note||'—'}</td></tr>)}</tbody></table></div>:<div className="empty"><Wallet size={25}/>No synced day-end sessions are available yet. No cashier balance is estimated from invoice totals.</div>}</section></div>;
}
function ExpensesPage() {
  const {shop,client:db}=useAuth();const {branchId,branches}=useBranchFilter();const [rows,setRows]=useState<ExpenseRow[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState('');
  const load=async()=>{if(!db||!shop)return;setLoading(true);setError('');try{let q=db.from('expenses').select('id,category,note,amount,expense_date,created_at,branch_id').eq('shop_id',shop.id);if(branchId!=='all')q=q.eq('branch_id',branchId);const {data,error:queryError}=await q.order('expense_date',{ascending:false}).order('created_at',{ascending:false}).limit(200);if(queryError)throw queryError;setRows((data||[]) as ExpenseRow[]);}catch(e){setError(e instanceof Error?e.message:'Could not load synced expenses.');}finally{setLoading(false);}};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{void load();},[db,shop?.id,branchId]);
  const currency=shop?.currency||'LKR';const total=rows.reduce((n,r)=>n+Number(r.amount||0),0);
  return <div className="stack"><div className="welcome"><div><p className="eyebrow">OPERATING COSTS</p><h2>Expenses</h2><p>Read-only synced expense records · {branchId==='all'?'all branches':branches.find(b=>b.id===branchId)?.name||'selected branch'}.</p></div><button className="secondary" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/>{loading?'Refreshing…':'Refresh expenses'}</button></div>{error&&<Banner error={error} retry={()=>void load()}/>}<div className="stats"><Stat label="Visible expense total" value={loading?'—':money(total,currency)} note="Loaded records only · up to 200" icon={CircleDollarSign} tone="blue"/><Stat label="Records" value={loading?'—':String(rows.length)} note="Synced expense rows" icon={FileText} tone="violet"/><Stat label="Branch scope" value={branchId==='all'?'All branches':branches.find(b=>b.id===branchId)?.name||'Selected branch'} note="Filtered by shop and branch" icon={Package} tone="green"/><Stat label="Mode" value="Read-only" note="No add/edit/delete actions" icon={Wallet} tone="amber"/></div><section className="panel"><div className="panel-head"><div><h3>Expense history</h3><p>Most recent 200 records</p></div><button className="secondary" disabled={loading||!rows.length} onClick={()=>exportCsv('nexfix-expenses-'+(branchId==='all'?'all-branches':branchId)+'.csv',[['Date','Category','Note','Amount','Branch'],...rows.map(r=>[r.expense_date,r.category,r.note,Number(r.amount),branches.find(b=>b.id===r.branch_id)?.name||r.branch_id])])}><Download size={15}/>Export CSV</button></div>{loading?<div className="empty"><span className="spinner"/>Loading expenses…</div>:rows.length?<div className="table-scroll"><table><thead><tr><th>Date</th><th>Category</th><th>Note</th><th className="right">Amount</th><th>Branch</th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td>{r.expense_date}</td><td>{r.category}</td><td>{r.note||'—'}</td><td className="right amount">{money(Number(r.amount),currency)}</td><td>{branches.find(b=>b.id===r.branch_id)?.name||'Inactive/unknown branch'}</td></tr>)}</tbody></table></div>:<div className="empty"><Wallet size={25}/>No synced expense records are available yet. Zero is not inferred as a business expense total.</div>}</section></div>;
}
function EmployeesPage() {
  const {shop,client:db}=useAuth();const [rows,setRows]=useState<CloudMember[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState('');
  const load=async()=>{if(!db||!shop)return;setLoading(true);setError('');try{const {data,error:queryError}=await db.from('shop_memberships').select('user_id,role,active,created_at').eq('shop_id',shop.id).eq('active',true).order('created_at',{ascending:true});if(queryError)throw queryError;const memberships=(data||[]) as CloudMember[];let profiles: {id:string;email:string|null;full_name:string|null;role:string;active:boolean}[]=[];if(memberships.length){const p=await db.from('profiles').select('id,email,full_name,role,active').in('id',memberships.map(m=>m.user_id));if(p.error)throw p.error;profiles=(p.data||[]) as typeof profiles;}setRows(memberships.map(m=>{const p=profiles.find(profile=>profile.id===m.user_id);return {...m,email:p?.email||undefined,full_name:p?.full_name||null,profile_role:p?.role||null,profile_active:p?.active};}));}catch(e){setError(e instanceof Error?e.message:'Could not load cloud user list.');}finally{setLoading(false);}};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{void load();},[db,shop?.id]);
  return <div className="stack"><div className="welcome"><div><p className="eyebrow">CLOUD ACCESS</p><h2>POS users / shop members</h2><p>Read-only list of accounts with active cloud shop membership.</p></div><button className="secondary" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/>{loading?'Refreshing…':'Refresh users'}</button></div><div className="notice"><span>i</span><p>This is the cloud membership directory, not a dump of desktop-local cashier profiles. Local POS-only users are not shown unless they have a cloud membership and readable profile.</p></div>{error&&<Banner error={error} retry={()=>void load()}/>}<section className="panel"><div className="panel-head"><div><h3>Active cloud accounts</h3><p>Membership rows are restricted to the current shop by RLS and an explicit shop filter.</p></div><span className="pill">{rows.length} accounts</span></div>{loading?<div className="empty"><span className="spinner"/>Loading cloud users…</div>:rows.length?<div className="table-scroll"><table><thead><tr><th>Name</th><th>Email</th><th>POS profile role</th><th>Cloud membership role</th><th>Profile status</th><th>Joined</th></tr></thead><tbody>{rows.map(r=><tr key={r.user_id}><td>{r.full_name||'Name unavailable'}<small className="subtle">{r.user_id.slice(0,8)}…</small></td><td>{r.email||'Not readable for this account'}</td><td>{r.profile_role||'Not synced'}</td><td>{r.role}</td><td>{r.profile_active===true?<span className="status">Active</span>:r.profile_active===false?<span className="low-stock">Inactive</span>:<span className="pill">Unknown</span>}</td><td>{dateTime(r.created_at)}</td></tr>)}</tbody></table></div>:<div className="empty"><Users size={25}/>No active cloud memberships are available for this shop.</div>}</section></div>;
}

function App() { return <AuthProvider><HashRouter><Routes><Route path="/login" element={<Login/>}/><Route element={<Guard/>}><Route element={<Shell/>}><Route index element={<Navigate to="/dashboard" replace/>}/><Route path="/dashboard" element={<Dashboard/>}/><Route path="/sales" element={<SalesPage/>}/><Route path="/sales/:saleId" element={<InvoiceDetailPage/>}/><Route path="/reports" element={<ReportPage/>}/><Route path="/customers" element={<CustomersPage/>}/><Route path="/day-end" element={<DayEndPage/>}/><Route path="/expenses" element={<ExpensesPage/>}/><Route path="/employees" element={<EmployeesPage/>}/></Route></Route><Route path="*" element={<Navigate to="/dashboard" replace/>}/></Routes></HashRouter></AuthProvider>; }
export default App;
