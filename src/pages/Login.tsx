import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Loader2, Lock, Mail, ArrowRight, AlertCircle, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { usePOS } from '../lib/store';
import { ensureCloudSession } from '../lib/cloudAuth';

export default function Login() {
  const { signIn, createInitialAdmin, user, ready, state } = usePOS();
  const navigate = useNavigate();
  const location = useLocation();
  const [loginRole, setLoginRole] = useState<'admin' | 'cashier'>('admin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
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
    if (!user) return;
    setLoading(false);
    navigate(nextPath || (user.role === 'admin' || user.role === 'manager' ? '/dashboard' : '/pos'), { replace: true });
  }, [user, navigate, nextPath]);

  const setupAdmin = async (e?: FormEvent) => {
    e?.preventDefault();
    if (loading) return;
    const normalizedEmail = setupEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) { setError('Enter a valid email address'); return; }
    if (setupPassword !== setupConfirm) { setError('Administrator passwords do not match'); return; }
    const cashierMail = setupCashierEmail.trim().toLowerCase();
    if (setupCashierName.trim().length < 2) { setError('Enter the cashier name'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cashierMail)) { setError('Enter a valid cashier email address'); return; }
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

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!ready || loading) return;
    const mail = email.trim().toLowerCase();
    if (!mail || !password) {
      setError('Enter your email and password');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      setError('Enter a valid email address');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await signIn(mail, password, remember, loginRole);
      if (!result.ok) {
        setError(result.error || 'Incorrect email or password');
        setLoading(false);
        return;
      }
      void ensureCloudSession(mail, password, mail).catch(() => {});
      window.setTimeout(() => {
        setLoading(prev => {
          if (prev) {
            setError('Session did not start. Clear site data (or use a private window) and try again.');
          }
          return false;
        });
      }, 5000);
    } catch {
      setError('Sign in failed. Please try again.');
      setLoading(false);
    }
  };

  if (!ready) {
    return (
      <div className="min-h-screen grid place-items-center bg-[#f5f6fb]">
        <Loader2 size={30} className="text-violet-600 animate-spin" />
      </div>
    );
  }

  if (user) {
    return (
      <div className="min-h-screen grid place-items-center bg-[#f5f6fb]">
        <Loader2 size={30} className="text-violet-600 animate-spin" />
      </div>
    );
  }

  if (state.users.length === 0) {
    return (
      <div className="min-h-screen grid place-items-center bg-[#f5f6fb] p-5">
        <div className="w-full max-w-md bg-white rounded-3xl shadow-xl border border-[#eceef6] overflow-hidden">
          <div className="h-1.5 bg-gradient-to-r from-violet-600 via-indigo-500 to-sky-400" />
          <div className="p-7 sm:p-9">
            <div className="inline-flex w-11 h-11 rounded-xl bg-violet-600 text-white items-center justify-center mb-4"><ShieldCheck size={21} /></div>
            <h1 className="text-2xl font-extrabold text-[#17133c]">Set up your administrator</h1>
            <p className="text-sm text-[#5b5f7e] mt-2">This is the first-run setup for this POS device. No default password is created.</p>
            <form onSubmit={setupAdmin} className="mt-7 space-y-4">
              <input required value={setupName} onChange={e=>setSetupName(e.target.value)} className="input !bg-[#f5f6fb] w-full !py-3" placeholder="Administrator name" autoComplete="name" />
              <input required type="text" inputMode="email" value={setupEmail} onChange={e=>setSetupEmail(e.target.value)} className="input !bg-[#f5f6fb] w-full !py-3" placeholder="Administrator email" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
              <input required type="password" minLength={12} value={setupPassword} onChange={e=>setSetupPassword(e.target.value)} className="input !bg-[#f5f6fb] w-full !py-3" placeholder="Strong password (12+ characters)" autoComplete="new-password" />
              <input required type="password" minLength={12} value={setupConfirm} onChange={e=>setSetupConfirm(e.target.value)} className="input !bg-[#f5f6fb] w-full !py-3" placeholder="Confirm password" autoComplete="new-password" />
              <div className="pt-3 border-t border-[#eceef6]"><p className="text-[11px] font-bold tracking-wider text-[#5b5f7e] mb-2">CASHIER ACCOUNT</p><div className="grid gap-3"><input required value={setupCashierName} onChange={e=>setSetupCashierName(e.target.value)} className="input !bg-[#f5f6fb] w-full !py-3" placeholder="Cashier name" autoComplete="name" /><input required type="text" inputMode="email" value={setupCashierEmail} onChange={e=>setSetupCashierEmail(e.target.value)} className="input !bg-[#f5f6fb] w-full !py-3" placeholder="Cashier email" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} /><input required type="password" minLength={12} value={setupCashierPassword} onChange={e=>setSetupCashierPassword(e.target.value)} className="input !bg-[#f5f6fb] w-full !py-3" placeholder="Cashier password (12+ characters)" autoComplete="new-password" /><input required type="password" minLength={12} value={setupCashierConfirm} onChange={e=>setSetupCashierConfirm(e.target.value)} className="input !bg-[#f5f6fb] w-full !py-3" placeholder="Confirm cashier password" autoComplete="new-password" /></div></div>
              {error && <div className="flex items-center gap-2 text-[13px] font-medium text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-3.5 py-2.5"><AlertCircle size={15} /> {error}</div>}
              <button type="submit" disabled={loading} className="btn btn-primary w-full !py-3.5 !text-[15px] !rounded-xl">{loading ? <Loader2 size={18} className="animate-spin" /> : <>Create administrator <ArrowRight size={17} /></>}</button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen grid place-items-center bg-[#f5f6fb] p-5">
      <div className="w-full max-w-md bg-white rounded-3xl shadow-xl border border-[#eceef6] overflow-hidden">
        <div className="h-1.5 bg-gradient-to-r from-violet-600 via-indigo-500 to-sky-400" />
        <div className="p-7 sm:p-9">
          <h1 className="text-3xl font-extrabold text-[#17133c]">NEXFIX SOLUTION</h1>
          <p className="text-sm text-[#5b5f7e] mt-2">Sign in to your POS account</p>
          <div className="grid grid-cols-2 gap-1.5 p-1.5 rounded-xl bg-[#f5f6fb] border border-[#e7e9f2] mb-5"><button type="button" onClick={() => { setLoginRole('admin'); setError(''); }} className={`rounded-lg py-2.5 text-xs font-bold transition ${loginRole === 'admin' ? 'bg-violet-600 text-white shadow' : 'text-[#5b5f7e] hover:text-[#17133c]'}`}>ADMIN</button><button type="button" onClick={() => { setLoginRole('cashier'); setError(''); }} className={`rounded-lg py-2.5 text-xs font-bold transition ${loginRole === 'cashier' ? 'bg-emerald-600 text-white shadow' : 'text-[#5b5f7e] hover:text-[#17133c]'}`}>CASHIER</button></div>
          <form onSubmit={submit} className="mt-7 space-y-4">
            <label className="block">
              <span className="block text-[11px] font-bold tracking-wider text-[#5b5f7e] mb-1.5">EMAIL</span>
              <div className="relative">
                <Mail size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#9a9ebf]" />
                <input required type="text" inputMode="email" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={email} onChange={e => setEmail(e.target.value)} className="input !bg-[#f5f6fb] !border-[#e7e9f2] pl-10 !py-3 w-full" placeholder="you@shop.lk" />
              </div>
            </label>
            <label className="block">
              <span className="block text-[11px] font-bold tracking-wider text-[#5b5f7e] mb-1.5">PASSWORD</span>
              <div className="relative">
                <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#9a9ebf]" />
                <input required type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} className="input !bg-[#f5f6fb] !border-[#e7e9f2] pl-10 pr-11 !py-3 w-full" placeholder="Password" />
                <button type="button" onClick={() => setShowPassword(v => !v)} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[#9a9ebf]">
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </label>
            <label className="flex items-center gap-2 text-xs text-[#5b5f7e]"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /> Remember me</label>
            {error && <div className="flex items-center gap-2 text-[13px] font-medium text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-3.5 py-2.5"><AlertCircle size={15} /> {error}</div>}
            <button type="submit" disabled={loading} className="btn btn-primary w-full !py-3.5 !text-[15px] !rounded-xl">{loading ? <Loader2 size={18} className="animate-spin" /> : <>Sign in <ArrowRight size={17} /></>}</button>
          </form>
        </div>
      </div>
    </div>
  );
}