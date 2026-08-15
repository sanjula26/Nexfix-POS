import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Globe, Sparkles, KeyRound, ShieldCheck, Zap, RefreshCw, Mail, Lock,
  Eye, EyeOff, ArrowRight, ArrowLeft, CheckCircle2, AlertCircle, UserRound, Loader2,
} from 'lucide-react';
import { usePOS } from '../lib/store';

const features = [
  { icon: KeyRound, tint: 'from-sky-500 to-blue-600', title: 'Role-Based Login', sub: 'Admin & Cashier' },
  { icon: ShieldCheck, tint: 'from-fuchsia-500 to-pink-500', title: 'Remember Me', sub: 'Stay signed in' },
  { icon: Zap, tint: 'from-emerald-500 to-teal-500', title: 'Auto IMEI Tracking', sub: 'Serial numbers auto' },
  { icon: RefreshCw, tint: 'from-violet-500 to-purple-600', title: 'Offline Mode', sub: 'Durable sync queue' },
];

export default function Login() {
  const { signIn, user } = usePOS();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (user) navigate('/', { replace: true }); }, [user, navigate]);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!email.trim() || !password) { setError('Enter your email and password'); return; }
    setLoading(true); setError('');
    setTimeout(() => {
      const res = signIn(email, password, remember);
      setLoading(false);
      if (res.ok) navigate('/', { replace: true });
      else setError(res.error || 'Sign in failed');
    }, 650);
  };

  return (
    <div className="min-h-screen flex bg-[#f5f6fb]">
      <div
        className="hidden md:flex flex-col justify-center w-[52%] xl:w-1/2 relative overflow-hidden px-12 xl:px-20 py-14 text-white"
        style={{ background: 'linear-gradient(155deg, #0d0a24 0%, #17123c 55%, #1d1550 100%)' }}
      >
        <div className="absolute -top-32 -left-32 w-[480px] h-[480px] rounded-full opacity-30" style={{ background: 'radial-gradient(circle, #7c3aed 0%, transparent 65%)' }} />
        <div className="absolute bottom-[-180px] right-[-120px] w-[520px] h-[520px] rounded-full opacity-25" style={{ background: 'radial-gradient(circle, #0ea5e9 0%, transparent 65%)' }} />
        <div className="absolute top-1/3 right-16 w-[260px] h-[260px] rounded-full opacity-10" style={{ background: 'radial-gradient(circle, #f472b6 0%, transparent 60%)' }} />
        <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }} className="relative max-w-lg">
          <div className="flex items-center gap-4 mb-9">
            <span className="inline-flex items-center gap-2 text-[11px] font-semibold text-violet-200 bg-white/[0.07] border border-white/10 rounded-full px-3.5 py-2">
              <Sparkles size={12} className="text-violet-300" /> Sri Lanka's #1 Electronics POS
            </span>
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500 via-indigo-500 to-sky-400 flex items-center justify-center shadow-2xl shadow-violet-950/60">
              <Globe size={26} strokeWidth={2.1} />
            </div>
          </div>
          <h1 className="font-display text-5xl xl:text-6xl font-extrabold leading-[1.05] tracking-tight">
            NEXFIX{' '}
            <span className="bg-gradient-to-r from-sky-300 via-indigo-300 to-violet-300 bg-clip-text text-transparent">SOLUTION</span>
          </h1>
          <p className="mt-4 text-[15px] text-[#a9add4] font-medium">POS &amp; Inventory Management System <span className="text-[#6e72a2]">&middot; v3.1</span></p>
          <div className="grid grid-cols-2 gap-3.5 mt-10">
            {features.map((f, i) => (
              <motion.div key={f.title} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + i * 0.08, duration: 0.45 }} className="rounded-2xl bg-white/[0.05] border border-white/[0.09] p-4 backdrop-blur-sm hover:bg-white/[0.09] transition-colors">
                <span className={`inline-flex w-9 h-9 rounded-xl bg-gradient-to-br ${f.tint} items-center justify-center shadow-lg mb-3`}><f.icon size={17} strokeWidth={2.2} /></span>
                <div className="text-sm font-bold">{f.title}</div>
                <div className="text-[11px] text-[#8f93bd] mt-0.5">{f.sub}</div>
              </motion.div>
            ))}
          </div>
          <div className="mt-12 pt-6 border-t border-white/10 text-xs text-[#7f83ad] font-medium">Nexfix Solution &middot; +94 74 109 7350 &middot; info@nexfixsolution.com</div>
        </motion.div>
      </div>

      <div className="flex-1 flex items-center justify-center p-6 relative">
        <div className="absolute top-6 left-6 md:hidden flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center text-white"><Globe size={17} /></div>
          <span className="font-display font-extrabold text-[#17133c]">NEXFIX SOLUTION</span>
        </div>
        <div className="w-full max-w-md">
          <Link to="/signup" className="inline-flex items-center gap-2 text-xs font-semibold text-violet-600 bg-violet-500/10 border border-violet-500/20 rounded-full px-4 py-2 mb-5 hover:bg-violet-500/15 transition-colors">
            <ArrowLeft size={13} /> New customer? Register here
          </Link>
          <motion.div initial={{ opacity: 0, y: 22 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.05 }} className="bg-white rounded-3xl shadow-[0_24px_70px_-24px_rgba(23,19,60,0.35)] border border-[#eceef6] overflow-hidden">
            <div className="h-1.5 bg-gradient-to-r from-violet-600 via-indigo-500 to-sky-400" />
            <div className="p-7 sm:p-9">
              <h2 className="font-display text-[26px] font-extrabold text-[#17133c] flex items-center gap-2">Welcome back <span className="inline-flex w-7 h-7 rounded-lg bg-amber-100 items-center justify-center"><UserRound size={15} className="text-amber-600" /></span></h2>
              <p className="text-sm text-[#5b5f7e] mt-1">Sign in to access your dashboard</p>
              <form onSubmit={submit} className="mt-7 space-y-4">
                <div>
                  <span className="block text-[11px] font-bold tracking-wider text-[#5b5f7e] mb-1.5">EMAIL</span>
                  <div className="relative"><Mail size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#9a9ebf]" /><input className="input !bg-[#f5f6fb] !border-[#e7e9f2] pl-9 !py-3" placeholder="you@shop.lk" value={email} onChange={e => setEmail(e.target.value)} type="email" autoComplete="username" /></div>
                </div>
                <div>
                  <span className="block text-[11px] font-bold tracking-wider text-[#5b5f7e] mb-1.5">PASSWORD</span>
                  <div className="relative"><Lock size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#9a9ebf]" /><input className="input !bg-[#f5f6fb] !border-[#e7e9f2] pl-9 pr-10 !py-3" placeholder="•••••••••••" type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" /><button type="button" onClick={() => setShowPw(s => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9a9ebf] hover:text-[#5b5f7e]">{showPw ? <EyeOff size={15} /> : <Eye size={15} />}</button></div>
                </div>
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <span onClick={() => setRemember(r => !r)} className={`w-[18px] h-[18px] rounded-[5px] flex items-center justify-center border transition-all ${remember ? 'bg-indigo-600 border-indigo-600' : 'bg-white border-[#d4d7ea]'}`}>{remember && <CheckCircle2 size={12} className="text-white" strokeWidth={3} />}</span>
                    <span className="text-[13px] text-[#5b5f7e] font-medium">Remember me for 30 days</span>
                  </label>
                  <RefreshCw size={13} className="text-[#c3c6de" />
                </div>
                {error && <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2 text-[13px] font-medium text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-3.5 py-2.5"><AlertCircle size={15} /> {error}</motion.div>}
                <button type="submit" disabled={loading} className="btn btn-primary w-full !py-3.5 !text-[15px] !rounded-xl">{loading ? <Loader2 size={17} className="animate-spin" /> : <>Sign in &amp; stay logged in <ArrowRight size={16} /></>}</button>
              </form>
              <p className="text-center text-[13px] text-[#5b5f7e] mt-6">Don't have an account? <Link to="/signup" className="font-bold text-violet-600 hover:text-violet-700">Sign up</Link></p>
            </div>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
