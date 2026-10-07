import type { POSState, Purchase } from './types';
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

/** Resolve an explicitly provisioned active shop membership for the authenticated user. */
export async function ensureCloudShop(shopName = 'Nexfix Shop'): Promise<{ ok: boolean; shopId?: string; error?: string }> {
  void shopName;
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

  // Security boundary: shop membership is the cloud authorization source of truth.
  // Do not auto-bootstrap a shop from a background sync/login path. Any
  // authenticated user without an existing membership must be explicitly
  // provisioned by an owner/admin; otherwise a local cashier could become the
  // first cloud shop administrator simply by signing in.
  return { ok: false, error: 'Cloud shop membership is not provisioned for this user' };
}

/** Register this machine with the currently authenticated cloud shop.
 * The server remains the source of truth for device ownership and membership.
 */
/** Resolve a local POS salesman to the authenticated cloud profile for this shop.
 * Local POS account IDs and Supabase auth/profile IDs are separate namespaces.
 * Never pass a local POS UUID into the cloud sale RPC.
 */
export async function resolveCloudSalesmanId(
  shopId: string,
  localSalesman?: { email?: string } | null,
): Promise<string | undefined> {
  if (!supabaseConfigured || !supabase || !shopId) return undefined;

  const email = localSalesman?.email?.trim().toLowerCase();
  if (email) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', email)
      .eq('active', true)
      .maybeSingle();

    if (profile?.id) {
      const { data: membership } = await supabase
        .from('shop_memberships')
        .select('user_id')
        .eq('shop_id', shopId)
        .eq('user_id', profile.id)
        .eq('active', true)
        .maybeSingle();
      if (membership?.user_id) return String(profile.id);
    }
  }

  // If a specific local salesman was selected but has no cloud profile,
  // do not silently credit the sale to another cloud account.
  if (localSalesman) return undefined;

  const { data: sessionData } = await supabase.auth.getSession();
  const authUserId = sessionData.session?.user.id;
  if (!authUserId) return undefined;
  const { data: membership } = await supabase
    .from('shop_memberships')
    .select('user_id')
    .eq('shop_id', shopId)
    .eq('user_id', authUserId)
    .eq('active', true)
    .maybeSingle();
  return membership?.user_id ? String(authUserId) : undefined;
}

export async function registerDesktopUpdaterDevice(shopId: string): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud authentication is not configured' };
  const normalizedShopId = shopId.trim();
  const normalizedDeviceId = deviceId().trim();
  if (!normalizedShopId) return { ok: false, error: 'Cloud shop is not configured' };
  if (!normalizedDeviceId) return { ok: false, error: 'This machine does not have a valid device identity' };

  const { data, error } = await supabase.rpc('register_pos_device', {
    p_shop_id: normalizedShopId,
    p_device_id: normalizedDeviceId,
  });
  if (error) return { ok: false, error: error.message };
  if (data && typeof data === 'object' && 'ok' in data && (data as { ok?: unknown }).ok !== true) {
    return { ok: false, error: 'The cloud service did not authorize this POS device' };
  }
  return { ok: true };
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
    description: null, cost: p.cost || 0, price: p.price || 0, stock: Math.max(0, Math.round(Number(p.stock) || 0)), reorder_level: p.reorderLevel ?? 5,
    track_imei: !!p.trackImei, track_serial: !!p.trackSerial, track_expiry: !!p.trackExpiry,
    warranty_months: p.warrantyMonths ?? 0, is_kit: !!p.isKit, is_service: !!p.isService,
    active: p.active !== false, attributes: p.attributes || {}, image_url: null,
    category_id: null, brand_id: null, supplier_id: null, created_at: p.createdAt || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));
  if (productRows.length) {
    const ids = productRows.map(p => p.id);
    const { data: existing, error: existingError } = await supabase.from('products').select('id,stock').eq('shop_id', shopId).in('id', ids);
    if (existingError) return { ok: false, error: `Products lookup: ${existingError.message}` };
    const existingRows = (existing || []) as Array<{ id: string; stock?: number }>;
    const existingIds = new Set(existingRows.map(row => row.id));
    const missing = productRows.filter(row => !existingIds.has(row.id));
    if (missing.length) {
      const { error } = await supabase.from('products').insert(missing);
      if (error) return { ok: false, error: `Products: ${error.message}` };
    }

    // Reconcile catalog metadata edits without ever overwriting cloud stock.
    // Transactional stock changes remain authoritative in the database.
    const existingProductRows = productRows.filter(row => existingIds.has(row.id));
    if (existingProductRows.length) {
      for (const row of existingProductRows) {
        const { error } = await supabase.from('products').update({
          name: row.name, sku: row.sku, barcode: row.barcode, cost: row.cost, price: row.price,
          reorder_level: row.reorder_level, track_imei: row.track_imei, track_serial: row.track_serial,
          track_expiry: row.track_expiry, warranty_months: row.warranty_months, is_kit: row.is_kit,
          is_service: row.is_service, active: row.active, attributes: row.attributes,
          supplier_id: row.supplier_id, updated_at: row.updated_at,
        }).eq('id', row.id).eq('shop_id', shopId);
        if (error) return { ok: false, error: `Products update: ${error.message}` };
      }
    }

    // The first full-shop stock entry is created locally before later purchases
    // move through GRN. Missing cloud products now receive their initial stock
    // directly on insert. Existing products created by an older build may have
    // been inserted with stock=0; repair that exact bootstrap case once, but
    // never overwrite cloud stock after any normalized transaction/unit exists.
    const localProductById = new Map(productRows.map(row => [row.id, row]));
    const needsInitialBootstrap = existingRows.some(row =>
      Number(row.stock || 0) === 0 && Number(localProductById.get(row.id)?.stock || 0) > 0,
    );
    if (needsInitialBootstrap) {
      const bootstrapRows = productRows
        .filter(row => existingIds.has(row.id) && Number(row.stock) > 0)
        .map(row => ({ product_id: row.id, stock: Number(row.stock) || 0 }));
      const { error: bootstrapError } = await supabase.rpc('bootstrap_initial_catalog_stock', {
        p_shop_id: shopId,
        p_rows: bootstrapRows,
      });
      if (bootstrapError) return { ok: false, error: `Initial cloud stock bootstrap: ${bootstrapError.message}` };
    }
  }

  // Kit/BOM definitions are normalized catalog data too. Replace the cloud BOM
  // for the shop's kit products so removals are reflected, not just additions.
  const kitProductIds = productRows.filter(p => p.is_kit).map(p => p.id);
  if (kitProductIds.length) {
    const { error: deleteKitError } = await supabase.from('kit_items').delete().in('kit_product_id', kitProductIds);
    if (deleteKitError) return { ok: false, error: `Kit BOM delete: ${deleteKitError.message}` };
    const kitRows = (state.kitItems || [])
      .filter(k => kitProductIds.includes(k.kitProductId))
      .map(k => ({ kit_product_id: k.kitProductId, component_product_id: k.componentProductId, qty: k.qty }));
    if (kitRows.length) {
      const { error: insertKitError } = await supabase.from('kit_items').insert(kitRows);
      if (insertKitError) return { ok: false, error: `Kit BOM insert: ${insertKitError.message}` };
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

    // Reconcile editable customer identity/contact fields only. Credit balance
    // and loyalty points are transaction-owned and must never be overwritten
    // from an offline snapshot.
    for (const row of customerRows.filter(item => existingIds.has(item.id))) {
      const { error } = await supabase.from('customers').update({
        name: row.name, phone: row.phone, email: row.email, nic: row.nic,
        address: row.address, credit_limit: row.credit_limit, updated_at: row.updated_at,
      }).eq('id', row.id).eq('shop_id', shopId);
      if (error) return { ok: false, error: `Customers update: ${error.message}` };
    }
  }

  const supplierRows = state.suppliers.map(s => ({
    id: s.id, shop_id: shopId, name: s.name, contact_person: s.contactPerson || null,
    phone: s.phone || null, email: s.email || null, address: s.address || null,
    created_at: s.createdAt || new Date().toISOString(),
  }));
  if (supplierRows.length) {
    const ids = supplierRows.map(s => s.id);
    const { data: existing, error: existingError } = await supabase.from('suppliers').select('id').eq('shop_id', shopId).in('id', ids);
    if (existingError) return { ok: false, error: `Suppliers lookup: ${existingError.message}` };
    const existingIds = new Set((existing || []).map(row => row.id));
    const missing = supplierRows.filter(row => !existingIds.has(row.id));
    if (missing.length) {
      const { error } = await supabase.from('suppliers').insert(missing);
      if (error) return { ok: false, error: `Suppliers: ${error.message}` };
    }
    for (const row of supplierRows.filter(item => existingIds.has(item.id))) {
      const { error } = await supabase.from('suppliers').update({
        name: row.name, contact_person: row.contact_person, phone: row.phone,
        email: row.email, address: row.address,
      }).eq('id', row.id).eq('shop_id', shopId);
      if (error) return { ok: false, error: `Suppliers update: ${error.message}` };
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

export async function requestSaleReversal(input: {
  shopId: string; requestId: string; saleId: string; reason: string;
}): Promise<{ ok: boolean; alreadyCommitted?: boolean; requestId?: string; saleId?: string; status?: string; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { ok: false, error: sessionError.message };
  if (!sessionData.session) return { ok: false, error: 'Cloud session is not available' };
  const { data, error } = await supabase.rpc('request_sale_reversal', {
    p_shop_id: input.shopId, p_request_id: input.requestId, p_sale_id: input.saleId, p_reason: input.reason.trim().slice(0, 500),
  });
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) return { ok: false, error: 'Cloud reversal request was not committed' };
  return { ok: true, alreadyCommitted: row.already_committed === true, requestId: row.request_id, saleId: row.sale_id, status: row.status };
}

export async function approveSaleReversal(input: {
  shopId: string; requestId: string;
}): Promise<{ ok: boolean; alreadyCommitted?: boolean; requestId?: string; saleId?: string; billNo?: string; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { ok: false, error: sessionError.message };
  if (!sessionData.session) return { ok: false, error: 'Cloud session is not available' };
  const { data, error } = await supabase.rpc('approve_sale_reversal', { p_shop_id: input.shopId, p_request_id: input.requestId });
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) return { ok: false, error: 'Cloud reversal approval was not committed' };
  return { ok: true, alreadyCommitted: row.already_committed === true, requestId: row.request_id, saleId: row.sale_id, billNo: row.bill_no };
}

export async function rejectSaleReversal(input: {
  shopId: string; requestId: string; note?: string;
}): Promise<{ ok: boolean; alreadyCommitted?: boolean; requestId?: string; status?: string; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { ok: false, error: sessionError.message };
  if (!sessionData.session) return { ok: false, error: 'Cloud session is not available' };
  const { data, error } = await supabase.rpc('reject_sale_reversal', { p_shop_id: input.shopId, p_request_id: input.requestId, p_note: input.note?.trim().slice(0, 500) || null });
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) return { ok: false, error: 'Cloud reversal rejection was not committed' };
  return { ok: true, alreadyCommitted: row.already_committed === true, requestId: row.request_id, status: row.status };
}

export async function listSaleReversalRequests(shopId: string): Promise<{ ok: boolean; requests?: Array<{
  id:string; saleId:string; billNo:string; reason:string; requestedBy:string; requestedAt:string; status:'pending'|'approved'|'rejected'; reviewedBy?:string; reviewedAt?:string; reviewNote?:string;
}>; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { ok: false, error: sessionError.message };
  if (!sessionData.session) return { ok: false, error: 'Cloud session is not available' };
  const { data, error } = await supabase.rpc('list_sale_reversal_requests', { p_shop_id: shopId });
  if (error) return { ok: false, error: error.message };
  return { ok: true, requests: (Array.isArray(data) ? data : []) as any };
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

export async function receivePurchaseAtomic(input: {
  shopId: string; purchaseId: string; deviceId: string; purchase: Purchase;
}): Promise<{ok:boolean; alreadyCommitted?:boolean; purchaseId?:string; total?:number; error?:string}> {
  if (!supabaseConfigured || !supabase) return { ok:false, error:'Cloud is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok:false, error:'offline' };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { ok:false, error:sessionError.message };
  if (!sessionData.session) return { ok:false, error:'Cloud session is not available' };
  if (!input.shopId || !input.purchaseId || !input.deviceId) return { ok:false, error:'Missing GRN identifiers' };
  const { data, error } = await supabase.rpc('receive_purchase_atomic', {
    p_shop_id: input.shopId,
    p_purchase_id: input.purchaseId,
    p_device_id: input.deviceId,
    p_purchase: input.purchase,
  });
  if (error) return { ok:false, error:error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) return { ok:false, error:'Cloud GRN receive was not committed' };
  return { ok:true, alreadyCommitted:row.already_committed === true, purchaseId:row.purchase_id, total:Number(row.total || 0) };
}

export async function processRepairDeliveryAtomic(input: {
  shopId: string; repairId: string; deviceId: string; repair: unknown;
}): Promise<{ok:boolean; alreadyCommitted?:boolean; repairId?:string; error?:string}> {
  if (!supabaseConfigured || !supabase) return { ok:false, error:'Cloud is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok:false, error:'offline' };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { ok:false, error:sessionError.message };
  if (!sessionData.session) return { ok:false, error:'Cloud session is not available' };
  if (!input.shopId || !input.repairId || !input.deviceId) return { ok:false, error:'Missing repair identifiers' };
  const { data, error } = await supabase.rpc('process_repair_delivery_atomic', {
    p_shop_id: input.shopId, p_repair_id: input.repairId, p_device_id: input.deviceId, p_repair: input.repair,
  });
  if (error) return { ok:false, error:error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) return { ok:false, error:'Cloud repair delivery was not committed' };
  return { ok:true, alreadyCommitted:row.already_committed === true, repairId:row.repair_id };
}

export async function processPurchaseReturnAtomic(input: {
  shopId: string;
  returnId: string;
  purchaseId: string;
  deviceId: string;
  reason: string;
  purchase: Purchase;
  lines: Array<{ item_idx: number; product_id: string; qty: number; cost: number; unit_ids?: string[] }>;
}): Promise<{ok:boolean; alreadyCommitted?:boolean; returnId?:string; returnNo?:string; total?:number; purchaseId?:string; error?:string}> {
  if (!supabaseConfigured || !supabase) return { ok:false, error:'Cloud is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok:false, error:'offline' };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { ok:false, error:sessionError.message };
  if (!sessionData.session) return { ok:false, error:'Cloud session is not available' };
  if (!input.shopId || !input.returnId || !input.purchaseId || !input.deviceId) return { ok:false, error:'Missing supplier return identifiers' };
  if (!input.lines.length) return { ok:false, error:'Return lines are required' };
  const { data, error } = await supabase.rpc('process_purchase_return_atomic', {
    p_shop_id: input.shopId,
    p_return_id: input.returnId,
    p_purchase_id: input.purchaseId,
    p_device_id: input.deviceId,
    p_reason: input.reason.trim().slice(0, 500),
    p_purchase: input.purchase,
    p_lines: input.lines,
  });
  if (error) return { ok:false, error:error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) return { ok:false, error:'Cloud supplier return was not committed' };
  return {
    ok:true,
    alreadyCommitted:row.already_committed === true,
    returnId:row.return_id,
    returnNo:row.return_no,
    total:Number(row.total || 0),
    purchaseId:row.purchase_id,
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
  if (error || !data || !data.state || typeof data.state !== 'object' || Array.isArray(data.state)) return null;
  const revision = Number(data.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) return null;
  setRevision(revision);
  const cloudState = sanitizeCloudSnapshotState(data.state as POSState);
  return { state: cloudState, revision };
}

export async function resolveCloudConflict(): Promise<{ state: POSState; revision: number } | null> { return downloadStateSnapshot(); }