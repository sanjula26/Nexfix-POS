import type { POSState } from './types';
import { supabase, supabaseConfigured } from './supabase';

const DEVICE_KEY = 'nexfix_device_id';
const SHOP_KEY = 'nexfix_cloud_shop_id';
const REV_KEY = 'nexfix_cloud_revision';
const MAX_SHOP_ID_LENGTH = 100;
const MAX_DEVICE_ID_LENGTH = 200;
let fallbackDeviceId: string | null = null;

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function deviceId(): string {
  const s = storage();
  try {
    const existing = s?.getItem(DEVICE_KEY)?.trim();
    if (existing && existing.length <= MAX_DEVICE_ID_LENGTH) return existing;
    const id = crypto.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    s?.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    if (!fallbackDeviceId) fallbackDeviceId = `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return fallbackDeviceId;
  }
}

export function getCloudShopId(): string {
  try {
    const id = (storage()?.getItem(SHOP_KEY) || import.meta.env.VITE_SUPABASE_SHOP_ID || '').trim();
    return id.length <= MAX_SHOP_ID_LENGTH ? id : '';
  } catch { return ''; }
}

export function setCloudShopId(id: string): void {
  const normalized = id.trim();
  if (!normalized || normalized.length > MAX_SHOP_ID_LENGTH) return;
  try { storage()?.setItem(SHOP_KEY, normalized); } catch { /* ignore */ }
}

/** Resolve the authenticated user's shop, creating the first shop only when none exists. */
export async function ensureCloudShop(shopName = 'Nexfix Shop'): Promise<{ ok: boolean; shopId?: string; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud authentication is not configured' };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { ok: false, error: sessionError.message };
  if (!sessionData.session) return { ok: false, error: 'Cloud session is not available' };

  const cached = getCloudShopId();
  if (cached) {
    const { data } = await supabase.from('shop_memberships').select('shop_id').eq('shop_id', cached).eq('user_id', sessionData.session.user.id).eq('active', true).maybeSingle();
    if (data?.shop_id) return { ok: true, shopId: data.shop_id };
    try { storage()?.removeItem(SHOP_KEY); } catch { /* ignore */ }
  }

  const { data: membership, error: membershipError } = await supabase
    .from('shop_memberships')
    .select('shop_id')
    .eq('user_id', sessionData.session.user.id)
    .eq('active', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (membershipError) return { ok: false, error: membershipError.message };
  if (membership?.shop_id) {
    setCloudShopId(membership.shop_id);
    return { ok: true, shopId: membership.shop_id };
  }

  const { data: created, error: createError } = await supabase.rpc('bootstrap_first_shop', { shop_name: shopName.trim().slice(0, 120) || 'Nexfix Shop' });
  if (createError) return { ok: false, error: createError.message };
  if (!created) return { ok: false, error: 'Cloud shop bootstrap returned no shop id' };
  setCloudShopId(String(created));
  return { ok: true, shopId: String(created) };
}

function getRevision(): number {
  try {
    const value = Number(storage()?.getItem(REV_KEY) || '0');
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch { return 0; }
}

function setRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) return;
  try { storage()?.setItem(REV_KEY, String(revision)); } catch { /* ignore */ }
}

export type CloudSyncResult =
  | { status: 'disabled' }
  | { status: 'offline' }
  | { status: 'synced'; revision: number }
  | { status: 'conflict'; remoteRevision: number }
  | { status: 'error'; message: string };

export async function completeSaleAtomic(input: {
  shopId: string;
  saleId: string;
  customerId?: string;
  shipping?: number;
  discount?: number;
  taxPct?: number;
  pointsRedeemed?: number;
  note?: string;
  salesmanId?: string;
  lines: Array<{ product_id: string; qty: number; discount?: number; price?: number; unit_ids?: string[] }>;
  payments: Array<{ method: string; amount: number }>;
}): Promise<{ ok: boolean; alreadyCommitted?: boolean; saleId?: string; billNo?: string; total?: number; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { ok: false, error: sessionError.message };
  if (!sessionData.session) return { ok: false, error: 'Cloud session is not available' };
  if (!input.shopId) return { ok: false, error: 'Cloud shop is not configured' };

  const { data, error } = await supabase.rpc('complete_sale_atomic', {
    p_shop_id: input.shopId,
    p_sale_id: input.saleId,
    p_customer_id: input.customerId || null,
    p_shipping: input.shipping ?? 0,
    p_discount: input.discount ?? 0,
    p_tax_pct: input.taxPct ?? 0,
    p_points_redeemed: input.pointsRedeemed ?? 0,
    p_note: input.note || null,
    p_salesman_id: input.salesmanId || null,
    p_lines: input.lines,
    p_payments: input.payments,
  });
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) return { ok: false, error: 'Cloud sale was not committed' };
  return {
    ok: true,
    alreadyCommitted: row.already_committed === true,
    saleId: row.sale_id,
    billNo: row.bill_no,
    total: Number(row.total),
  };
}

export async function syncStateSnapshot(state: POSState): Promise<CloudSyncResult> {
  if (!supabaseConfigured || !supabase) return { status: 'disabled' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { status: 'offline' };
  const shopId = getCloudShopId();
  if (!shopId) return { status: 'disabled' };
  const currentDeviceId = deviceId();
  if (!currentDeviceId || currentDeviceId.length > MAX_DEVICE_ID_LENGTH) return { status: 'error', message: 'Invalid device identifier' };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { status: 'error', message: sessionError.message };
  if (!sessionData.session) return { status: 'disabled' };
  const { error: deviceError } = await supabase.rpc('register_pos_device', { p_shop_id: shopId, p_device_id: currentDeviceId });
  if (deviceError) return { status: 'error', message: deviceError.message };
  const expectedRevision = getRevision();
  const { data, error } = await supabase.rpc('upsert_pos_snapshot', { p_shop_id: shopId, p_device_id: currentDeviceId, p_expected_revision: expectedRevision, p_state: state });
  if (error) return { status: 'error', message: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { status: 'error', message: 'No sync response received' };
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) return { status: 'error', message: 'Invalid revision returned by server' };
  if (row.conflict === true) return { status: 'conflict', remoteRevision: revision };
  if (row.ok === true) { setRevision(revision); return { status: 'synced', revision }; }
  return { status: 'error', message: 'Cloud sync was not accepted' };
}

export async function downloadStateSnapshot(): Promise<{ state: POSState; revision: number } | null> {
  if (!supabaseConfigured || !supabase || !getCloudShopId()) return null;
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) return null;
  const { data, error } = await supabase.from('pos_state_snapshots').select('state, revision').eq('shop_id', getCloudShopId()).maybeSingle();
  if (error || !data || !data.state) return null;
  const revision = Number(data.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) return null;
  setRevision(revision);
  return { state: data.state as POSState, revision };
}

export async function resolveCloudConflict(): Promise<{ state: POSState; revision: number } | null> { return downloadStateSnapshot(); }
