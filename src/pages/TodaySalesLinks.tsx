import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, RefreshCw, Smartphone, ExternalLink } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { usePOS } from '../lib/store';
import { downloadStateSnapshot, ensureCloudShop, getCloudShopId } from '../lib/cloudSync';
import { getMachineIdentity } from '../lib/machine';
import type { POSState } from '../lib/types';

export default function TodaySalesLinks() {
  const { state, user } = usePOS();
  const location = useLocation();
  const currentMachine = getMachineIdentity();
  const isAdmin = user?.role === 'admin';
  const [remoteState, setRemoteState] = useState<POSState | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const [shopId, setShopId] = useState(getCloudShopId());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let resolvedShopId = getCloudShopId();
      if (!resolvedShopId) {
        const ensured = await ensureCloudShop(state.settings.shopName || 'Nexfix Shop');
        resolvedShopId = ensured.shopId || '';
        if (!resolvedShopId) throw new Error(ensured.error || 'Shop ID not configured');
      }
      setShopId(resolvedShopId);
      const snapshot = await downloadStateSnapshot();
      if (snapshot) setRemoteState(snapshot.state);
      setMessage('');
    } catch {
      setMessage('Cloud data ලබාගැනීමට නොහැකි විය. Local machine data භාවිතා කරමින් links පෙන්වයි.');
    } finally {
      setLoading(false);
    }
  }, [state.settings.shopName]);

  useEffect(() => { void load(); }, [load]);

  const source = remoteState || state;
  const currentMachineSales = useMemo(
    () => source.sales.filter(s => s.machineId === currentMachine.id).length,
    [source.sales, currentMachine.id],
  );

  const base = typeof window !== 'undefined' ? window.location.origin + window.location.pathname : '';
  const phoneLink = shopId
    ? base + '#/today?shop=' + encodeURIComponent(shopId) + '&machine=' + encodeURIComponent(currentMachine.id)
    : '';

  const copy = async (link: string) => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setMessage('Current POS machine link copied.');
      window.setTimeout(() => setMessage(''), 1800);
    } catch { setMessage('Link copy කරන්න බැරි විය.'); }
  };

  if (!isAdmin) {
    return (
      <main className="min-h-screen bg-[#f5f6fb] p-5 text-[#17133c]">
        <div className="mx-auto mt-16 max-w-sm rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-200">
          <h1 className="text-lg font-black">Admin access required</h1>
          <p className="mt-2 text-sm text-slate-500">Phone Sales Link එක manage කරන්න Admin පමණක් අවසර ඇත.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#f5f6fb] text-[#17133c]">
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
        <header className="mb-5 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-black">Phone Sales Links</h1>
            <p className="mt-1 text-xs text-slate-500">එක් එක් POS machine එකට වෙනම read-only phone link.</p>
          </div>
          <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </header>

        {message && <div className="mb-4 rounded-xl border border-violet-100 bg-violet-50 p-3 text-xs font-bold text-violet-700">{message}</div>}

        <section className="mb-5 rounded-2xl border border-violet-100 bg-violet-50 p-4">
          <div className="text-xs font-bold uppercase tracking-wide text-violet-700">Current POS machine</div>
          <div className="mt-1 text-base font-black">{currentMachine.name}</div>
          <div className="mt-1 break-all text-[11px] text-slate-500">{currentMachine.id}</div>
          <p className="mt-2 text-xs leading-relaxed text-slate-600">මෙම machine එකේ POS එකෙන්ම මේ page එක open කළාම ඒ machine එකේ unique ID එක automatically link එකට යනවා.</p>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-violet-50 text-violet-600"><Smartphone size={19} /></div>
            <div className="min-w-0 flex-1">
              <div className="font-black">{currentMachine.name}</div>
              <div className="mt-1 break-all text-[11px] text-slate-500">{currentMachine.id} · {currentMachineSales} recorded sale{currentMachineSales === 1 ? '' : 's'}</div>
              <div className="mt-3 break-all rounded-xl bg-slate-50 p-3 text-[11px] font-semibold text-slate-700">{phoneLink || 'Cloud shop ID not configured'}</div>
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={() => void copy(phoneLink)} disabled={!phoneLink} className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-violet-600 px-3 text-xs font-bold text-white disabled:opacity-50"><Copy size={15} /> Copy my machine link</button>
                {phoneLink && <a href={phoneLink.replace(window.location.origin + window.location.pathname, '')} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 text-xs font-bold text-slate-700"><ExternalLink size={15} /> Open</a>}
              </div>
            </div>
          </div>
        </section>
        <p className="mt-6 text-center text-[11px] leading-relaxed text-slate-500">මෙම shop එකේ මෙම POS machine එකේ link එක පමණක් මෙහි පෙන්වයි. වෙනත් machine හෝ වෙනත් shop links shop UI එකෙන් නොපෙන්වයි.</p>
      </div>
    </main>
  );
}
