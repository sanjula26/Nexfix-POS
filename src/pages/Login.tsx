import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Globe, Sparkles, KeyRound, ShieldCheck, Zap, RefreshCw, Mail, Lock, Eye, ArrowRight, ArrowLeft, CheckCircle2, AlertCircle, UserRound, Loader2, RotateCcw } from 'lucide-react';
import { usePOS } from '../lib/store';
import { ensureCloudSession } from '../lib/cloudAuth';
import { hashPasswordAsync } from '../lib/passwordAsync';
import { uid } from '../lib/utils';

const features = [
  { icon: KeyRound, tint: 'from-sky-500 to-blue-600', title: 'Role-Based Login', sub: 'Admin & Cashier' },
  { icon: ShieldCheck, tint: 'from-fuchsia-500 to-pink-500', title: 'Remember Me', sub: 'Stay signed in' },
  { icon: Zap, tint: 'from-emerald-500 to-teal-500', title: 'Auto IMEI Tracking', sub: 'Serial numbers auto' },
  { icon: RefreshCw, tint: 'from-violet-500 to-purple-600', title: 'Offline Mode', sub: 'Durable sync queue' },
];

export default function Login() {
  const { signIn, user, state, ready, exportData, importData, resetData } = usePOS();
  const navigate = useNavigate();
  const firstRun = ready && state.users.length === 0;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [setupName, setSetupName] = useState('');
  const [setupEmail, setSetupEmail] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [setupPin, setSetupPin] = useState('');
  const [showSetupPassword, setShowSetupPassword] = useState(false);
  const [showSetupPin, setShowSetupPin] = useState(false);

  useEffect(() => { if (user) navigate('/', { replace: true }); }, [user, navigate]);

  const resetAndStartAgain = () => {
    const confirmed = window.confirm('This will clear the current LOCAL POS data on this device and return to First-time setup. Cloud data is not deleted. Continue?');
    if (!confirmed) return;
    resetData();
    try { localStorage.removeItem('nexfix_session_v1'); sessionStorage.removeItem('nexfix_session_v1'); } catch { /* ignore */ }
    setEmail(''); setPassword(''); setError('');
  };

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    const mail = email.trim().toLowerCase();
    if (!mail || !password) { setError('Enter your email and password'); return; }
    setLoading(true); setError('');
    try {
      const res = await signIn(mail, password, remember);
      if (!res.ok) { setLoading(false); setError(res.error || 'Sign in failed'); return; }
      const cloud = await ensureCloudSession(mail, password, mail);
      setLoading(false);
      if (cloud.needsEmailConfirmation) setError('Signed in locally. Check your email to enable cloud sync on this account.');
      navigate('/', { replace: true });
    } catch { setLoading(false); setError('Sign in failed. Please try again.'); }
  };

  const bootstrap = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setError('');
    const name = setupName.trim();
    const mail = setupEmail.trim().toLowerCase();
    if (name.length < 2) return setError('Enter the administrator name');
    if (!/^\S+@\S+\.\S+$/.test(mail)) return setError('Enter a valid email address');
    if (setupPassword.length < 8) return setError('Administrator password must be at least 8 characters');
    if (setupPin.trim().length < 6) return setError('Admin security PIN must be at least 6 characters');
    setLoading(true);
    try {
      const userId = uid();
      const passwordHash = await hashPasswordAsync(setupPassword);
      const pinHash = await hashPasswordAsync(setupPin.trim());
      const next = JSON.parse(exportData()) as typeof state;
      next.users = [{ id: userId, name, email: mail, password: passwordHash, role: 'admin', active: true, createdAt: new Date().toISOString() }, ...next.users];
      next.settings = { ...next.settings, adminPinHash: pinHash };
      if (!importData(JSON.stringify(next))) throw new Error('Could not save the administrator account');
      const signedIn = await signIn(mail, setupPassword, true);
      if (!signedIn.ok) throw new Error(signedIn.error || 'Administrator account was created but could not be signed in');
      try { localStorage.setItem('nexfix_session_v1', JSON.stringify({ userId, remember: true })); sessionStorage.removeItem('nexfix_session_v1'); } catch { /* ignore */ }
      const cloud = await ensureCloudSession(mail, setupPassword, mail);
      setLoading(false);
      if (cloud.needsEmailConfirmation) setError('Account created and signed in locally. Check your email to enable cloud sync.');
      navigate('/', { replace: true });
    } catch (err) { setLoading(false); setError(err instanceof Error ? err.message : 'Initial setup failed'); }
  };

  if (!ready) return <div className="min-h-screen flex items-center justify-center bg-[#f5f6fb]"><div className="bg-white rounded-3xl shadow-xl border border-[#eceef6] px-8 py-7 text-center"><Loader2 size={28} className="mx-auto text-violet-600 animate-spin" /><p className="mt-3 text-sm font-semibold text-[#17133c]">Loading POS data…</p><p className="mt-1 text-xs text-[#7b7f9f]">Please wait while your saved account is loaded.</p></div></div>;

  return <div className="min-h-screen flex bg-[#f5f6fb]">
    <div className="hidden md:flex flex-col justify-center w-[52%] xl:w-1/2 relative overflow-hidden px-12 xl:px-20 py-14 text-white" style={{ background: 'linear-gradient(155deg, #0d0a24 0%, #17123c 55%, #1d1550 100%)' }}>
      <div className="absolute -top-32 -left-32 w-[480px] h-[480px] rounded-full opacity-30" style={{ background: 'radial-gradient(circle, #7c3aed 0%, transparent 65%)' }} /><div className="absolute bottom-[-180px] right-[-120px] w-[520px] h-[520px] rounded-full opacity-25" style={{ background: 'radial-gradient(circle, #0ea5e9 0%, transparent 65%)' }} />
      <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }} className="relative max-w-lg">
        <div className="flex items-center gap-4 mb-9"><span className="inline-flex items-center gap-2 text-[11px] font-semibold text-violet-200 bg-white/[0.07] border border-white/10 rounded-full px-3.5 py-2"><Sparkles size={12} className="text-violet-300" /> Sri Lanka's #1 Electronics POS</span><div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500 via-indigo-500 to-sky-400 flex items-center justify-center shadow-2xl"><Globe size={26} /></div></div>
        <h1 className="font-display text-5xl xl:text-6xl font-extrabold leading-[1.05] tracking-tight">NEXFIX <span className="bg-gradient-to-r from-sky-300 via-indigo-300 to-violet-300 bg-clip-text text-transparent">SOLUTION</span></h1><p className="mt-4 text-[15px] text-[#a9add4] font-medium">POS &amp; Inventory Management System <span className="text-[#6e72a2]">&middot; v3.1</span></p>
        <div className="grid grid-cols-2 gap-3.5 mt-10">{features.map((f, i) => <motion.div key={f.title} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + i * 0.08, duration: 0.45 }} className="rounded-2xl bg-white/[0.05] border border-white/[0.09] p-4"><span className={`inline-flex w-9 h-9 rounded-xl bg-gradient-to-br ${f.tint} items-center justify-center shadow-lg mb-3`}><f.icon size={17} /></span><div className="text-sm font-bold">{f.title}</div><div className="text-[11px] text-[#8f93bd] mt-0.5">{f.sub}</div></motion.div>)}</div>
        <div className="mt-12 pt-6 border-t border-white/10 text-xs text-[#7f83ad] font-medium">Nexfix Solution &middot; +94 74 109 7350 &middot; info@nexfixsolution.com</div>
      </motion.div>
    </div>
    <div className="flex-1 flex items-center justify-center p-6 relative"><div className="absolute top-6 left-6 md:hidden flex items-center gap-2.5"><div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center text-white"><Globe size={17} /></div><span className="font-display font-extrabold text-[#17133c]">NEXFIX SOLUTION</span></div>
      <div className="w-full max-w-md">{!firstRun && <Link to="/signup" className="inline-flex items-center gap-2 text-xs font-semibold text-violet-600 bg-violet-500/10 border border-violet-500/20 rounded-full px-4 py-2 mb-5"><ArrowLeft size={13} /> New customer? Register here</Link>}
        <motion.div initial={{ opacity: 0, y: 22 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }} className="bg-white rounded-3xl shadow-[0_24px_70px_-24px_rgba(23,19,60,0.35)] border border-[#eceef6] overflow-hidden"><div className="h-1.5 bg-gradient-to-r from-violet-600 via-indigo-500 to-sky-400" /><div className="p-7 sm:p-9">
          {firstRun ? <><h2 className="font-display text-[26px] font-extrabold text-[#17133c] flex items-center gap-2">First-time setup <span className="inline-flex w-7 h-7 rounded-lg bg-emerald-100 items-center justify-center"><ShieldCheck size={15} className="text-emerald-600" /></span></h2><p className="text-sm text-[#5b5f7e] mt-1">Create the first administrator account for this POS installation.</p>
            <form onSubmit={bootstrap} className="mt-7 space-y-4"><Field label="ADMINISTRATOR NAME"><input required className="input !bg-[#f5f6fb] !border-[#e7e9f2] !py-3" placeholder="Your name" value={setupName} onChange={e => setSetupName(e.target.value)} autoComplete="name" /></Field><Field label="ADMIN EMAIL"><input required className="input !bg-[#f5f6fb] !border-[#e7e9f2] !py-3" placeholder="admin@yourshop.lk" value={setupEmail} onChange={e => setSetupEmail(e.target.value)} type="email" autoComplete="username" /></Field><Field label="ADMIN PASSWORD"><div className="relative"><input required minLength={8} className="input !bg-[#f5f6fb] !border-[#e7e9f2] pr-10 !py-3" placeholder="At least 8 characters" type={showSetupPassword ? 'text' : 'password'} value={setupPassword} onChange={e => setSetupPassword(e.target.value)} autoComplete="new-password" /><button type="button" onClick={() => setShowSetupPassword(s => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9a9ebf]"><Eye size={15} /></button></div></Field><Field label="ADMIN SECURITY PIN"><div className="relative"><input required minLength={6} className="input !bg-[#f5f6fb] !border-[#e7e9f2] pr-10 !py-3" placeholder="At least 6 characters" type={showSetupPin ? 'text' : 'password'} value={setupPin} onChange={e => setSetupPin(e.target.value)} autoComplete="new-password" /><button type="button" onClick={() => setShowSetupPin(s => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9a9ebf]"><Eye size={15} /></button></div></Field>{error && <ErrorBox text={error} />}<button type="submit" disabled={loading} className="btn btn-primary w-full !py-3.5 !text-[15px] !rounded-xl">{loading ? <Loader2 size={17} className="animate-spin" /> : <>Create administrator <ArrowRight size={16} /></>}</button></form><p className="text-[11px] text-[#7b7f9f] mt-5 leading-relaxed">The password and security PIN are stored as salted PBKDF2 hashes. No default credentials are shipped.</p></>
          : <><h2 className="font-display text-[26px] font-extrabold text-[#17133c] flex items-center gap-2">Welcome back <span className="inline-flex w-7 h-7 rounded-lg bg-amber-100 items-center justify-center"><UserRound size={15} className="text-amber-600" /></span></h2><p className="text-sm text-[#5b5f7e] mt-1">Sign in to access your dashboard</p><form onSubmit={submit} className="mt-7 space-y-4"><Field label="EMAIL"><input className="input !bg-[#f5f6fb] !border-[#e7e9f2] !py-3" placeholder="you@shop.lk" value={email} onChange={e => setEmail(e.target.value)} type="email" autoComplete="username" /></Field><Field label="PASSWORD"><div className="relative"><input className="input !bg-[#f5f6fb] !border-[#e7e9f2] pr-10 !py-3" placeholder="•••••••••••" type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" /><button type="button" onClick={() => setShowPw(s => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9a9ebf]"><Eye size={15} /></button></div></Field><label className="flex items-center gap-2 cursor-pointer select-none"><span onClick={() => setRemember(r => !r)} className={`w-[18px] h-[18px] rounded-[5px] flex items-center justify-center border ${remember ? 'bg-indigo-600 border-indigo-600' : 'bg-white border-[#d4d7ea]'}`}>{remember && <CheckCircle2 size={12} className="text-white" />}</span><span className="text-[13px] text-[#5b5f7e] font-medium">Remember me</span></label>{error && <ErrorBox text={error} />}<button type="submit" disabled={loading} className="btn btn-primary w-full !py-3.5 !text-[15px] !rounded-xl">{loading ? <Loader2 size={17} className="animate-spin" /> : <>Sign in &amp; stay logged in <ArrowRight size={16} /></>}</button></form><button type="button" onClick={resetAndStartAgain} className="mt-5 w-full inline-flex items-center justify-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-[12px] font-semibold text-amber-700 hover:bg-amber-100"><RotateCcw size={14} /> Can't sign in? Start setup again</button><p className="text-center text-[13px] text-[#5b5f7e] mt-5">Don't have an account? <Link to="/signup" className="font-bold text-violet-600 hover:text-violet-700">Sign up</Link></p></>}
        </div></motion.div>
      </div>
    </div>
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><span className="block text-[11px] font-bold tracking-wider text-[#5b5f7e] mb-1.5">{label}</span>{children}</div>; }
function ErrorBox({ text }: { text: string }) { return <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2 text-[13px] font-medium text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-3.5 py-2.5"><AlertCircle size={15} /> {text}</motion.div>; }
