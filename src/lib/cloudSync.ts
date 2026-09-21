import type { POSState } from './types';
import { supabase, supabaseConfigured } from './supabase';
import { getMachineIdentity } from './machine';

const DEVICE_KEY = 'nexfix_device_id';
const SHOP_KEY = 'nexfix_cloud_shop_id';
const REV_KEY = 'nexfix_cloud_revision';
const MAX_SHOP_ID_LENGTH = 100;
const MAX_DEVICE_ID_LENGTH = 200;
let fallbackDeviceId: string | null = null;

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function sanitizeCloudSnapshotState(state: POSState): POSState {
  return {
    ...state,
    users: [],
    sessions: [],
    settings: {
      ...state.settings,
      adminPinHash: '',
    },
  };
}

function deviceId(): string {
  const machineId = getMachineIdentity().id;
  if (machineId) return machineId;
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

/**
 * Mirror only catalog records that do not already exist in the cloud.
 * Cloud stock, customer balances/points, and tracked-unit status are authoritative;
 * reconnecting an offline POS must never overwrite newer cloud state with stale local data.
 */
export async function syncNormalizedCatalog(state: POSState, shopId = getCloudShopId()): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud is not configured' };
  if (!shopId) return { ok: false, error: 'Cloud shop is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { ok: false, error: sessionError.message };
  const uid = sessionData.session?.user.id;
  if (!uid) return { ok: false, error: 'Cloud session is not available' };
  const { data: membership, error: membershipError } = await supabase.from('shop_memberships').select('role').eq('shop_id', shopId).eq('user_id', uid).eq('active', true).maybeSingle();
  if (membershipError) return { ok: false, error: membershipError.message };
  if (!membership || !['admin', 'manager'].includes(membership.role)) return { ok: false, error: 'Catalog sync requires admin or manager access' };

  const productRows = state.products.map(p => ({
    id: p.id, shop_id: shopId, name: p.name, sku: p.sku || null, barcode: p.barcode || null,
    description: null, cost: p.cost || 0, price: p.price || 0, reorder_level: p.reorderLevel ?? 5,
    track_imei: !!p.trackImei, track_serial: !!p.trackSerial, track_expiry: !!p.trackExpiry,
    warranty_months: p.warrantyMonths ?? 0, is_kit: !!p.isKit, is_service: !!p.isService,
    active: p.active !== false, attributes: p.attributes || {}, image_url: null,
    category_id: null, brand_id: null, supplier_id: null, created_at: p.createdAt || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));
  if (productRows.length) {
    const ids = productRows.map(p => p.id);
    const { data: existing, error: existingError } = await supabase.from('products').select('id').eq('shop_id', shopId).in('id', ids);
    if (existingError) return { ok: false, error: `Products lookup: ${existingError.message}` };
    const existingIds = new Set((existing || []).map(row => row.id));
    const missing = productRows.filter(row => !existingIds.has(row.id));
    if (missing.length) {
      const { error } = await supabase.from('products').insert(missing);
      if (error) return { ok: false, error: `Products: ${error.message}` };
    }
  }

  const customerRows = state.customers.map(c => ({
    id: c.id, shop_id: shopId, name: c.name, phone: c.phone || null, email: c.email || null,
    nic: c.nic || null, address: c.address || null, credit_limit: Math.max(0, Number(c.creditLimit ?? 0) || 0), notes: null,
    created_at: c.createdAt || new Date().toISOString(), updated_at: new Date().toISOString(),
  }));
  if (customerRows.length) {
    const ids = customerRows.map(c => c.id);
    const { data: existing, error: existingError } = await supabase.from('customers').select('id').eq('shop_id', shopId).in('id', ids);
    if (existingError) return { ok: false, error: `Customers lookup: ${existingError.message}` };
    const existingIds = new Set((existing || []).map(row => row.id));
    const missing = customerRows.filter(row => !existingIds.has(row.id));
    if (missing.length) {
      const { error } = await supabase.from('customers').insert(missing);
      if (error) return { ok: false, error: `Customers: ${error.message}` };
    }
    const existingRows = customerRows.filter(row => existingIds.has(row.id));
    for (const row of existingRows) {
      const { error } = await supabase.from('customers').update({
        credit_limit: row.credit_limit,
        updated_at: new Date().toISOString(),
      }).eq('id', row.id).eq('shop_id', shopId);
      if (error) return { ok: false, error: `Customer credit limit: ${error.message}` };
    }
  }

  const unitRows = (state.units || []).filter(u => u.status === 'in_stock').map(u => ({
    id: u.id, shop_id: shopId, product_id: u.productId, imei: u.imei || null, serial: u.serial || null,
    expiry_date: u.expiryDate || null, cost: u.cost ?? null, warranty_expires_at: u.warrantyExpiresAt || null,
    note: u.note || null, created_at: u.createdAt || new Date().toISOString(),
  }));
  if (unitRows.length) {
    const ids = unitRows.map(u => u.id);
    const { data: existing, error: existingError } = await supabase.from('inventory_units').select('id').eq('shop_id', shopId).in('id', ids);
    if (existingError) return { ok: false, error: `Inventory units lookup: ${existingError.message}` };
    const existingIds = new Set((existing || []).map(row => row.id));
    const missing = unitRows.filter(row => !existingIds.has(row.id));
    if (missing.length) {
      const { error } = await supabase.from('inventory_units').insert(missing);
      if (error) return { ok: false, error: `Inventory units: ${error.message}` };
    }
  }
  return { ok: true };
}

function getRevision(): number { try { const value = Number(storage()?.getItem(REV_KEY) || '0'); return Number.isSafeInteger(value) && value >= 0 ? value : 0; } catch { return 0; } }
function setRevision(revision: number): void { if (!Number.isSafeInteger(revision) || revision < 0) return; try { storage()?.setItem(REV_KEY, String(revision)); } catch { /* ignore */ } }

export type CloudSyncResult =
  | { status: 'disabled' }
  | { status: 'offline' }
  | { status: 'synced'; revision: number }
  | { status: 'conflict'; remoteRevision: number }
  | { status: 'error'; message: string };

export interface CommittedCloudSale {
  sale: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
  payments: Array<Record<string, unknown>>;
  products: Array<Record<string, unknown>>;
  customer: Record<string, unknown> | null;
  units: Array<Record<string, unknown>>;
}

export async function completeSaleAtomic(input: {
  shopId: string; saleId: string; customerId?: string; shipping?: number; discount?: number; taxPct?: number;
  pointsRedeemed?: number; note?: string; salesmanId?: string;
  lines: Array<{ product_id: string; qty: number; discount?: number; price?: number; unit_ids?: string[] }>;
  payments: Array<{ method: string; amount: number }>;
}): Promise<{ ok: boolean; alreadyCommitted?: boolean; saleId?: string; billNo?: string; total?: number; error?: string; committed?: CommittedCloudSale }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { ok: false, error: sessionError.message };
  if (!sessionData.session) return { ok: false, error: 'Cloud session is not available' };
  if (!input.shopId) return { ok: false, error: 'Cloud shop is not configured' };
  const { data, error } = await supabase.rpc('complete_sale_atomic', { p_shop_id: input.shopId, p_sale_id: input.saleId, p_customer_id: input.customerId || null, p_shipping: input.shipping ?? 0, p_discount: input.discount ?? 0, p_tax_pct: input.taxPct ?? 0, p_points_redeemed: input.pointsRedeemed ?? 0, p_note: input.note || null, p_salesman_id: input.salesmanId || null, p_lines: input.lines, p_payments: input.payments });
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok || !row.sale) return { ok: false, error: 'Cloud sale was not committed' };
  return {
    ok: true,
    alreadyCommitted: row.already_committed === true,
    saleId: row.sale_id,
    billNo: row.bill_no,
    total: Number(row.total),
    committed: {
      sale: row.sale as Record<string, unknown>,
      items: Array.isArray(row.items) ? row.items as Array<Record<string, unknown>> : [],
      payments: Array.isArray(row.payments) ? row.payments as Array<Record<string, unknown>> : [],
      products: Array.isArray(row.products) ? row.products as Array<Record<string, unknown>> : [],
      customer: row.customer && typeof row.customer === 'object' ? row.customer as Record<string, unknown> : null,
      units: Array.isArray(row.units) ? row.units as Array<Record<string, unknown>> : [],
    },
  };
}

export async function registerTradeInAtomic(input: {
  shopId: string; saleId: string; unitId: string; productId: string; value: number; imei?: string; serial?: string;
}): Promise<{ ok: boolean; alreadyCommitted?: boolean; unitId?: string; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { ok: false, error: sessionError.message };
  if (!sessionData.session) return { ok: false, error: 'Cloud session is not available' };
  const { data, error } = await supabase.rpc('register_trade_in_atomic', {
    p_shop_id: input.shopId, p_sale_id: input.saleId, p_unit_id: input.unitId, p_product_id: input.productId,
    p_value: input.value, p_imei: input.imei || null, p_serial: input.serial || null,
  });
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) return { ok: false, error: 'Cloud trade-in was not committed' };
  return { ok: true, alreadyCommitted: row.already_committed === true, unitId: String(row.unit_id || input.unitId) };
}

export async function resolveSaleReturnLines(input: {
  shopId: string;
  saleId: string;
  lines: Array<{ product_id: string; qty: number; unit_ids?: string[] }>;
}): Promise<{ ok: boolean; lines?: Array<{ sale_item_id: string; qty: number; unit_ids?: string[] }>; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { ok: false, error: sessionError.message };
  if (!sessionData.session) return { ok: false, error: 'Cloud session is not available' };
  if (!input.shopId || !input.saleId || !input.lines.length) return { ok: false, error: 'Return identifiers and lines are required' };
  const { data, error } = await supabase.rpc('resolve_sale_return_items', { p_shop_id: input.shopId, p_sale_id: input.saleId, p_lines: input.lines });
  if (error) return { ok: false, error: error.message };
  const rows = Array.isArray(data) ? data : [];
  if (!rows.length) return { ok: false, error: 'Cloud sale item could not be matched' };
  return { ok: true, lines: rows as Array<{ sale_item_id: string; qty: number; unit_ids?: string[] }> };
}

export async function processSaleReturnAtomic(input: {
  shopId: string;
  returnId: string;
  saleId: string;
  reason?: string;
  mode: 'refund' | 'replace';
  paymentMethod?: string;
  lines: Array<{ sale_item_id: string; qty: number; unit_ids?: string[] }>;
}): Promise<{ ok: boolean; alreadyCommitted?: boolean; returnId?: string; returnNo?: string; refundAmount?: number; additionalPayment?: number; saleId?: string; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { ok: false, error: sessionError.message };
  if (!sessionData.session) return { ok: false, error: 'Cloud session is not available' };
  if (!input.shopId || !input.returnId || !input.saleId) return { ok: false, error: 'Missing return identifiers' };
  if (!input.lines.length) return { ok: false, error: 'Return lines are required' };
  const { data, error } = await supabase.rpc('process_sale_return_atomic', { p_shop_id: input.shopId, p_return_id: input.returnId, p_sale_id: input.saleId, p_reason: input.reason?.trim().slice(0, 500) || '', p_mode: input.mode, p_payment_method: input.paymentMethod || null, p_lines: input.lines });
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) return { ok: false, error: 'Cloud return was not committed' };
  return { ok: true, alreadyCommitted: row.already_committed === true, returnId: row.return_id, returnNo: row.return_no, refundAmount: Number(row.refund_amount), additionalPayment: Number(row.additional_payment), saleId: row.sale_id };
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
  const cloudState = sanitizeCloudSnapshotState(state);
  const { data, error } = await supabase.rpc('upsert_pos_snapshot', { p_shop_id: shopId, p_device_id: currentDeviceId, p_expected_revision: expectedRevision, p_state: cloudState });
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
  const cloudState = sanitizeCloudSnapshotState(data.state as POSState);
  return { state: cloudState, revision };
}

export async function resolveCloudConflict(): Promise<{ state: POSState; revision: number } | null> { return downloadStateSnapshot(); }