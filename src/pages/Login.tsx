import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { usePOS } from '../lib/store';

export default function Login() {
  const { user, ready, switchRole } = usePOS();
  const navigate = useNavigate();
  const started = useRef(false);

  useEffect(() => {
    if (!ready || user || started.current) return;
    started.current = true;
    const result = switchRole('cashier');
    if (!result.ok) started.current = false;
  }, [ready, user, switchRole]);

  useEffect(() => {
    if (user) navigate('/pos', { replace: true });
  }, [user, navigate]);

  return (
    <div className="min-h-screen grid place-items-center bg-[#f5f6fb]">
      <div className="bg-white rounded-3xl shadow-xl border border-[#eceef6] px-8 py-7 text-center">
        <Loader2 size={30} className="mx-auto text-violet-600 animate-spin" />
        <p className="mt-4 text-sm font-bold text-[#17133c]">Opening POS…</p>
        <p className="mt-1 text-xs text-[#7b7f9f]">Starting the cashier session.</p>
      </div>
    </div>
  );
}
