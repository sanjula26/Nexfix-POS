import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { BarChart3, CalendarDays, ChevronRight, CircleDollarSign, Download, FileText, GitBranch, LayoutDashboard, LogOut, Menu, Package, RefreshCw, Settings, Users, Wallet, Wrench, type LucideIcon } from 'lucide-react';
import './styles.css';

const url = (import.meta.env.VITE_SUPABASE_URL || '').trim();
const publicKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();
const client: SupabaseClient | null = url && publicKey ? createClient(url, publicKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  global: { headers: { 'x-client-info': 'nexfix-owner-web' } },
}) : null;
const TIME_ZONE = (import.meta.env.VITE_OWNER_WEB_TIME_ZONE || 'Asia/Colombo').trim();
const PAGE_SIZE = 50;
const CHUNK = 500;
const MAX_ROWS = 10_000;

type Shop = { id: string; name: string; currency: string | null };
type Sale = { id: string; bill_no: string; customer_name: string | null; total: number; created_at: string; status: string; amount_paid: number | null; change_amount: number | null };
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
function total(sales: Sale[]) { return sales.reduce((sum, sale) => sum + Number(sale.total || 0), 0); }
function csvCell(value: unknown) { return '"' + String(value ?? '').replace(/"/g, '""') + '"'; }
function exportCsv(filename: string, rows: unknown[][]) {
  const blob = new Blob(['\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const href = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = href; anchor.download = filename; anchor.click(); URL.revokeObjectURL(href);
}
async function getSales(db: SupabaseClient, shopId: string, from: string, to: string): Promise<Sale[]> {
  const rows: Sale[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += CHUNK) {
    const { data, error } = await db.from('sales').select('id,bill_no,customer_name,total,created_at,status,amount_paid,change_amount')
      .eq('shop_id', shopId).eq('status', 'completed').gte('created_at', from).lt('created_at', to)
      .order('created_at', { ascending: false }).range(offset, offset + CHUNK - 1);
    if (error) throw error;
    const page = (data || []) as Sale[]; rows.push(...page);
    if (page.length < CHUNK) return rows;
  }
  throw new Error('More than 10,000 completed invoices were found. Narrow the date range.');
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
  { label: 'MANAGEMENT', items: [{ label: 'Customers', icon: Users, soon: true }, { label: 'Inventory', icon: Package, soon: true }, { label: 'Expenses', icon: Wallet, soon: true }, { label: 'Repairs', icon: Wrench, soon: true }, { label: 'Settings', icon: Settings, soon: true }, { label: 'Branches', icon: GitBranch, soon: true }] },
];
function Shell() {
  const { session, shop } = useAuth(); const location = useLocation(); const [mobile, setMobile] = useState(false);
  useEffect(() => setMobile(false), [location.pathname]);
  const title = location.pathname === '/sales' ? 'Invoices / Sales' : location.pathname === '/reports' ? 'Sales report' : 'Dashboard';
  return <div className="shell">{mobile && <button className="backdrop" aria-label="Close navigation" onClick={() => setMobile(false)} />}<aside className={mobile ? 'sidebar open' : 'sidebar'}><div className="brand"><div className="logo small">N</div><div><b>NexFix</b><small>OWNER WEB</small></div><button className="close-menu" onClick={() => setMobile(false)}><span>×</span></button></div><div className="shop-chip"><span className="shop-avatar">{(shop?.name || 'N').slice(0,1)}</span><div><b>{shop?.name}</b><small>Single shop · Read only</small></div><i /></div><nav>{nav.map((group) => <div className="nav-group" key={group.label}><small>{group.label}</small>{group.items.map((item) => { const Icon = item.icon; return item.soon ? <div className="nav-item disabled" key={item.label}><Icon size={17}/><span>{item.label}</span><em>Soon</em></div> : <NavLink key={item.path} to={item.path!} className={({isActive}) => 'nav-item ' + (isActive ? 'active' : '')}><Icon size={17}/><span>{item.label}</span></NavLink>; })}</div>)}</nav><div className="sidebar-bottom"><div className="read-only"><span>✓</span><div><b>Read-only mode</b><small>POS operations stay on desktop</small></div></div><div className="account"><div className="avatar">{(session?.user.email || 'N').slice(0,1).toUpperCase()}</div><div className="account-text"><b>{session?.user.email}</b><small>Supabase account</small></div><SignOut /></div></div></aside><main><header><button className="menu" onClick={() => setMobile(true)} aria-label="Open menu"><Menu size={21}/></button><div><p className="eyebrow">NEXFIX / OWNER WEB</p><h1>{title}</h1></div><span className="secure"><i/>Secure cloud session</span></header><section className="content"><Outlet /></section><footer>NexFix Owner Web · Read-only cloud view · Shop timezone: {TIME_ZONE}</footer></main></div>;
}
function useSalesLoader() {
  const { client: db, shop } = useAuth();
  return (from: string, to: string) => {
    if (!db || !shop) return Promise.reject(new Error('Shop session is not ready.'));
    return getSales(db, shop.id, from, to);
  };
}
function Banner({ error, retry }: { error: string; retry: () => void }) { return <div className="banner error"><b>Could not load cloud sales.</b><span>{error}</span><button onClick={retry}>Try again</button></div>; }
function Stat({ label, value, note, icon: Icon, tone }: { label: string; value: string; note: string; icon: LucideIcon; tone: string }) { return <article className="stat"><div className={'stat-icon ' + tone}><Icon size={19}/></div><p>{label}</p><strong>{value}</strong><small>{note}</small></article>; }
function SalesTable({ sales, currency, loading, empty = 'No completed cloud invoices found.' }: { sales: Sale[]; currency: string; loading: boolean; empty?: string }) {
  if (loading) return <div className="empty"><span className="spinner"/>Loading invoices…</div>;
  if (!sales.length) return <div className="empty"><FileText size={25}/>{empty}</div>;
  return <div className="table-scroll"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Date</th><th className="right">Total</th><th>Status</th></tr></thead><tbody>{sales.map((s) => <tr key={s.id}><td><b className="bill">{s.bill_no}</b></td><td>{s.customer_name || 'Walk-in customer'}</td><td>{dateTime(s.created_at)}</td><td className="right amount">{money(Number(s.total), currency)}</td><td><span className="status">Completed</span></td></tr>)}</tbody></table></div>;
}
function Dashboard() {
  const { shop } = useAuth(); const loadSales = useSalesLoader(); const [sales, setSales] = useState<Sale[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [updated, setUpdated] = useState('');
  const today = dayKey(new Date()); const month = today.slice(0,7) + '-01'; const chartStart = addDays(today, -13);
  const reload = async () => { setLoading(true); setError(''); try { const rows = await loadSales(midnightIso([month,chartStart].sort()[0]), midnightIso(addDays(today,1))); setSales(rows); setUpdated(new Date().toISOString()); } catch (e) { setError(e instanceof Error ? e.message : 'Unknown query error'); } finally { setLoading(false); } };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, [shop?.id]);
  const todaySales = sales.filter((s) => dayKey(new Date(s.created_at)) === today);
  const monthSales = sales.filter((s) => s.created_at >= midnightIso(month) && s.created_at < midnightIso(addDays(today,1)));
  const days = Array.from({length:14},(_,i) => { const key=addDays(chartStart,i); const matches=sales.filter((s)=>dayKey(new Date(s.created_at))===key); return {key,label:new Intl.DateTimeFormat('en',{weekday:'short',timeZone:'UTC'}).format(new Date(key+'T12:00:00Z')),amount:total(matches),count:matches.length}; });
  const max = Math.max(1,...days.map((d)=>d.amount)); const currency = shop?.currency || 'LKR';
  return <div className="stack"><div className="welcome"><div><p className="eyebrow">SALES OVERVIEW</p><h2>Good to see you.</h2><p>Here's what's happening at {shop?.name}.</p></div><button className="secondary" onClick={() => void reload()} disabled={loading}><RefreshCw size={15}/>{loading?'Loading…':'Refresh data'}</button></div>
    {error && <Banner error={error} retry={() => void reload()}/>}<div className="notice"><span>i</span><p>Completed cloud invoice totals only. Amounts are gross invoice totals; partial returns are not netted. Offline POS sales appear after sync.</p>{updated && <small>Updated {dateTime(updated)}</small>}</div>
    <div className="stats"><Stat label="Today's sales" value={loading?'—':money(total(todaySales),currency)} note={loading?'Loading cloud rows':todaySales.length+' completed invoices'} icon={CircleDollarSign} tone="blue"/><Stat label="Month to date" value={loading?'—':money(total(monthSales),currency)} note={loading?'Loading cloud rows':monthSales.length+' completed invoices'} icon={Wallet} tone="violet"/><Stat label="Invoices today" value={loading?'—':String(todaySales.length)} note="Completed invoices only" icon={FileText} tone="green"/><Stat label="Cash in hand" value="Not available" note="Available after POS day-end sync" icon={CircleDollarSign} tone="amber"/></div>
    <section className="panel"><div className="panel-head"><div><h3>Sales over the last 14 days</h3><p>Daily completed invoice totals · {TIME_ZONE}</p></div><Link to="/reports">View report <ChevronRight size={15}/></Link></div>{loading?<div className="empty"><span className="spinner"/>Loading chart…</div>:<div className="chart"><div className="y-labels"><span>{money(max,currency)}</span><span>{money(max/2,currency)}</span><span>{money(0,currency)}</span></div><div className="bars">{days.map((d)=><div className="bar-col" key={d.key} title={d.key+' · '+money(d.amount,currency)+' · '+d.count+' invoices'}><div className="bar-track"><div className="bar-fill" style={{height:(d.amount?Math.max(3,d.amount/max*100):0)+'%'}}/></div><span>{d.label}</span><small>{d.key.slice(8)}</small></div>)}</div></div>}</section>
    <section className="panel"><div className="panel-head"><div><h3>Recent invoices</h3><p>Latest completed cloud sales</p></div><Link to="/sales">All invoices <ChevronRight size={15}/></Link></div><SalesTable sales={sales.slice(0,5)} currency={currency} loading={loading}/></section>
    <div className="deferred"><div><b>Gross profit</b><p>Deferred until cloud profit and return accounting are reconciled.</p><em>Not verified</em></div><div><b>Credit, expenses & payment mix</b><p>Deferred until full cloud coverage and balances are verified.</p><em>Not verified</em></div></div>
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
  const {shop}=useAuth(); const loadSales=useSalesLoader(); const today=dayKey(new Date());
  const [from,setFrom]=useState(addDays(today,-29)); const [to,setTo]=useState(today); const [sales,setSales]=useState<Sale[]>([]); const [loading,setLoading]=useState(true); const [error,setError]=useState(''); const [page,setPage]=useState(0);
  const load=async()=>{setLoading(true);setError('');try{checkRange(from,to);setSales(await loadSales(midnightIso(from),midnightIso(addDays(to,1))));setPage(0);}catch(e){setError(e instanceof Error?e.message:'Could not load sales.');}finally{setLoading(false);}};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{void load();},[shop?.id]);
  const currency=shop?.currency||'LKR'; const count=Math.max(1,Math.ceil(sales.length/PAGE_SIZE));
  return <div className="stack"><div className="welcome"><div><p className="eyebrow">CLOUD SALES</p><h2>Invoices / Sales</h2><p>Read-only invoices synced from {shop?.name}.</p></div><button className="secondary" disabled={loading||!sales.length} onClick={()=>exportCsv('nexfix-sales-'+from+'-to-'+to+'.csv',[['Invoice','Customer','Created at','Total','Status'],...sales.map(s=>[s.bill_no,s.customer_name||'Walk-in customer',dateTime(s.created_at),Number(s.total).toFixed(2),'Completed'])])}><Download size={15}/>Export CSV</button></div>
    <section className="panel filter-panel"><DateFilters from={from} to={to} setFrom={setFrom} setTo={setTo} today={today} submit={()=>void load()} busy={loading} label="Apply range"/><div className="summary"><small>{loading?'Loading…':sales.length+' completed invoices'}</small><b>{loading?'—':money(total(sales),currency)}</b><small>Gross invoice total · partial returns not netted</small></div></section>{error&&<Banner error={error} retry={()=>void load()}/>}
    <section className="panel"><div className="panel-head"><div><h3>Sales transactions</h3><p>{from} to {to} · {TIME_ZONE}</p></div><span className="pill">{sales.length} invoices</span></div><SalesTable sales={sales.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE)} currency={currency} loading={loading}/>{!loading&&sales.length>PAGE_SIZE&&<div className="pagination"><span>Page {page+1} of {count}</span><div><button className="secondary" disabled={!page} onClick={()=>setPage((p)=>p-1)}>Previous</button><button className="secondary" disabled={page>=count-1} onClick={()=>setPage((p)=>p+1)}>Next</button></div></div>}</section>
  </div>;
}
function ReportPage() {
  const {shop}=useAuth(); const loadSales=useSalesLoader(); const today=dayKey(new Date());
  const [from,setFrom]=useState(addDays(today,-13)); const [to,setTo]=useState(today); const [sales,setSales]=useState<Sale[]>([]); const [range,setRange]=useState(''); const [loading,setLoading]=useState(true); const [error,setError]=useState('');
  const load=async()=>{setLoading(true);setError('');try{checkRange(from,to);setSales(await loadSales(midnightIso(from),midnightIso(addDays(to,1))));setRange(from+' to '+to);}catch(e){setError(e instanceof Error?e.message:'Could not load report.');}finally{setLoading(false);}};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(()=>{void load();},[shop?.id]);
  const currency=shop?.currency||'LKR'; const daily=useMemo(()=>{if(!range)return[];const n=Math.min(366,Math.floor((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000)+1);return Array.from({length:Math.max(1,n)},(_,i)=>{const key=addDays(from,i);const list=sales.filter(s=>dayKey(new Date(s.created_at))===key);return{key,list,amount:total(list)};});},[sales,from,to,range]); const max=Math.max(1,...daily.map(d=>d.amount));
  return <div className="stack"><div className="welcome"><div><p className="eyebrow">REPORTING</p><h2>Sales report</h2><p>Choose a date range to review completed cloud invoices.</p></div><button className="secondary" disabled={loading||!range} onClick={()=>exportCsv('nexfix-report-'+from+'-to-'+to+'.csv',[['Date','Completed invoices','Gross invoice total'],...daily.map(d=>[d.key,d.list.length,d.amount.toFixed(2)]),[],['Invoice','Customer','Created at','Total'],...sales.map(s=>[s.bill_no,s.customer_name||'Walk-in customer',dateTime(s.created_at),Number(s.total).toFixed(2)])])}><Download size={15}/>Export CSV</button></div>
    <section className="panel filter-panel"><DateFilters from={from} to={to} setFrom={setFrom} setTo={setTo} today={today} submit={()=>void load()} busy={loading} label="Run report"/><div className="summary"><small>Completed invoice total</small><b>{loading?'—':money(total(sales),currency)}</b><small>{loading?'Loading cloud rows':sales.length+' invoices · '+range}</small></div></section>{error&&<Banner error={error} retry={()=>void load()}/>}
    <div className="stats"><Stat label="Sales total" value={loading?'—':money(total(sales),currency)} note="Gross completed invoice total" icon={CircleDollarSign} tone="blue"/><Stat label="Invoice count" value={loading?'—':String(sales.length)} note="Completed invoices only" icon={FileText} tone="green"/><Stat label="Average invoice" value={loading?'—':money(sales.length?total(sales)/sales.length:0,currency)} note="Total divided by invoice count" icon={BarChart3} tone="violet"/><Stat label="Cash in hand" value="Not available" note="Available after POS day-end sync" icon={Wallet} tone="amber"/></div>
    <section className="panel"><div className="panel-head"><div><h3>Daily sales breakdown</h3><p>Gross completed invoice totals by shop-local date</p></div></div>{loading?<div className="empty"><span className="spinner"/>Calculating report…</div>:<div className="daily-list">{daily.map(d=><div className="daily-row" key={d.key}><span>{d.key}</span><div className="daily-track"><div style={{width:(d.amount?Math.max(1,d.amount/max*100):0)+'%'}}/></div><small>{d.list.length} inv.</small><b>{money(d.amount,currency)}</b></div>)}</div>}</section>
  </div>;
}
function App() { return <AuthProvider><BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}><Routes><Route path="/login" element={<Login/>}/><Route element={<Guard/>}><Route element={<Shell/>}><Route index element={<Navigate to="/dashboard" replace/>}/><Route path="/dashboard" element={<Dashboard/>}/><Route path="/sales" element={<SalesPage/>}/><Route path="/reports" element={<ReportPage/>}/></Route></Route><Route path="*" element={<Navigate to="/dashboard" replace/>}/></Routes></BrowserRouter></AuthProvider>; }
export default App;
