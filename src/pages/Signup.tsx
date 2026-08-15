import { useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Globe, Sparkles, UserRound, Phone, Mail, CreditCard, MapPin, ArrowLeft,
  CheckCircle2, PartyPopper, ShoppingBag, BadgePercent, Wrench,
} from 'lucide-react';
import { usePOS } from '../lib/store';
import { Field } from '../components/ui';
import { uid } from '../lib/utils';

export default function Signup() {
  const { saveCustomer, user, state } = usePOS();
  const [form, setForm] = useState({ name: '', phone: '', email: '', nic: '', address: '' });
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return setError('Please enter your full name');
    if (!form.phone.trim() || form.phone.replace(/\D/g, '').length < 9) return setError('Please enter a valid phone number');
    const exists = state.customers.some(c => c.phone.replace(/\D/g, '') === form.phone.replace(/\D/g, ''));
    if (exists) return setError('This phone number is already registered');
    saveCustomer({
      id: uid(), name: form.name.trim(), phone: form.phone.trim(),
      email: form.email.trim() || undefined, nic: form.nic.trim() || undefined,
      address: form.address.trim() || undefined,
      createdAt: new Date().toISOString(), creditBalance: 0, loyaltyPoints: 0,
    });
    setDone(true);
  };

  const inner = done ? (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
      className="card max-w-md w-full p-10 text-center"
    >
      <span className="inline-flex w-16 h-16 rounded-2xl bg-emerald-500/10 text-emerald-500 items-center justify-center mb-5">
        <PartyPopper size={28} />
      </span>
      <h2 className="text-2xl font-extrabold text-ink">You're registered!</h2>
      <p className="text-sm text-sub mt-2">
        Welcome to {state.settings.shopName}, <b className="text-ink">{form.name}</b>.
        Your profile is now in our customer book — faster billing, warranty lookup and exchange service await.
      </p>
      <div className="mt-7 flex flex-col gap-2.5">
        {!user && <Link to="/login" className="btn btn-primary w-full">Back to sign in</Link>}
        {user && <Link to="/customers" className="btn btn-primary w-full">View customers</Link>}
        <button
          className="btn btn-soft w-full"
          onClick={() => { setForm({ name: '', phone: '', email: '', nic: '', address: '' }); setDone(false); }}
        >
          Register another customer
        </button>
      </div>
    </motion.div>
  ) : (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="card max-w-lg w-full overflow-hidden">
      <div className="h-1.5 bg-gradient-to-r from-emerald-500 via-teal-500 to-sky-500" />
      <div className="p-7 sm:p-9">
        <h2 className="font-display text-2xl font-extrabold text-ink">Create your customer profile</h2>
        <p className="text-sm text-sub mt-1">Takes 30 seconds — used for billing, warranties &amp; exchanges</p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <Field label="Full name">
            <WithIcon icon={UserRound}><input className="input pl-9" value={form.name} onChange={set('name')} placeholder="e.g. Amaya Bandara" /></WithIcon>
          </Field>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Phone">
              <WithIcon icon={Phone}><input className="input pl-9" value={form.phone} onChange={set('phone')} placeholder="+94 77 000 0000" /></WithIcon>
            </Field>
            <Field label="NIC (optional)">
              <WithIcon icon={CreditCard}><input className="input pl-9" value={form.nic} onChange={set('nic')} placeholder="200012345678" /></WithIcon>
            </Field>
          </div>
          <Field label="Email (optional)">
            <WithIcon icon={Mail}><input className="input pl-9" value={form.email} onChange={set('email')} placeholder="you@example.com" /></WithIcon>
          </Field>
          <Field label="Address (optional)">
            <WithIcon icon={MapPin}><input className="input pl-9" value={form.address} onChange={set('address')} placeholder="Street, City" /></WithIcon>
          </Field>
          {error && <p className="text-[13px] font-medium text-rose-500">{error}</p>}
          <button type="submit" className="btn btn-emerald w-full !py-3.5 !text-[15px]">
            <CheckCircle2 size={17} /> Register me
          </button>
        </form>
      </div>
    </motion.div>
  );

  const body = (
    <div className="min-h-full flex">
      {/* brand panel */}
      <div
        className="hidden lg:flex flex-col justify-center w-[44%] sticky top-0 h-screen overflow-hidden px-14 text-white"
        style={{ background: 'linear-gradient(155deg, #0d0a24 0%, #122b3a 60%, #0f3d33 100%)' }}
      >
        <div className="absolute -top-24 -right-24 w-[420px] h-[420px] rounded-full opacity-25" style={{ background: 'radial-gradient(circle, #10b981 0%, transparent 65%)' }} />
        <div className="absolute bottom-[-140px] left-[-100px] w-[420px] h-[420px] rounded-full opacity-20" style={{ background: 'radial-gradient(circle, #8b5cf6 0%, transparent 65%)' }} />
        <div className="relative max-w-md">
          <span className="inline-flex items-center gap-2 text-[11px] font-semibold text-emerald-200 bg-white/[0.07] border border-white/10 rounded-full px-3.5 py-2 mb-8">
            <Sparkles size={12} className="text-emerald-300" /> Join the Nexfix family
          </span>
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-600 flex items-center justify-center shadow-2xl shadow-emerald-950/50 mb-7">
            <UserRound size={26} strokeWidth={2.1} />
          </div>
          <h1 className="font-display text-4xl xl:text-5xl font-extrabold leading-tight">
            Customer <span className="bg-gradient-to-r from-emerald-300 to-sky-300 bg-clip-text text-transparent">Self Signup</span>
          </h1>
          <p className="mt-4 text-sm text-[#a9add4]">Register once and enjoy a smoother counter experience every visit.</p>
          <div className="mt-9 space-y-3.5">
            {[
              { icon: ShoppingBag, t: 'Faster checkout', d: 'Your details auto-fill at the counter' },
              { icon: Wrench, t: 'Warranty lookup', d: 'IMEI & serial history tied to your profile' },
              { icon: BadgePercent, t: 'Member deals', d: 'Exchange window & special pricing' },
            ].map(f => (
              <div key={f.t} className="flex items-start gap-3.5 rounded-2xl bg-white/[0.05] border border-white/[0.09] p-4">
                <span className="w-9 h-9 rounded-xl bg-emerald-500/20 text-emerald-300 flex items-center justify-center shrink-0"><f.icon size={16} /></span>
                <div>
                  <div className="text-sm font-bold">{f.t}</div>
                  <div className="text-[11px] text-[#8f93bd] mt-0.5">{f.d}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center p-6 bg-base">
        <Link
          to={user ? '/customers' : '/login'}
          className="inline-flex items-center gap-2 text-xs font-semibold text-sub bg-surface border border-line rounded-full px-4 py-2 mb-5 hover:text-violet-500 hover:border-violet-300 transition-colors no-print"
        >
          <ArrowLeft size={13} /> {user ? 'Back to customers' : 'Back to sign in'}
        </Link>
        {inner}
        <div className="mt-6 flex items-center gap-2 text-[11px] text-faint no-print">
          <Globe size={12} /> {state.settings.shopName} &middot; {state.settings.phone}
        </div>
      </div>
    </div>
  );

  return body;
}

function WithIcon({ icon: Icon, children }: { icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="relative">
      <Icon size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
      {children}
    </div>
  );
}
