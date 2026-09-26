import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  ArrowRight,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  Moon,
  ShieldCheck,
  Smartphone,
  WifiOff,
  UserRound,
  Sun,
} from 'lucide-react';
import { usePOS } from '../lib/store';
import { ensureCloudSession } from '../lib/cloudAuth';

const REMEMBER_KEYS: Record<LoginRole, string> = {
  admin: 'nexfix_login_remember_admin',
  cashier: 'nexfix_login_remember_cashier',
};
type LoginRole = 'admin' | 'cashier';
interface RememberedLogin {
  email: string;
  role: LoginRole;
  remember: true;
}

function loadRememberedLogin(role: LoginRole): RememberedLogin | null {
  try {
    const raw = localStorage.getItem(REMEMBER_KEYS[role]);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RememberedLogin>;
    if (
      parsed.remember !== true ||
      typeof parsed.email !== 'string' ||
      !/^\S+@\S+\.\S+$/.test(parsed.email) ||
      parsed.role !== role
    ) {
      localStorage.removeItem(REMEMBER_KEYS[role]);
      return null;
    }
    return { email: parsed.email, role, remember: true };
  } catch {
    return null;
  }
}

function saveRememberedLogin(email: string, role: LoginRole) {
  try {
    const payload: RememberedLogin = { email, role, remember: true };
    localStorage.setItem(REMEMBER_KEYS[role], JSON.stringify(payload));
  } catch {
    // Credential memory is optional; sign-in itself must still work.
  }
}

function clearRememberedLogin(role: LoginRole) {
  try {
    localStorage.removeItem(REMEMBER_KEYS[role]);
  } catch {
    // Ignore storage failures; never block login.
  }
}

function migrateLegacyRememberedLogin() {
  try {
    const raw = localStorage.getItem('nexfix_login_remember');
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<RememberedLogin>;
    if (parsed.remember === true && typeof parsed.email === 'string' && (parsed.role === 'admin' || parsed.role === 'cashier')) {
      saveRememberedLogin(parsed.email, parsed.role);
    }
    localStorage.removeItem('nexfix_login_remember');
  } catch {
    // Ignore legacy storage migration failures.
  }
}

function BrandingHero() {
  return (
    <section className="relative flex min-h-[360px] w-full flex-1 flex-col justify-center overflow-hidden px-6 py-10 sm:px-10 lg:min-h-screen lg:px-12 xl:px-16">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-60 dark:opacity-45"
        style={{
          backgroundImage:
            'linear-gradient(rgba(79,70,229,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(14,165,233,0.07) 1px, transparent 1px)',
          backgroundSize: '34px 34px',
          maskImage: 'linear-gradient(to bottom right, black, transparent 85%)',
        }}
      />
      <div aria-hidden="true" className="pointer-events-none absolute -left-24 top-1/4 h-72 w-72 rounded-full bg-sky-500/10 blur-3xl dark:bg-cyan-500/15" />
      <div aria-hidden="true" className="pointer-events-none absolute bottom-0 right-0 h-80 w-80 rounded-full bg-indigo-500/[0.06] blur-3xl dark:bg-indigo-500/15" />

      <div className="relative z-10 mx-auto w-full max-w-2xl">
        <div className="mb-5 inline-flex items-center rounded-full border border-sky-500/25 bg-sky-500/[0.07] px-3.5 py-2 text-[11px] font-bold tracking-[0.08em] text-sky-700 dark:border-cyan-400/30 dark:bg-cyan-400/10 dark:text-cyan-200 shadow-[0_0_24px_rgba(34,211,238,0.12)]">
          Sri Lanka's Trusted Retail POS
        </div>

        <div className="flex items-center gap-4">
          <div className="relative grid h-16 w-16 shrink-0 place-items-center rounded-2xl border border-cyan-500/40 bg-gradient-to-br from-cyan-300 via-sky-500 to-indigo-600 shadow-[0_0_34px_rgba(14,165,233,0.22)] dark:border-cyan-300/50 dark:shadow-[0_0_38px_rgba(34,211,238,0.35)]">
            <div className="absolute inset-1 rounded-xl border border-white/25" />
            <span className="relative text-xl font-black tracking-tight text-white">NX</span>
          </div>
          <div>
            <h1 className="text-[clamp(2.4rem,5vw,5.2rem)] font-black leading-[0.9] tracking-[-0.055em]">
              <span className="text-[#17133c] dark:text-white">NEXFIX</span>{' '}
              <span className="bg-gradient-to-r from-cyan-300 via-sky-400 to-indigo-400 bg-clip-text text-transparent">SOLUTION</span>
            </h1>
            <p className="mt-3 text-sm font-medium tracking-wide text-[#5b5f7e] dark:text-slate-300 sm:text-base">
              POS &amp; Inventory Management System · v3.0.4
            </p>
          </div>
        </div>

        <div className="mt-9 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FeatureCard
            icon={<UserRound size={17} />}
            title="Role-Based Login"
            detail="Admin & Cashier"
            tone="lime"
          />
          <FeatureCard
            icon={<ShieldCheck size={17} />}
            title="Remember Me"
            detail="Stay signed in"
            tone="pink"
          />
          <FeatureCard
            icon={<Smartphone size={17} />}
            title="Auto IMEI Tracking"
            detail="Serial numbers auto"
            tone="green"
          />
          <FeatureCard
            icon={<WifiOff size={17} />}
            title="Offline Mode"
            detail="Auto sync queue"
            tone="cyan"
          />
        </div>

        <p className="mt-8 text-xs font-medium tracking-wide text-[#6f7391] dark:text-slate-400">
          Nexfix Solution ·{' '}
          <a className="transition hover:text-sky-600 dark:hover:text-cyan-300" href="tel:+94741097350">+94 74 109 7350</a>
          {' · '}
          <a className="transition hover:text-cyan-300" href="mailto:nexfixsolution@gmail.com">nexfixsolution@gmail.com</a>
        </p>
      </div>
    </section>
  );
}

function FeatureCard({
  icon,
  title,
  detail,
  tone,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  tone: 'lime' | 'pink' | 'green' | 'cyan';
}) {
  const tones = {
    lime: 'border-lime-300/45 bg-lime-500/[0.05] text-lime-700 shadow-[0_0_24px_rgba(190,242,100,0.07)] dark:bg-lime-300/[0.05] dark:text-lime-200 dark:shadow-[0_0_24px_rgba(190,242,100,0.09)]',
    pink: 'border-fuchsia-300/45 bg-fuchsia-500/[0.05] text-fuchsia-700 shadow-[0_0_24px_rgba(232,121,249,0.07)] dark:bg-fuchsia-300/[0.05] dark:text-fuchsia-200 dark:shadow-[0_0_24px_rgba(232,121,249,0.09)]',
    green: 'border-emerald-300/45 bg-emerald-500/[0.05] text-emerald-700 shadow-[0_0_24px_rgba(52,211,153,0.07)] dark:bg-emerald-300/[0.05] dark:text-emerald-200 dark:shadow-[0_0_24px_rgba(52,211,153,0.09)]',
    cyan: 'border-cyan-300/45 bg-cyan-500/[0.05] text-cyan-700 shadow-[0_0_24px_rgba(34,211,238,0.07)] dark:bg-cyan-300/[0.05] dark:text-cyan-200 dark:shadow-[0_0_24px_rgba(34,211,238,0.09)]',
  };
  return (
    <div className={`rounded-2xl border px-4 py-4 backdrop-blur-sm transition duration-200 hover:-translate-y-0.5 ${tones[tone]}`}>
      <div className="flex items-center gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-black/[0.04] dark:bg-black/20">{icon}</div>
        <div>
          <p className="text-sm font-bold text-[#17133c] dark:text-slate-100">{title}</p>
          <p className="mt-0.5 text-xs text-[#6f7391] dark:text-slate-400">{detail}</p>
        </div>
      </div>
    </div>
  );
}

function AuthCard({
  children,
  setup = false,
}: {
  children: React.ReactNode;
  setup?: boolean;
}) {
  return (
    <section className="relative flex w-full items-center justify-center px-5 py-8 sm:px-8 lg:min-h-screen lg:px-10">
      <div className="pointer-events-none absolute inset-0 hidden lg:block">
        <div className="absolute right-[-8rem] top-[12%] h-72 w-72 rounded-full bg-sky-500/[0.06] blur-3xl dark:bg-cyan-500/10" />
        <div className="absolute bottom-[10%] left-[15%] h-64 w-64 rounded-full bg-indigo-500/10 blur-3xl" />
        <div className="absolute right-[18%] top-[24%] h-2 w-2 rounded-full bg-sky-400 shadow-[0_0_18px_5px_rgba(14,165,233,0.22)] dark:bg-cyan-300 dark:shadow-[0_0_18px_5px_rgba(103,232,249,0.35)]" />
        <div className="absolute right-[30%] bottom-[24%] h-1.5 w-1.5 rounded-full bg-sky-400 shadow-[0_0_15px_4px_rgba(14,165,233,0.18)] dark:bg-sky-300 dark:shadow-[0_0_15px_4px_rgba(125,211,252,0.3)]" />
      </div>
      <div className={`relative w-full max-w-[460px] overflow-hidden rounded-[28px] border border-slate-200 bg-white/90 shadow-[0_25px_80px_rgba(15,23,42,0.10)] backdrop-blur-xl dark:border-cyan-300/20 dark:bg-[#071225]/90 dark:shadow-[0_25px_80px_rgba(2,8,23,0.55)] ${setup ? 'my-2' : 'lg:my-10'}`}>
        <div className="h-1 bg-gradient-to-r from-cyan-300 via-sky-400 to-indigo-500" />
        {children}
      </div>
    </section>
  );
}

export default function Login() {
  const { signIn, createInitialAdmin, user, ready, state, dark, toggleTheme } = usePOS();
  const navigate = useNavigate();
  const location = useLocation();
  const [loginRole, setLoginRole] = useState<LoginRole>('admin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [setupName, setSetupName] = useState('');
  const [setupEmail, setSetupEmail] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [setupConfirm, setSetupConfirm] = useState('');
  const [setupCashierName, setSetupCashierName] = useState('');
  const [setupCashierEmail, setSetupCashierEmail] = useState('');
  const [setupCashierPassword, setSetupCashierPassword] = useState('');
  const [setupCashierConfirm, setSetupCashierConfirm] = useState('');

  const nextPath = (() => {
    const next = new URLSearchParams(location.search).get('next') || '';
    return next.startsWith('/') && !next.startsWith('//') ? next : '';
  })();

  useEffect(() => {
    if (!ready || user) return;
    migrateLegacyRememberedLogin();
    const saved = loadRememberedLogin(loginRole);
    if (!saved) return;
    setEmail(saved.email);
    setRemember(true);
  }, [ready, user]);

  useEffect(() => {
    if (!ready || user) return;
    const saved = loadRememberedLogin(loginRole);
    setEmail(saved?.email || '');
    setRemember(Boolean(saved));
    setPassword('');
    setError('');
  }, [loginRole, ready, user]);

  useEffect(() => {
    if (!user) return;
    setLoading(false);
    navigate(nextPath || (user.role === 'admin' || user.role === 'manager' ? '/dashboard' : '/pos'), { replace: true });
  }, [user, navigate, nextPath]);

  const setupAdmin = async (e?: FormEvent) => {
    e?.preventDefault();
    if (loading) return;
    const normalizedEmail = setupEmail.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) { setError('Enter a valid email address'); return; }
    if (setupPassword !== setupConfirm) { setError('Administrator passwords do not match'); return; }
    const cashierMail = setupCashierEmail.trim().toLowerCase();
    if (setupCashierName.trim().length < 2) { setError('Enter the cashier name'); return; }
    if (!/^\S+@\S+\.\S+$/.test(cashierMail)) { setError('Enter a valid cashier email address'); return; }
    if (cashierMail === normalizedEmail) { setError('Admin and cashier must use different email addresses'); return; }
    if (setupCashierPassword.length < 12) { setError('Cashier password must be at least 12 characters'); return; }
    if (setupCashierPassword !== setupCashierConfirm) { setError('Cashier passwords do not match'); return; }
    setLoading(true);
    setError('');
    try {
      const result = await createInitialAdmin(setupName, normalizedEmail, setupPassword, { name: setupCashierName, email: cashierMail, password: setupCashierPassword });
      if (!result.ok) { setError(result.error || 'Administrator setup failed'); setLoading(false); return; }
    } catch { setError('Administrator setup failed. Please try again.'); setLoading(false); }
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready || loading) return;
    const mail = email.trim().toLowerCase();
    if (!mail || !password) { setError('Enter your email and password'); return; }
    if (!/^\S+@\S+\.\S+$/.test(mail)) { setError('Enter a valid email address'); return; }
    setLoading(true);
    setError('');
    try {
      const result = await signIn(mail, password, remember, loginRole);
      if (!result.ok) {
        setError(result.error || 'Incorrect email or password');
        setLoading(false);
        return;
      }
      if (remember) saveRememberedLogin(mail, loginRole);
      else clearRememberedLogin(loginRole);
      void ensureCloudSession(mail, password, mail).catch(() => {});
      window.setTimeout(() => {
        setLoading(prev => {
          if (prev) setError('Session did not start. Clear site data (or use a private window) and try again.');
          return false;
        });
      }, 5000);
    } catch {
      setError('Sign in failed. Please try again.');
      setLoading(false);
    }
  };

  const handleRememberChange = (checked: boolean) => {
    setRemember(checked);
    if (!checked) clearRememberedLogin(loginRole);
  };

  if (!ready) {
    return (
      <div className="min-h-screen grid place-items-center bg-[#f5f6fb] text-[#17133c] dark:bg-[#030a18] dark:text-slate-100">
        <Loader2 size={30} className="animate-spin text-cyan-300" />
      </div>
    );
  }

  if (user) {
    return (
      <div className="min-h-screen grid place-items-center bg-[#030a18] text-slate-100">
        <Loader2 size={30} className="animate-spin text-cyan-300" />
      </div>
    );
  }

  const page = (
    <main className="relative min-h-screen overflow-x-hidden bg-[#f5f6fb] text-[#17133c] dark:bg-[#030a18] dark:text-slate-100">
      <div className="min-h-screen lg:grid lg:grid-cols-[1.05fr_0.95fr]">
        <button type="button" onClick={toggleTheme} aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} title={dark ? 'Switch to light mode' : 'Switch to dark mode'} className="absolute right-5 top-5 z-30 grid h-10 w-10 place-items-center rounded-xl border border-slate-300 bg-white/85 text-slate-600 shadow-lg backdrop-blur transition hover:border-sky-400 hover:text-sky-600 dark:border-white/10 dark:bg-[#0b1930]/90 dark:text-slate-300 dark:hover:border-cyan-400 dark:hover:text-cyan-300">
          {dark ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        <BrandingHero />
        {state.users.length === 0 ? (
          <AuthCard setup>
            <div className="p-6 sm:p-8">
              <div className="mb-5 flex items-center gap-3">
                <div className="grid h-11 w-11 place-items-center rounded-xl border border-cyan-300/30 bg-cyan-400/10 text-cyan-200"><ShieldCheck size={21} /></div>
                <div>
                  <h2 className="text-2xl font-black tracking-tight text-[#17133c] dark:text-white">Set up your administrator</h2>
                  <p className="mt-1 text-xs text-[#6f7391] dark:text-slate-400">Create the first secure POS accounts.</p>
                </div>
              </div>
              <form onSubmit={setupAdmin} className="space-y-3.5">
                <input required value={setupName} onChange={e => setSetupName(e.target.value)} className="input w-full !rounded-xl !border-slate-200 !bg-[#f0f1f8] !py-3 !text-[#17133c] placeholder:!text-[#9a9ebf] focus:!border-sky-400/70 dark:!border-white/10 dark:!bg-[#0b1930] dark:!text-white dark:placeholder:!text-[#8a8eaa] dark:text-slate-500 dark:focus:!border-cyan-400/60" placeholder="Administrator name" autoComplete="name" />
                <input required type="text" inputMode="email" value={setupEmail} onChange={e => setSetupEmail(e.target.value)} className="input w-full !rounded-xl !border-slate-200 !bg-[#f0f1f8] dark:!border-white/10 dark:!bg-[#0b1930] !py-3 !text-white placeholder:!text-slate-500 focus:!border-cyan-400/60" placeholder="Administrator email" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                <input required type="password" minLength={12} value={setupPassword} onChange={e => setSetupPassword(e.target.value)} className="input w-full !rounded-xl !border-slate-200 !bg-[#f0f1f8] !py-3 !text-[#17133c] placeholder:!text-[#9a9ebf] focus:!border-sky-400/70 dark:!border-white/10 dark:!bg-[#0b1930] dark:!text-white dark:placeholder:!text-slate-500 dark:focus:!border-cyan-400/60" placeholder="Strong password (12+ characters)" autoComplete="new-password" />
                <input required type="password" minLength={12} value={setupConfirm} onChange={e => setSetupConfirm(e.target.value)} className="input w-full !rounded-xl !border-slate-200 !bg-[#f0f1f8] !py-3 !text-[#17133c] placeholder:!text-[#9a9ebf] focus:!border-sky-400/70 dark:!border-white/10 dark:!bg-[#0b1930] dark:!text-white dark:placeholder:!text-slate-500 dark:focus:!border-cyan-400/60" placeholder="Confirm password" autoComplete="new-password" />
                <div className="my-2 border-t border-slate-200 pt-3 dark:border-white/10">
                  <p className="mb-2 text-[10px] font-bold tracking-[0.18em] text-sky-600 dark:text-cyan-300/80">CASHIER ACCOUNT</p>
                  <div className="grid gap-3">
                    <input required value={setupCashierName} onChange={e => setSetupCashierName(e.target.value)} className="input w-full !rounded-xl !border-slate-200 !bg-[#f0f1f8] !py-3 !text-[#17133c] placeholder:!text-[#9a9ebf] focus:!border-sky-400/70 dark:!border-white/10 dark:!bg-[#0b1930] dark:!text-white dark:placeholder:!text-slate-500 dark:focus:!border-cyan-400/60" placeholder="Cashier name" autoComplete="name" />
                    <input required type="text" inputMode="email" value={setupCashierEmail} onChange={e => setSetupCashierEmail(e.target.value)} className="input w-full !rounded-xl !border-slate-200 !bg-[#f0f1f8] !py-3 !text-[#17133c] placeholder:!text-[#9a9ebf] focus:!border-sky-400/70 dark:!border-white/10 dark:!bg-[#0b1930] dark:!text-white dark:placeholder:!text-slate-500 dark:focus:!border-cyan-400/60" placeholder="Cashier email" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                    <input required type="password" minLength={12} value={setupCashierPassword} onChange={e => setSetupCashierPassword(e.target.value)} className="input w-full !rounded-xl !border-slate-200 !bg-[#f0f1f8] !py-3 !text-[#17133c] placeholder:!text-[#9a9ebf] focus:!border-sky-400/70 dark:!border-white/10 dark:!bg-[#0b1930] dark:!text-white dark:placeholder:!text-slate-500 dark:focus:!border-cyan-400/60" placeholder="Cashier password (12+ characters)" autoComplete="new-password" />
                    <input required type="password" minLength={12} value={setupCashierConfirm} onChange={e => setSetupCashierConfirm(e.target.value)} className="input w-full !rounded-xl !border-slate-200 !bg-[#f0f1f8] !py-3 !text-[#17133c] placeholder:!text-[#9a9ebf] focus:!border-sky-400/70 dark:!border-white/10 dark:!bg-[#0b1930] dark:!text-white dark:placeholder:!text-slate-500 dark:focus:!border-cyan-400/60" placeholder="Confirm cashier password" autoComplete="new-password" />
                  </div>
                </div>
                {error && <ErrorAlert message={error} />}
                <button type="submit" disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-400 via-sky-500 to-indigo-500 !py-3.5 text-sm font-extrabold text-white shadow-[0_12px_32px_rgba(14,165,233,0.22)] transition hover:brightness-110 disabled:opacity-60">
                  {loading ? <Loader2 size={18} className="animate-spin" /> : <>Create administrator <ArrowRight size={17} /></>}
                </button>
              </form>
            </div>
          </AuthCard>
        ) : (
          <AuthCard>
            <div className="p-7 sm:p-9 lg:p-10">
              <div>
                <h2 className="text-3xl font-black tracking-tight text-[#17133c] dark:text-white">NEXFIX SOLUTION</h2>
                <p className="mt-2 text-sm text-[#6f7391] dark:text-slate-400">Sign in to your POS account</p>
              </div>

              <div className="mt-7 grid grid-cols-2 gap-1.5 rounded-xl border border-slate-200 bg-[#f0f1f8] p-1.5 dark:border-white/10 dark:bg-[#0b1930]">
                <button type="button" onClick={() => { setLoginRole('admin'); setError(''); }} className={`rounded-lg py-3 text-xs font-black tracking-wider transition ${loginRole === 'admin' ? 'bg-gradient-to-r from-sky-400 to-blue-600 text-white shadow-[0_6px_20px_rgba(59,130,246,0.28)]' : 'text-[#7b7f9c] hover:text-[#17133c] dark:text-slate-400 dark:hover:text-white'}`}>ADMIN</button>
                <button type="button" onClick={() => { setLoginRole('cashier'); setError(''); }} className={`rounded-lg py-3 text-xs font-black tracking-wider transition ${loginRole === 'cashier' ? 'bg-gradient-to-r from-teal-400 to-emerald-600 text-white shadow-[0_6px_20px_rgba(20,184,166,0.25)]' : 'text-[#7b7f9c] hover:text-[#17133c] dark:text-slate-400 dark:hover:text-white'}`}>CASHIER</button>
              </div>

              <form onSubmit={submit} className="mt-7 space-y-5">
                <label className="block">
                  <span className="mb-2 block text-[10px] font-bold tracking-[0.2em] text-[#7b7f9c] dark:text-slate-400">EMAIL</span>
                  <div className="relative">
                    <Mail size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#8a8eaa] dark:text-slate-500" />
                    <input required type="text" inputMode="email" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={email} onChange={e => setEmail(e.target.value)} className="input w-full !rounded-xl !border-slate-200 !bg-[#f0f1f8] !py-3.5 !pl-10 !text-[#17133c] placeholder:!text-[#9a9ebf] focus:!border-sky-400/70 focus:!ring-sky-400/20 dark:!border-white/10 dark:!bg-[#0b1930] dark:!text-white dark:placeholder:!text-slate-600 dark:focus:!border-cyan-400/70 dark:focus:!ring-cyan-400/20" placeholder="you@shop.lk" />
                  </div>
                </label>

                <label className="block">
                  <span className="mb-2 block text-[10px] font-bold tracking-[0.2em] text-[#7b7f9c] dark:text-slate-400">PASSWORD</span>
                  <div className="relative">
                    <Lock size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
                    <input required type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} className="input w-full !rounded-xl !border-slate-200 !bg-[#f0f1f8] !py-3.5 !pl-10 !pr-11 !text-[#17133c] placeholder:!text-[#9a9ebf] focus:!border-sky-400/70 focus:!ring-sky-400/20 dark:!border-white/10 dark:!bg-[#0b1930] dark:!text-white dark:placeholder:!text-slate-600 dark:focus:!border-cyan-400/70 dark:focus:!ring-cyan-400/20" placeholder="Password" />
                    <button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(v => !v)} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[#8a8eaa] transition hover:text-sky-600 dark:text-slate-500 dark:hover:text-cyan-300">
                      {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </div>
                </label>

                <label className="flex cursor-pointer items-center gap-2.5 text-xs font-medium text-[#6f7391] select-none dark:text-slate-400">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={e => handleRememberChange(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 bg-white text-cyan-500 accent-cyan-500 dark:border-slate-600 dark:bg-[#0b1930] dark:text-cyan-400 dark:accent-cyan-400"
                  />
                  <span>Remember me</span>
                </label>

                {error && <ErrorAlert message={error} />}

                <button type="submit" disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-400 via-sky-500 to-blue-600 !py-3.5 text-[15px] font-extrabold text-white shadow-[0_14px_34px_rgba(14,165,233,0.2)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60">
                  {loading ? <Loader2 size={19} className="animate-spin" /> : <>Sign in <ArrowRight size={17} /></>}
                </button>
              </form>

              <p className="mt-7 text-center text-[11px] leading-5 text-[#8a8eaa] dark:text-slate-500">
                Your password is never stored in Remember me data.
              </p>
            </div>
          </AuthCard>
        )}
      </div>
    </main>
  );

  return page;
}

function ErrorAlert({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-rose-300 bg-rose-50 px-3.5 py-3 text-[12px] font-medium text-rose-700 dark:border-rose-400/25 dark:bg-rose-500/10 dark:text-rose-200">
      <AlertCircle size={16} className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
