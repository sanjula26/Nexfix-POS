import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, LogOut, ReceiptText, WalletCards, Banknote, CreditCard, Smartphone, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePOS } from '../lib/store';
import { fmtRs, fmtDateTime, dkey, salePaymentLabel } from '../lib/utils';
import { downloadStateSnapshot, getCloudShopId, setCloudShopId } from '../lib/cloudSync';
import { supabase, supabaseConfigured } from '../lib/supabase';
import type { POSState } from '../lib/types';

export default function MobileTodaySales() {
  const { state, signOut, verifyAdminPin } = usePOS();
  const navigate = useNavigate();
  const location = useLocation();
  const requestedShopId = new URLSearchParams(location.search).get('shop')?.trim() || '';
  const [shopReady, setShopReady] = useState(!requestedShopId || requestedShopId === getCloudShopId());
  const [shopError, setShopError] = useState('');
  const [remoteState, setRemoteState] = useState<POSState | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState('');
  const [copied, setCopied] = useState(false);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [pinVerified, setPinVerified] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const today = dkey(new Date());

  useEffect(() => {
    let cancelled = false;
    const alignShop = async () => {
      if (!requestedShopId || requestedShopId === getCloudShopId()) {
        if (!cancelled) setShopReady(true);
        return;
      }
      if (!supabaseConfigured || !supabase) {
        if (!cancelled) { setShopError('මෙම shop link එක භාවිතා කිරීමට hosted cloud login අවශ්‍යයි.'); setShopReady(false); }
        return;
      }
      const { data: authData } = await supabase.auth.getUser();
      const uid = authData.user?.id;
      if (!uid) {
        if (!cancelled) { setShopError('Login session එක හමු නොවීය.'); setShopReady(false); }
        return;
      }
      const { data: membership, error } = await supabase
        .from('shop_memberships')
        .select('shop_id')
        .eq('user_id', uid)
        .eq('shop_id', requestedShopId)
        .eq('active', true)
        .maybeSingle();
      if (error || !membership) {
        if (!cancelled) { setShopError('මෙම shop එකට ඔබට අවසර නැත.'); setShopReady(false); }
        return;
      }
      setCloudShopId(requestedShopId);
      window.location.reload();
    };
    void alignShop();
    return () => { cancelled = true; };
  }, [requestedShopId]);

  const shopId = getCloudShopId();
  const phoneLink = shopId && typeof window !== 'undefined'
    ? `${window.location.origin}${window.location.pathname}#/today?shop=${encodeURIComponent(shopId)}`
    : '';

  const submitPin = () => {
    const value = pin.trim();
    if (!value) { setPinError('Admin PIN එක ඇතුළත් කරන්න.'); return; }
    if (!verifyAdminPin(value, 'Today sales')) { setPinError('Admin PIN එක වැරදියි.'); return; }
    setPinError('');
    setPinVerified(true);
    setPin('');
  };

  const loadCloudSales = useCallback(async () => {
    if (!supabaseConfigured || !supabase || !shopId) return;
    setRemoteLoading(true);
    setRemoteError('');
    try {
      const snapshot = await downloadStateSnapshot();
      if (!snapshot) {
        setRemoteState(null);
        setRemoteError('Cloud sales snapshot එක හමු නොවීය. PC එක online sync වී තිබේද බලන්න.');
      } else {
        setRemoteState(snapshot.state);
      }
    } catch {
      setRemoteState(null);
      setRemoteError('Cloud sales data ලබාගැනීමට නොහැකි විය.');
    } finally {
      setRemoteLoading(false);
    }
  }, [shopId]);

  useEffect(() => {
    if (!shopReady) return;
    void loadCloudSales();
  }, [shopReady, loadCloudSales]);

  const copyPhoneLink = async () => {
    if (!phoneLink) return;
    try {
      await navigator.clipboard.writeText(phoneLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch { setCopied(false); }
  };

  const sourceState = remoteState || state;
  const usingCloud = !!remoteState;
  const sales = useMemo(
    () => sourceState.sales
      .filter(s => dkey(new Date(s.date)) === today)
      .sort((a, b) => +new Date(b.date) - +new Date(a.date)),
    [sourceState.sales, today],
  );

  const completed = sales.filter(s => s.status !== 'refunded' && s.status !== 'reversed');
  const revenue = completed.reduce((sum, s) => sum + s.total, 0);
  const cash = completed.filter(s => s.payment === 'cash' && !s.payments?.length).reduce((sum, s) => sum + s.total, 0);
  const card = completed.filter(s => s.payment === 'card' && !s.payments?.length).reduce((sum, s) => sum + s.total, 0);

  const paymentIcon = (payment: string) => payment === 'cash' ? <Banknote size={15} /> : payment === 'card' ? <CreditCard size={15} /> : <Smartphone size={15} />;

  if (!shopReady) {
    return (
      <main className="min-h-screen bg-[#f5f6fb] p-5 text-[#17133c]">
        <div className="mx-auto max-w-xl rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h1 className="text-lg font-black">Shop link</h1>
          <p className="mt-2 text-sm text-slate-600">{shopError || 'Shop එක හඳුනාගනිමින්…'}</p>
          <button type="button" onClick={() => navigate('/login')} className="mt-4 min-h-11 rounded-xl bg-violet-600 px-4 text-sm font-bold text-white">Login</button>
        </div>
      </main>
    );
  }

  if (!pinVerified) {
    return (
      <main className="min-h-screen bg-[#f5f6fb] p-5 text-[#17133c]">
        <div className="mx-auto mt-16 max-w-sm rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <h1 className="text-xl font-black">Today’s Sales</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">Login එකෙන් පසු මෙම read-only sales view එක බලන්න Admin PIN එක අවශ්‍යයි.</p>
          <label className="mt-5 block text-xs font-bold text-slate-600">Admin PIN</label>
          <input className="mt-2 min-h-12 w-full rounded-xl border border-slate-300 px-4 text-lg tracking-[0.3em] outline-none focus:border-violet-500" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={e => { setPin(e.target.value); setPinError(''); }} onKeyDown={e => { if (e.key === 'Enter') submitPin(); }} autoFocus />
          {pinError && <p className="mt-2 text-xs font-bold text-rose-600">{pinError}</p>}
          <button type="button" onClick={submitPin} className="mt-4 min-h-12 w-full rounded-xl bg-violet-600 px-4 text-sm font-bold text-white">Unlock today’s sales</button>
          <button type="button" onClick={() => { signOut(); navigate('/login'); }} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 px-4 text-sm font-bold text-slate-700">Logout</button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#f5f6fb] text-[#17133c]">
      <div className="mx-auto w-full max-w-xl px-4 py-4 sm:px-6">
        <header className="sticky top-0 z-10 -mx-4 mb-4 flex items-center justify-between border-b border-slate-200 bg-[#f5f6fb]/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
          <button type="button" onClick={() => navigate('/dashboard')} className="inline-flex min-h-11 items-center gap-2 rounded-xl px-2 text-sm font-bold text-slate-700">
            <ArrowLeft size={18} /> Back
          </button>
          <div className="text-center">
            <div className="text-sm font-extrabold">Today’s sales</div>
            <div className="text-[11px] text-slate-500">{new Date().toLocaleDateString()}</div>
          </div>
          <button type="button" onClick={() => { signOut(); navigate('/login'); }} className="inline-flex min-h-11 items-center gap-2 rounded-xl px-2 text-sm font-bold text-slate-700" aria-label="Log out">
            <LogOut size={17} /> <span className="hidden xs:inline">Logout</span>
          </button>
        </header>

        <section className="mb-4 rounded-2xl border border-violet-100 bg-violet-50 p-4">
          <div className="text-xs font-bold uppercase tracking-wide text-violet-700">Phone link — මෙම shop එක</div>
          <div className="mt-1 break-all text-xs font-semibold text-slate-700">{phoneLink || 'Shop ID not configured'}</div>
          <button type="button" onClick={() => void copyPhoneLink()} disabled={!phoneLink} className="mt-3 min-h-11 w-full rounded-xl bg-violet-600 px-4 text-sm font-bold text-white disabled:opacity-50">
            {copied ? 'Link copied' : 'Copy phone link'}
          </button>
          <div className="mt-2 text-[11px] leading-relaxed text-slate-500">Link එකේ shop ID එකෙන් කඩය හඳුනාගන්නවා. Login වුණු user ට එම shop එකේ active membership තිබිය යුතුයි.</div>
        </section>

        <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Data source</div>
              <div className="mt-1 text-sm font-extrabold">{usingCloud ? 'Cloud-synced shop data' : 'Local data'}</div>
            </div>
            <button type="button" onClick={() => void loadCloudSales()} disabled={remoteLoading} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-slate-200 px-3 text-xs font-bold text-slate-700 disabled:opacity-50">
              <RefreshCw size={14} className={remoteLoading ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
          {remoteError && <p className="mt-2 text-xs leading-relaxed text-amber-700">{remoteError}</p>}
        </section>

        <section className="grid grid-cols-2 gap-3">
          <div className="col-span-2 rounded-2xl bg-violet-600 p-5 text-white shadow-lg">
            <div className="flex items-center gap-2 text-sm font-semibold opacity-90"><WalletCards size={18} /> Total revenue</div>
            <div className="mt-2 text-3xl font-black tracking-tight">{fmtRs(revenue)}</div>
            <div className="mt-1 text-xs opacity-80">{completed.length} completed bill{completed.length === 1 ? '' : 's'}</div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Bills</div>
            <div className="mt-1 text-2xl font-black">{sales.length}</div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Cash / Card</div>
            <div className="mt-1 text-base font-extrabold">{fmtRs(cash)} / {fmtRs(card)}</div>
          </div>
        </section>

        <section className="mt-5">
          <div className="mb-3 flex items-center gap-2 text-base font-extrabold"><ReceiptText size={18} /> Today’s bills</div>
          {sales.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">No sales recorded today.</div>
          ) : (
            <div className="space-y-3">
              {sales.map(sale => {
                const open = openId === sale.id;
                return (
                  <button key={sale.id} type="button" onClick={() => setOpenId(open ? null : sale.id)} className="w-full rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm active:scale-[.99]">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-base font-extrabold">{sale.billNo}</div>
                        <div className="mt-1 text-xs text-slate-500">{fmtDateTime(sale.date)} · {sale.cashierName}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-lg font-black">{fmtRs(sale.total)}</div>
                        <div className="mt-1 inline-flex items-center gap-1 text-xs font-bold text-violet-600">{paymentIcon(sale.payment)} {salePaymentLabel(sale)}</div>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-500">
                      <span>{sale.items.reduce((sum, item) => sum + item.qty, 0)} item{sale.items.reduce((sum, item) => sum + item.qty, 0) === 1 ? '' : 's'}</span>
                      <span className="inline-flex items-center gap-1 font-bold text-slate-700">{open ? 'Hide items' : 'View items'} {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
                    </div>
                    {open && (
                      <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
                        {sale.items.map((item, index) => (
                          <div key={index} className="flex justify-between gap-3 text-sm">
                            <span className="min-w-0 truncate">{item.name} × {item.qty}</span>
                            <span className="shrink-0 font-bold">{fmtRs(item.price * item.qty - (item.discount || 0))}</span>
                          </div>
                        ))}
                        {sale.status !== 'completed' && <div className="text-xs font-bold text-rose-600">Status: {sale.status.toUpperCase()}</div>}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <p className="pb-6 pt-5 text-center text-[11px] leading-relaxed text-slate-500">
          Read-only view. Billing and inventory remain on the PC POS. Cloud mode reads the shop’s authenticated cloud snapshot; local fallback data is not treated as the PC’s live data.
        </p>
      </div>
    </main>
  );
}