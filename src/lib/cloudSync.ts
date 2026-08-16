import type { POSState } from './types';
import { supabase, supabaseConfigured } from './supabase';

const DEVICE_KEY = 'nexfix_device_id';
const SHOP_KEY = 'nexfix_cloud_shop_id';
const REV_KEY = 'nexfix_cloud_revision';

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function deviceId(): string {
  const s = storage();
  try {
    const existing = s?.getItem(DEVICE_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    s?.setItem(DEVICE_KEY, id);
    return id;
  } catch { return 'browser-device'; }
}

export function getCloudShopId(): string {
  try { return storage()?.getItem(SHOP_KEY) || (import.meta.env.VITE_SUPABASE_SHOP_ID || '').trim(); } catch { return ''; }
}

export function setCloudShopId(id: string): void {
  try { storage()?.setItem(SHOP_KEY, id.trim()); } catch { /* ignore */ }
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

/**
 * Publish the complete local snapshot using an optimistic revision.
 * A conflict is deliberately surfaced to the caller; this function never
 * overwrites a newer remote snapshot automatically.
 */
export async function syncStateSnapshot(state: POSState): Promise<CloudSyncResult> {
  if (!supabaseConfigured || !supabase) return { status: 'disabled' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { status: 'offline' };
  const shopId = getCloudShopId();
  if (!shopId) return { status: 'disabled' };

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { status: 'error', message: sessionError.message };
  if (!sessionData.session) return { status: 'disabled' };

  const expectedRevision = getRevision();
  const { data, error } = await supabase.rpc('upsert_pos_snapshot', {
    p_shop_id: shopId,
    p_device_id: deviceId(),
    p_expected_revision: expectedRevision,
    p_state: state,
  });

  if (error) return { status: 'error', message: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { status: 'error', message: 'No sync response received' };

  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    return { status: 'error', message: 'Invalid revision returned by server' };
  }
  if (row.conflict) return { status: 'conflict', remoteRevision: revision };
  if (row.ok) {
    setRevision(revision);
    return { status: 'synced', revision };
  }
  return { status: 'error', message: 'Cloud sync was not accepted' };
}

export async function downloadStateSnapshot(): Promise<{ state: POSState; revision: number } | null> {
  if (!supabaseConfigured || !supabase || !getCloudShopId()) return null;
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) return null;
  const { data, error } = await supabase
    .from('pos_state_snapshots')
    .select('state, revision')
    .eq('shop_id', getCloudShopId())
    .maybeSingle();
  if (error || !data || !data.state) return null;
  const revision = Number(data.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) return null;
  setRevision(revision);
  return { state: data.state as POSState, revision };
}

export async function resolveCloudConflict(): Promise<{ state: POSState; revision: number } | null> {
  return downloadStateSnapshot();
}
