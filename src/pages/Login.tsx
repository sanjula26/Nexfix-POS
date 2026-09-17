import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, Lock, Mail, ArrowRight, AlertCircle, Eye, EyeOff, ShieldCheck, UserRound } from 'lucide-react';
import { usePOS } from '../lib/store';
import { ensureCloudSession } from '../lib/cloudAuth';

export default function Login() {
  const { signIn, user, ready } = usePOS();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Navigate ONLY when session user is actually available in context.
  // Early navigate('/pos') while user is still null causes Protected → /login bounce.
  useEffect(() => {
    if (!user) return;
    setLoading(false);
    navigate('/pos', { replace: true });
  }, [user, navigate]);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!ready || loading) return;
    const mail = email.trim().toLowerCase();
    if (!mail || !password) {
      setError('Enter your email and password');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await signIn(mail, password, remember);
      if (!result.ok) {
        setError(result.error || 'Incorrect email or password');
        setLoading(false);
        return;
      }
      void ensureCloudSession(mail, password, mail).catch(() => {});
      // Do not navigate here — wait for `user` via useEffect.
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

  const quickFill = (em: string, pw: string) => {
    setEmail(em);
    setPassword(pw);
    setError('');
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

  return (
    <div className="min-h-screen grid place-items-center bg-[#f5f6fb] p-5">
      <div className="w-full max-w-md bg-white rounded-3xl shadow-xl border border-[#eceef6] overflow-hidden">
        <div className="h-1.5 bg-gradient-to-r from-violet-600 via-indigo-500 to-sky-400" />
        <div className="p-7 sm:p-9">
          <h1 className="text-3xl font-extrabold text-[#17133c]">NEXFIX SOLUTION</h1>
          <p className="text-sm text-[#5b5f7e] mt-2">Sign in to your POS account</p>

          <form onSubmit={submit} className="mt-7 space-y-4">
            <label className="block">
              <span className="block text-[11px] font-bold tracking-wider text-[#5b5f7e] mb-1.5">EMAIL</span>
              <div className="relative">
                <Mail size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#9a9ebf]" />
                <input
                  required
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="input !bg-[#f5f6fb] !border-[#e7e9f2] pl-10 !py-3 w-full"
                  placeholder="you@shop.lk"
                />
              </div>
            </label>

            <label className="block">
              <span className="block text-[11px] font-bold tracking-wider text-[#5b5f7e] mb-1.5">PASSWORD</span>
              <div className="relative">
                <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#9a9ebf]" />
                <input
                  required
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="input !bg-[#f5f6fb] !border-[#e7e9f2] pl-10 pr-11 !py-3 w-full"
                  placeholder="Password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[#9a9ebf]"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </label>

            <label className="flex items-center gap-2 text-xs text-[#5b5f7e]">
              <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
              Remember me
            </label>

            {error && (
              <div className="flex items-center gap-2 text-[13px] font-medium text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-3.5 py-2.5">
                <AlertCircle size={15} /> {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="btn btn-primary w-full !py-3.5 !text-[15px] !rounded-xl"
            >
              {loading ? <Loader2 size={18} className="animate-spin" /> : <>Sign in <ArrowRight size={17} /></>}
            </button>
          </form>

          <div className="flex items-center gap-3 my-5">
            <span className="flex-1 h-px bg-[#e7e9f2]" />
            <span className="text-[10px] font-bold tracking-[0.14em] text-[#9a9ebf]">OR QUICK FILL</span>
            <span className="flex-1 h-px bg-[#e7e9f2]" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => quickFill('admin@nexfixsolution.com', 'admin123')}
              className="rounded-xl border border-violet-200 bg-violet-50/60 hover:bg-violet-100/70 transition-colors p-3 text-left"
            >
              <span className="inline-flex w-8 h-8 rounded-lg bg-violet-600 text-white items-center justify-center mb-2">
                <ShieldCheck size={15} />
              </span>
              <div className="text-[13px] font-bold text-[#17133c]">Admin</div>
              <div className="text-[10.5px] text-[#7f83ad] truncate">admin@nexfixsolution.com</div>
            </button>
            <button
              type="button"
              onClick={() => quickFill('cashier@nexfixsolution.com', 'cashier123')}
              className="rounded-xl border border-emerald-200 bg-emerald-50/60 hover:bg-emerald-100/70 transition-colors p-3 text-left"
            >
              <span className="inline-flex w-8 h-8 rounded-lg bg-emerald-500 text-white items-center justify-center mb-2">
                <UserRound size={15} />
              </span>
              <div className="text-[13px] font-bold text-[#17133c]">Cashier</div>
              <div className="text-[10.5px] text-[#7f83ad] truncate">cashier@nexfixsolution.com</div>
            </button>
          </div>

          <div className="mt-6 text-center text-xs text-[#7b7f9f]">
            Need a new installation?{' '}
            <Link to="/signup" className="font-bold text-violet-600">Create account</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
