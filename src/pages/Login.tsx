import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { usePOS } from '../lib/store';

const KIOSK_ID = 'u-kiosk-cashier';
const KIOSK_EMAIL = 'pos@kiosk.local';

export default function Login() {
  const { user, state, ready, switchRole, exportData, importData } = usePOS();
  const navigate = useNavigate();
  const started = useRef(false);

  useEffect(() => {
    if (!ready || user || started.current) return;
    started.current = true;

    try {
      const existing = state.users.find(u => u.id === KIOSK_ID && u.role === 'cashier' && u.active);
      if (!existing) {
        const next = JSON.parse(exportData()) as typeof state;
        const kiosk = {
          id: KIOSK_ID,
          name: 'POS Cashier',
          email: KIOSK_EMAIL,
          password: '',
          role: 'cashier' as const,
          active: true,
          createdAt: new Date().toISOString(),
        };
        next.users = [...next.users, kiosk];
        next.permissions = {
          ...next.permissions,
          cashier: { ...(next.permissions?.cashier || {}), 'page:pos': true },
        };
        if (!importData(JSON.stringify(next))) throw new Error('Could not create POS cashier');
        started.current = false;
        return;
      }

      if (!state.permissions?.cashier?.['page:pos']) {
        const next = JSON.parse(exportData()) as typeof state;
        next.permissions = {
          ...next.permissions,
          cashier: { ...(next.permissions?.cashier || {}), 'page:pos': true },
        };
        if (!importData(JSON.stringify(next))) throw new Error('Could not enable POS access');
        started.current = false;
        return;
      }

      const result = switchRole('cashier');
      if (!result.ok) throw new Error(result.error || 'Could not start POS cashier session');
    } catch {
      started.current = false;
    }
  }, [ready, user, state, exportData, importData, switchRole]);

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
