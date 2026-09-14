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

interface ShopOption {
  id: string;
  name: string;
  role: string;
}

const CACHE_PREFIX = 'nexfix_shop_state_cache_v1:';
const REVISION_KEY = 'nexfix_cloud_revision';

function cacheKey(shopId: string): string { return `${CACHE_PREFIX}${shopId}`; }

function preserveLocalAuthentication(current: POSState, next: POSState): POSState {
  return {
    ...next,
    users: current.users,
    settings: { ...next.settings, adminPinHash: current.settings.adminPinHash },
  };
}

function validState(input: unknown): input is POSState {
  if (!input || typeof input !== 'object') return false;
  const s = input as Partial<POSState>;
  return Array.isArray(s.products) && Array.isArray(s.customers) && Array.isArray(s.sales)
    && Array.isArray(s.purchases) && Array.isArray(s.expenses) && Array.isArray(s.exchanges)
    && Array.isArray(s.users) && !!s.settings && typeof s.settings === 'object'
    && !!s.permissions && typeof s.permissions === 'object';
}

async function listMemberships(): Promise<ShopOption[]> {
  if (!supabaseConfigured || !supabase) return [];
  const { data: session } = await supabase.auth.getSession();
  const uid = session.session?.user.id;
  if (!uid) return [];
  const { data: memberships, error } = await supabase
    .from('shop_memberships')
    .select('shop_id, role, created_at')
    .eq('user_id', uid)
    .eq('active', true)
    .order('created_at', { ascending: true });
  if (error || !memberships?.length) return [];
  const ids = memberships.map(row => String(row.shop_id));
  const { data: shops } = await supabase.from('shops').select('id, name').in('id', ids);
  const names = new Map((shops || []).map(row => [String(row.id), String(row.name || 'Nexfix Shop')]));
  return memberships.map(row => ({ id: String(row.shop_id), name: names.get(String(row.shop_id)) || `Shop ${String(row.shop_id).slice(0, 8)}`, role: String(row.role) }));
}

async function registerDeviceForShop(shopId: string): Promise<void> {
  if (!supabaseConfigured || !supabase) throw new Error('Cloud authentication is not configured');
  const { data, error } = await supabase.rpc('register_pos_device', {
    p_shop_id: shopId,
    p_device_id: getCloudDeviceId(),
  });
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

function writeCachedState(shopId: string, state: POSState): void {
  try { localStorage.setItem(cacheKey(shopId), JSON.stringify(state)); } catch { /* ignore quota */ }
}

export default function ShopSwitcher() {
  const { user, state } = usePOS();
  const [shops, setShops] = useState<ShopOption[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const activeId = getCloudShopId();
  const activeShop = useMemo(() => shops.find(shop => shop.id === activeId) || shops[0] || null, [shops, activeId]);

  useEffect(() => {
    let cancelled = false;
    if (!user) { setShops([]); return; }
    void listMemberships().then(items => {
      if (cancelled) return;
      setShops(items);
      if (!getCloudShopId() && items[0]) setCloudShopId(items[0].id);
    });
    return () => { cancelled = true; };
  }, [user?.id]);

  if (!user || shops.length <= 1 || !activeShop) return null;

  const switchShop = async (target: ShopOption) => {
    if (busy || target.id === activeShop.id) { setOpen(false); return; }
    setBusy(true); setError('');
    try {
      const pendingBefore = await idbListQueue();
      if (pendingBefore.length) {
        await runSyncNow();
        const pendingAfter = await idbListQueue();
        if (pendingAfter.length) throw new Error('Sync the current shop before switching shops. Pending offline changes are still waiting.');
      }

      const currentId = activeShop.id;
      writeCachedState(currentId, state);
      await idbSaveState(state);

      await registerDeviceForShop(target.id);
      const remote = await downloadShopSnapshot(target.id);
      const cached = remote ? null : readCachedState(target.id);
      const base = remote?.state || cached || buildSeed();
      const next = preserveLocalAuthentication(state, base);

      setCloudShopId(target.id);
      try { localStorage.setItem(REVISION_KEY, String(remote?.revision ?? 0)); } catch { /* ignore */ }
      writeCachedState(target.id, next);
      const saved = await idbSaveState(next);
      if (!saved) throw new Error('Could not prepare the selected shop locally.');

      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch shop');
      setBusy(false);
    }
  };

  return (
    <div className="fixed top-3 right-3 z-[100]">
      <button
        type="button"
        onClick={() => { setOpen(value => !value); setError(''); }}
        disabled={busy}
        className="flex items-center gap-2 rounded-xl border border-line bg-panel/95 px-3 py-2 shadow-lg backdrop-blur text-sm font-semibold text-ink hover:bg-raised disabled:opacity-70"
        title="Switch active shop"
      >
        {busy ? <Loader2 size={15} className="animate-spin text-violet-500" /> : <Store size={15} className="text-violet-500" />}
        <span className="max-w-[180px] truncate">{activeShop.name}</span>
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && !busy && (
        <div className="mt-2 w-72 rounded-2xl border border-line bg-panel shadow-2xl p-2">
          <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-faint">Active shop</div>
          {shops.map(shop => (
            <button
              key={shop.id}
              type="button"
              onClick={() => void switchShop(shop)}
              className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-raised transition-colors"
            >
              <span className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center shrink-0"><Store size={15} className="text-violet-500" /></span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-ink">{shop.name}</span><span className="block text-[10px] uppercase tracking-wider text-faint">{shop.role}</span></span>
              {shop.id === activeShop.id && <Check size={16} className="text-emerald-500 shrink-0" />}
            </button>
          ))}
          {error && <div className="mt-2 flex gap-2 rounded-xl bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700"><AlertCircle size={14} className="shrink-0 mt-0.5" />{error}</div>}
        </div>
      )}
    </div>
  );
}
