import type { POSState } from './types';
import { supabase, supabaseConfigured } from './supabase';

const DEVICE_KEY = 'nexfix_device_id';
const SHOP_KEY = 'nexfix_cloud_shop_id';
const REV_KEY = 'nexfix_cloud_revision';

function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return 'browser-device';
  }
}

export function getCloudShopId(): string {
  try { return localStorage.getItem(SHOP_KEY) || (import.meta.env.VITE_SUPABASE_SHOP_ID || '').trim(); } catch { return ''; }
}

export function setCloudShopId(id: string): void {
  try { localStorage.setItem(SHOP_KEY, id.trim()); } catch { /* ignore */ }
}

function getRevision(): number {
  try { return Number(localStorage.getItem(REV_KEY) || '0') || 0; } catch { return 0; }
}

function setRevision(revision: number): void {
  try { localStorage.setItem(REV_KEY, String(revision)); } catch { /* ignore */ }
}

export type CloudSyncResult =
  | { status: 'disabled' }
  | { status: 'offline' }
  | { status: 'synced'; revision: number }
  | { status: 'conflict'; remoteRevision: number }
  | { status: 'error'; message: string };

export async function syncStateSnapshot(state: POSState): Promise<CloudSyncResult> {
  if (!supabaseConfigured || !supabase) return { status: 'disabled' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { status: 'offline' };
  const shopId = getCloudShopId();
  if (!shopId) return { status: 'disabled' };

  const { data: sessionData } = await supabase.auth.getSession();
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
  if (row.conflict) return { status: 'conflict', remoteRevision: Number(row.revision) || 0 };
  if (row.ok) {
    setRevision(Number(row.revision) || expectedRevision + 1);
    return { status: 'synced', revision: Number(row.revision) || expectedRevision + 1 };
  }
  return { status: 'error', message: 'Cloud sync was not accepted' };
}

export async function downloadStateSnapshot(): Promise<{ state: POSState; revision: number } | null> {
  if (!supabaseConfigured || !supabase || !getCloudShopId()) return null;
  const { data, error } = await supabase
    .from('pos_state_snapshots')
    .select('state, revision')
    .eq('shop_id', getCloudShopId())
    .maybeSingle();
  if (error || !data || !data.state) return null;
  setRevision(Number(data.revision) || 0);
  return { state: data.state as POSState, revision: Number(data.revision) || 0 };
}
