import { useState } from 'react';
import { LockKeyhole, ShieldCheck, Eye, EyeOff, Loader2, CheckCircle2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { usePOS } from '../lib/store';

export default function ChangePassword() {
  const { user, changePassword } = usePOS();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  if (!user) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) { setError('Passwords do not match'); return; }
    setSaving(true);
    const result = await changePassword(password);
    setSaving(false);
    if (!result.ok) { setError(result.error || 'Unable to change password'); return; }
    navigate('/pos', { replace: true });
  };

  return (
    <div className="min-h-screen grid place-items-center bg-[#f5f6fb] p-5">
      <div className="w-full max-w-lg bg-white rounded-3xl shadow-xl border border-[#eceef6] overflow-hidden">
        <div className="h-1.5 bg-gradient-to-r from-violet-600 via-indigo-500 to-sky-400" />
        <div className="p-7 sm:p-9">
          <div className="flex items-center gap-3">
            <span className="w-11 h-11 rounded-2xl bg-violet-600 text-white flex items-center justify-center"><ShieldCheck size={21} /></span>
            <div><h1 className="text-2xl font-extrabold text-[#17133c]">Change your password</h1><p className="text-sm text-[#5b5f7e] mt-1">A new password is required before using Nexfix POS.</p></div>
          </div>
          <div className="mt-5 rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
            You are signed in as <b>{user.email}</b>. This recovery password can no longer be used after you set a new one.
          </div>
          <form onSubmit={submit} className="mt-6 space-y-4">
            <label className="block"><span className="block text-[11px] font-bold tracking-wider text-[#5b5f7e] mb-1.5">NEW PASSWORD</span>
              <div className="relative"><LockKeyhole size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#9a9ebf]" />
                <input required minLength={8} type={show ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" className="input !bg-[#f5f6fb] !border-[#e7e9f2] pl-10 pr-11 !py-3 w-full" placeholder="At least 8 characters" />
                <button type="button" onClick={() => setShow(v => !v)} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[#9a9ebf]">{show ? <EyeOff size={16} /> : <Eye size={16} />}</button>
              </div>
            </label>
            <label className="block"><span className="block text-[11px] font-bold tracking-wider text-[#5b5f7e] mb-1.5">CONFIRM PASSWORD</span>
              <input required minLength={8} type={show ? 'text' : 'password'} value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" className="input !bg-[#f5f6fb] !border-[#e7e9f2] !py-3 w-full" placeholder="Re-enter your new password" />
            </label>
            {error && <div className="text-[13px] font-medium text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-3.5 py-2.5">{error}</div>}
            <button type="submit" disabled={saving || password.length < 8 || password !== confirm} className="btn btn-primary w-full !py-3.5 !text-[15px] !rounded-xl">
              {saving ? <Loader2 size={18} className="animate-spin" /> : <><CheckCircle2 size={17} /> Save new password</>}
            </button>
          </form>
          <p className="text-[11px] text-[#7b7f9f] mt-4">Passwords are stored only as hashes using the existing PBKDF2 password path.</p>
        </div>
      </div>
    </div>
  );
}
