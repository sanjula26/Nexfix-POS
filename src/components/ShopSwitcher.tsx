import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Store, Check, Loader2, AlertCircle } from 'lucide-react';
import { usePOS } from '../lib/store';
import { buildSeed } from '../lib/seed';
import { idbSaveState, idbListQueue } from '../lib/db';
import { getCloudShopId, setCloudShopId } from '../lib/cloudSync';
import { getCloudDeviceId } from '../lib/cloudDevice';
import { supabase, supabaseConfigured } from '../lib/supabase';
import { runSyncNow } from '../lib/syncManager';
import type { POSState } from '../lib/types';

interface ShopOption { id: string; name: string; role: string; }

const CACHE_PREFIX = 'nexfix_shop_state_cache_v1:';
const HYDRATED_PREFIX = 'nexfix_shop_hydrated_v1:';
const MEMBERSHIP_PREFIX = 'nexfix_shop_memberships_v1:';
const STORE_KEY = 'nexfix_pos_v2';
const REVISION_KEY = 'nexfix_cloud_revision';

function cacheKey(shopId: string): string { return `${CACHE_PREFIX}${shopId}`; }
function hydratedKey(shopId: string): string { return `${HYDRATED_PREFIX}${shopId}`; }
function membershipKey(userId: string): string { return `${MEMBERSHIP_PREFIX}${userId}`; }

function preserveLocalAuthentication(current: POSState, next: POSState): POSState {
  return { ...next, users: current.users, settings: { ...next.settings, adminPinHash: current.settings.adminPinHash } };
}

function validState(input: unknown): input is POSState {
  if (!input || typeof input !== 'object') return false;
  const s = input as Partial<POSState>;
  return Array.isArray(s.products) && Array.isArray(s.customers) && Array.isArray(s.sales)
    && Array.isArray(s.purchases) && Array.isArray(s.expenses) && Array.isArray(s.exchanges)
    && Array.isArray(s.users) && !!s.settings && typeof s.settings === 'object'
    && !!s.permissions && typeof s.permissions === 'object';
}

function validShopOptions(input: unknown): input is ShopOption[] {
  return Array.isArray(input) && input.every(item => !!item && typeof item === 'object'
    && typeof (item as ShopOption).id === 'string' && (item as ShopOption).id.length > 0
    && typeof (item as ShopOption).name === 'string'
    && typeof (item as ShopOption).role === 'string');
}

function readCachedMemberships(userId: string): ShopOption[] {
  try {
    const raw = localStorage.getItem(membershipKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return validShopOptions(parsed) ? parsed : [];
  } catch { return []; }
}

function writeCachedMemberships(userId: string, shops: ShopOption[]): void {
  try { localStorage.setItem(membershipKey(userId), JSON.stringify(shops)); } catch { /* ignore quota */ }
}

async function listMemberships(userId: string): Promise<ShopOption[]> {
  const cached = readCachedMemberships(userId);
  if (!supabaseConfigured || !supabase || typeof navigator !== 'undefined' && !navigator.onLine) return cached;
  const { data: session } = await supabase.auth.getSession();
  const uid = session.session?.user.id;
  if (!uid) return cached;
  const { data: memberships, error } = await supabase.from('shop_memberships').select('shop_id, role, created_at').eq('user_id', uid).eq('active', true).order('created_at', { ascending: true });
  if (error || !memberships?.length) return cached;
  const ids = memberships.map(row => String(row.shop_id));
  const { data: shops } = await supabase.from('shops').select('id, name').in('id', ids);
  const names = new Map((shops || []).map(row => [String(row.id), String(row.name || 'Nexfix Shop')]));
  const result = memberships.map(row => ({ id: String(row.shop_id), name: names.get(String(row.shop_id)) || `Shop ${String(row.shop_id).slice(0, 8)}`, role: String(row.role) }));
  writeCachedMemberships(userId, result);
  return result;
}

async function registerDeviceForShop(shopId: string): Promise<void> {
  if (!supabaseConfigured || !supabase) throw new Error('Cloud authentication is not configured');
  const { data, error } = await supabase.rpc('register_pos_device', { p_shop_id: shopId, p_device_id: getCloudDeviceId() });
  if (error || !data?.ok) throw new Error(error?.message || 'Could not register this device for the selected shop');
}

async function downloadShopSnapshot(shopId: string): Promise<{ state: POSState; revision: number } | null> {
  if (!supabaseConfigured || !supabase) return null;
  const { data, error } = await supabase.from('pos_state_snapshots').select('state, revision').eq('shop_id', shopId).maybeSingle();
  if (error || !data || !validState(data.state)) return null;
  const revision = Number(data.revision);
  return Number.isSafeInteger(revision) && revision >= 0 ? { state: data.state, revision } : null;
}

function readCachedState(shopId: string): POSState | null {
  try {
    const raw = localStorage.getItem(cacheKey(shopId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return validState(parsed) ? parsed : null;
  } catch { return null; }
}

function writeCachedState(shopId: string, state: POSState): void { try { localStorage.setItem(cacheKey(shopId), JSON.stringify(state)); } catch { /* ignore quota */ } }
function markShopHydrated(shopId: string): void { try { localStorage.setItem(hydratedKey(shopId), '1'); } catch { /* ignore */ } }
function isShopHydrated(shopId: string): boolean { try { return localStorage.getItem(hydratedKey(shopId)) === '1'; } catch { return false; } }
function writeActiveStoreState(state: POSState): void { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ } }

export default function ShopSwitcher() {
  const { user, state } = usePOS();
  const [shops, setShops] = useState<ShopOption[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [error, setError] = useState('');
  const activeId = getCloudShopId();
  const activeShop = useMemo(() => shops.find(shop => shop.id === activeId) || shops[0] || null, [shops, activeId]);

  useEffect(() => {
    let cancelled = false;
    if (!user) { setShops([]); setBootstrapping(false); return; }
    void listMemberships(user.id).then(items => {
      if (cancelled) return;
      setShops(items);
      const selected = getCloudShopId();
      const resolved = selected && items.some(item => item.id === selected) ? selected : items[0]?.id;
      if (!resolved) { setBootstrapping(false); return; }
      if (!selected || selected !== resolved) setCloudShopId(resolved);
    });
    return () => { cancelled = true; };
  }, [user?.id]);

  useEffect(() => {
    let cancelled = false;
    if (!user || !activeShop || isShopHydrated(activeShop.id)) return;
    setBootstrapping(true); setError('');
    void (async () => {
      try {
        const online = typeof navigator === 'undefined' || navigator.onLine;
        let remote: { state: POSState; revision: number } | null = null;
        if (online) {
          await registerDeviceForShop(activeShop.id);
          remote = await downloadShopSnapshot(activeShop.id);
        }
        const cached = remote ? null : readCachedState(activeShop.id);
        if (!remote && !cached) {
          if (!online) throw new Error('This shop is not cached on this device yet. Connect once to prepare it for offline use.');
          writeCachedState(activeShop.id, state);
          writeActiveStoreState(state);
          await idbSaveState(state);
          try { localStorage.setItem(REVISION_KEY, '0'); } catch { /* ignore */ }
        } else {
          const next = preserveLocalAuthentication(state, remote?.state || cached || buildSeed());
          setCloudShopId(activeShop.id);
          try { localStorage.setItem(REVISION_KEY, String(remote?.revision ?? 0)); } catch { /* ignore */ }
          writeCachedState(activeShop.id, next);
          writeActiveStoreState(next);
          const saved = await idbSaveState(next);
          if (!saved) throw new Error('Could not prepare the selected shop locally.');
        }
        markShopHydrated(activeShop.id);
        if (!cancelled && (remote || cached)) { window.location.reload(); return; }
        if (!cancelled) setBootstrapping(false);
      } catch (err) {
        if (!cancelled) { setError(err instanceof Error ? err.message : 'Could not prepare the active shop'); setBootstrapping(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id, activeShop?.id]);

  if (!user || !activeShop) return null;

  const switchShop = async (target: ShopOption) => {
    if (busy || bootstrapping || target.id === activeShop.id) { setOpen(false); return; }
    setBusy(true); setError('');
    try {
      const pendingBefore = await idbListQueue();
      if (pendingBefore.length) {
        await runSyncNow();
        const pendingAfter = await idbListQueue();
        if (pendingAfter.length) throw new Error('Sync the current shop before switching shops. Pending offline changes are still waiting.');
      }
      writeCachedState(activeShop.id, state);
      await idbSaveState(state);
      const online = typeof navigator === 'undefined' || navigator.onLine;
      let remote: { state: POSState; revision: number } | null = null;
      if (online) {
        await registerDeviceForShop(target.id);
        remote = await downloadShopSnapshot(target.id);
      }
      const cached = remote ? null : readCachedState(target.id);
      if (!remote && !cached) throw new Error(online
        ? 'Could not load the selected shop. Try again.'
        : 'The selected shop is not cached on this device yet. Connect once before switching to it offline.');
      const next = preserveLocalAuthentication(state, remote?.state || cached || buildSeed());
      setCloudShopId(target.id);
      try { localStorage.setItem(REVISION_KEY, String(remote?.revision ?? 0)); } catch { /* ignore */ }
      writeCachedState(target.id, next);
      writeActiveStoreState(next);
      const saved = await idbSaveState(next);
      if (!saved) throw new Error('Could not prepare the selected shop locally.');
      markShopHydrated(target.id);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch shop'); setBusy(false);
    }
  };

  return (
    <>
      {bootstrapping && <div className="fixed inset-0 z-[200] grid place-items-center bg-slate-950/80 backdrop-blur-sm"><div className="w-[min(92vw,380px)] rounded-2xl border border-white/10 bg-slate-900 px-6 py-7 text-center shadow-2xl"><Loader2 size={28} className="mx-auto mb-3 animate-spin text-violet-400" /><div className="text-sm font-semibold text-white">Preparing {activeShop.name}</div><div className="mt-1 text-xs text-slate-400">Loading this shop's data securely…</div>{error && <div className="mt-4 flex gap-2 rounded-xl bg-rose-500/10 border border-rose-400/20 px-3 py-2 text-left text-xs text-rose-200"><AlertCircle size={14} className="shrink-0 mt-0.5" />{error}</div>}</div></div>}
      {shops.length > 1 && !bootstrapping && <div className="fixed top-3 right-3 z-[100]"><button type="button" onClick={() => { setOpen(value => !value); setError(''); }} disabled={busy} className="flex items-center gap-2 rounded-xl border border-line bg-panel/95 px-3 py-2 shadow-lg backdrop-blur text-sm font-semibold text-ink hover:bg-raised disabled:opacity-70" title="Switch active shop">{busy ? <Loader2 size={15} className="animate-spin text-violet-500" /> : <Store size={15} className="text-violet-500" />}<span className="max-w-[180px] truncate">{activeShop.name}</span><ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} /></button>{open && !busy && <div className="mt-2 w-72 rounded-2xl border border-line bg-panel shadow-2xl p-2"><div className="px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-faint">Active shop</div>{shops.map(shop => <button key={shop.id} type="button" onClick={() => void switchShop(shop)} className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-raised transition-colors"><span className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center shrink-0"><Store size={15} className="text-violet-500" /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-ink">{shop.name}</span><span className="block text-[10px] uppercase tracking-wider text-faint">{shop.role}</span></span>{shop.id === activeShop.id && <Check size={16} className="text-emerald-500 shrink-0" />}</button>)}{error && <div className="mt-2 flex gap-2 rounded-xl bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700"><AlertCircle size={14} className="shrink-0 mt-0.5" />{error}</div>}</div>}</div>}
    </>
  );
}
