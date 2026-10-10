import type { InventoryUnit, POSState, Purchase } from './types';
import { supabase, supabaseConfigured } from './supabase';
import { getMachineIdentity } from './machine';
import { cacheBranchStock } from './branchStock';
import { normalizeWhatsAppPhone } from './utils';

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
      branchId: undefined, // branch assignment is device-local, never replicated through shop snapshots
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

export async function adjustBranchStockAtomic(input: {
  shopId: string; branchId?: string; deviceId: string; productId: string; delta: number; note: string; adjustmentId: string;
}): Promise<{ ok: boolean; alreadyCommitted?: boolean; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud is not configured' };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { ok: false, error: sessionError.message };
  if (!sessionData.session) return { ok: false, error: 'Cloud session is not available' };
  const branch = await resolveCloudBranchId(input.shopId, input.branchId);
  if (!branch.ok || !branch.branchId) return { ok: false, error: branch.error || 'Branch is required' };
  const { data, error } = await supabase.rpc('adjust_branch_stock_atomic', {
    p_shop_id: input.shopId, p_branch_id: branch.branchId, p_device_id: input.deviceId,
    p_product_id: input.productId, p_delta: input.delta, p_note: input.note, p_adjustment_id: input.adjustmentId,
  });
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) return { ok: false, error: row?.error || 'Branch stock adjustment was not committed' };
  void refreshCloudBranchStock(input.shopId, branch.branchId).catch(() => {});
  return { ok: true, alreadyCommitted: row.already_committed === true };
}

// Atomically create tracked units or fill GRN-created placeholder identifiers.
// The database RPC also reconciles branch and shop stock, and is idempotent by unit ID.
export async function addInventoryUnitsAtomic(input: {
  shopId: string; branchId?: string; deviceId: string; units: InventoryUnit[];
}): Promise<{ ok: boolean; inserted?: number; updated?: number; productStocks?: Record<string, number>; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud is not configured' };
  if (!input.units.length || input.units.length > 500) return { ok: false, error: 'Provide between 1 and 500 units' };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { ok: false, error: sessionError.message };
  if (!sessionData.session) return { ok: false, error: 'Cloud session is not available' };
  const branch = await resolveCloudBranchId(input.shopId, input.branchId);
  if (!branch.ok || !branch.branchId) return { ok: false, error: branch.error || 'Branch is required' };
  const unitRows = input.units.map(unit => ({
    id: unit.id,
    product_id: unit.productId,
    imei: unit.imei || null,
    serial: unit.serial || null,
    expiry_date: unit.expiryDate || null,
    status: unit.status,
    cost: unit.cost ?? null,
    purchase_id: unit.purchaseId || null,
    sale_id: unit.saleId || null,
    sale_bill_no: unit.saleBillNo || null,
    note: unit.note || null,
    created_at: unit.createdAt || new Date().toISOString(),
    sold_at: unit.soldAt || null,
    warranty_expires_at: unit.warrantyExpiresAt || null,
  }));
  const { data, error } = await supabase.rpc('add_inventory_units_atomic', {
    p_shop_id: input.shopId, p_branch_id: branch.branchId, p_device_id: input.deviceId, p_units: unitRows,
  });
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) return { ok: false, error: row?.error || 'Tracked units were not committed' };
  const productIds = [...new Set(input.units.map(unit => unit.productId))];
  const { data: products } = await supabase.from('products').select('id,stock').eq('shop_id', input.shopId).in('id', productIds);
  const productStocks: Record<string, number> = {};
  for (const product of products || []) productStocks[product.id] = Number(product.stock) || 0;
  try { await refreshCloudBranchStock(input.shopId, branch.branchId); } catch { /* refresh can retry on the next settings open */ }
  return { ok: true, inserted: Number(row.inserted) || 0, updated: Number(row.updated) || 0, productStocks };
}

/** Refresh the selected branch's local offline stock cache after a cloud transaction. */
export async function refreshCloudBranchStock(shopId: string, branchId: string): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud is not configured' };
  const { data, error } = await supabase.from('branch_stock').select('product_id,qty')
    .eq('shop_id', shopId).eq('branch_id', branchId);
  if (error) return { ok: false, error: error.message };
  cacheBranchStock(branchId, (data || []) as Array<{ product_id: string; qty: number | string }>);
  return { ok: true };
}

/** Resolve a selected branch against the active shop membership. Local-only branch IDs are mapped to Main for queued legacy offline sales. */
export async function resolveCloudBranchId(shopId: string, preferredBranchId?: string): Promise<{ ok: boolean; branchId?: string; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud is not configured' };
  if (!shopId) return { ok: false, error: 'Cloud shop is not configured' };
  const { data: rows, error } = await supabase.from('branches')
    .select('id, is_default, active')
    .eq('shop_id', shopId)
    .eq('active', true)
    .order('is_default', { ascending: false });
  if (error) return { ok: false, error: `Branch lookup: ${error.message}` };
  const branches = (rows || []) as Array<{ id: string; is_default: boolean; active: boolean }>;
  if (!branches.length) return { ok: false, error: 'No active branch exists for this shop' };
  if (preferredBranchId && preferredBranchId !== 'local-main') {
    const selected = branches.find(branch => branch.id === preferredBranchId);
    if (!selected) return { ok: false, error: 'Selected branch is not active for this shop. Open Settings and select an active branch.' };
    return { ok: true, branchId: selected.id };
  }
  if (branches.length === 1) return { ok: true, branchId: branches[0].id };
  const main = branches.find(branch => branch.is_default);
  if (preferredBranchId === 'local-main' && main) return { ok: true, branchId: main.id };
  return { ok: false, error: 'Select a branch in Settings before syncing sales or receiving stock' };
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
export async function findCloudCustomerByPhone(
  phone: string,
  shopId = getCloudShopId(),
): Promise<{ ok: boolean; customer?: { id: string; phone: string | null; name: string }; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud is not configured' };
  if (!shopId) return { ok: false, error: 'Cloud shop is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };
  const normalized = normalizeWhatsAppPhone(phone);
  if (normalized.length < 9) return { ok: true };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { ok: false, error: sessionError.message };
  if (!sessionData.session) return { ok: false, error: 'Cloud session is not available' };
  const rows: Array<{ id: string; phone: string | null; name: string }> = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from('customers').select('id,phone,name')
      .eq('shop_id', shopId).order('id').range(offset, offset + 499);
    if (error) return { ok: false, error: error.message };
    const page = data || [];
    rows.push(...page);
    if (page.length < 500) break;
  }
  const exact = rows.find(row => String(row.phone || '').trim() === phone.trim());
  const match = exact || rows.find(row => row.phone && normalizeWhatsAppPhone(row.phone) === normalized);
  return { ok: true, customer: match };
}

export async function ensureCloudCustomerForSale(
  shopId: string,
  customer: { id: string; name: string; phone?: string; email?: string; nic?: string; address?: string; creditLimit?: number },
): Promise<{ ok: boolean; customerId?: string; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud is not configured' };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { ok: false, error: sessionError.message };
  if (!sessionData.session) return { ok: false, error: 'Cloud session is not available' };
  const byId = await supabase.from('customers').select('id').eq('shop_id', shopId).eq('id', customer.id).maybeSingle();
  if (byId.error) return { ok: false, error: byId.error.message };
  if (byId.data?.id) return { ok: true, customerId: byId.data.id };

  const normalized = normalizeWhatsAppPhone(customer.phone || '');
  if (normalized.length >= 9) {
    const found = await findCloudCustomerByPhone(customer.phone || '', shopId);
    if (!found.ok) return { ok: false, error: found.error };
    if (found.customer) return { ok: true, customerId: found.customer.id };
  }
  const rawPhone = String(customer.phone || '').trim();
  const national = normalized.startsWith('94') ? normalized.slice(2) : normalized;
  const placeholder = normalized === '94770000000' || (national.length >= 8 && /^(\d)\1+$/.test(national));
  const row = {
    id: customer.id, shop_id: shopId, name: customer.name.trim(),
    phone: rawPhone && !placeholder ? rawPhone : null,
    email: customer.email || null, nic: customer.nic || null, address: customer.address || null,
    credit_limit: Math.max(0, Number(customer.creditLimit || 0) || 0), notes: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const inserted = await supabase.from('customers').insert(row);
  if (!inserted.error) return { ok: true, customerId: customer.id };
  if (inserted.error.code === '23505' || /duplicate key|unique constraint/i.test(inserted.error.message)) {
    if (rawPhone) {
      const found = await findCloudCustomerByPhone(rawPhone, shopId);
      if (!found.ok) return { ok: false, error: found.error };
      if (found.customer) return { ok: true, customerId: found.customer.id };
    }
    const retryById = await supabase.from('customers').select('id').eq('shop_id', shopId).eq('id', customer.id).maybeSingle();
    if (retryById.data?.id) return { ok: true, customerId: retryById.data.id };
  }
  return { ok: false, error: inserted.error.message };
}

export async function syncNormalizedCatalog(state: POSState, shopId = getCloudShopId()): Promise<{ ok: boolean; error?: string; customerIdMap?: Record<string, string> }> {
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

  const { data: activeBranches, error: branchLookupError } = await supabase.from('branches')
    .select('id,is_default').eq('shop_id', shopId).eq('active', true);
  if (branchLookupError) return { ok: false, error: `Branches lookup: ${branchLookupError.message}` };
  const defaultBranch = (activeBranches || []).find(branch => branch.is_default);
  const selectedBranch = await resolveCloudBranchId(shopId, state.settings.branchId);
  if (!selectedBranch.ok || !selectedBranch.branchId) return { ok: false, error: selectedBranch.error || 'Select a branch before syncing catalog stock' };

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


  const productRows = state.products.map(p => ({
    id: p.id, shop_id: shopId, name: p.name, sku: p.sku || null, barcode: p.barcode || null,
    description: null, cost: p.cost || 0, price: p.price || 0, stock: Math.max(0, Math.round(Number(p.stock) || 0)), reorder_level: p.reorderLevel ?? 5,
    track_imei: !!p.trackImei, track_serial: !!p.trackSerial, track_expiry: !!p.trackExpiry,
    warranty_months: p.warrantyMonths ?? 0, is_kit: !!p.isKit, is_service: !!p.isService,
    active: p.active !== false, attributes: p.attributes || {}, image_url: null,
    category_id: null, brand_id: null, supplier_id: p.supplierId || null, created_at: p.createdAt || new Date().toISOString(),
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
      if ((activeBranches || []).length > 1 && defaultBranch && selectedBranch.branchId !== defaultBranch.id) {
        const missingIds = missing.map(row => row.id);
        const { error: clearDefaultError } = await supabase.from('branch_stock').update({ qty: 0, updated_at: new Date().toISOString() })
          .eq('shop_id', shopId).eq('branch_id', defaultBranch.id).in('product_id', missingIds);
        if (clearDefaultError) return { ok: false, error: `Initial branch stock allocation: ${clearDefaultError.message}` };
        const { error: allocateError } = await supabase.from('branch_stock').upsert(
          missing.map(row => ({ shop_id: shopId, branch_id: selectedBranch.branchId, product_id: row.id, qty: row.stock, updated_at: new Date().toISOString() })),
          { onConflict: 'branch_id,product_id' },
        );
        if (allocateError) return { ok: false, error: `Initial branch stock allocation: ${allocateError.message}` };
      }
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
      if ((activeBranches || []).length > 1) {
        const bootstrapIds = bootstrapRows.map(row => row.product_id);
        const { error: clearDefaultError } = await supabase.from('branch_stock').update({ qty: 0, updated_at: new Date().toISOString() })
          .eq('shop_id', shopId).eq('branch_id', defaultBranch?.id || '').in('product_id', bootstrapIds);
        if (clearDefaultError) return { ok: false, error: `Bootstrap branch allocation: ${clearDefaultError.message}` };
        const { error: allocateError } = await supabase.from('branch_stock').upsert(
          bootstrapRows.map(row => ({ shop_id: shopId, branch_id: selectedBranch.branchId, product_id: row.product_id, qty: row.stock, updated_at: new Date().toISOString() })),
          { onConflict: 'branch_id,product_id' },
        );
        if (allocateError) return { ok: false, error: `Bootstrap branch allocation: ${allocateError.message}` };
      }
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

  const isPlaceholderCustomerPhone = (phone: string | null) => {
    if (!phone) return false;
    const normalized = normalizeWhatsAppPhone(phone);
    const national = normalized.startsWith('94') ? normalized.slice(2) : normalized;
    return normalized === '94770000000' || (national.length >= 8 && /^(\d)\1+$/.test(national));
  };
  const customerRows = state.customers.map(c => {
    const rawPhone = String(c.phone || '').trim();
    // Known demo/placeholder numbers are not real contact identities. Keep
    // them local, but don't let them reserve a unique cloud phone.
    const phone = !rawPhone || isPlaceholderCustomerPhone(rawPhone) ? null : rawPhone;
    return {
      id: c.id, shop_id: shopId, name: c.name, phone, email: c.email || null,
      nic: c.nic || null, address: c.address || null, credit_limit: Math.max(0, Number(c.creditLimit ?? 0) || 0), notes: null,
      created_at: c.createdAt || new Date().toISOString(), updated_at: new Date().toISOString(),
    };
  });
  const customerIdMap: Record<string, string> = {};
  if (customerRows.length) {
    // Read the full shop customer set in bounded pages so phone matching does
    // not silently miss records beyond PostgREST's default row limit.
    const cloudCustomers: Array<{ id: string; phone: string | null }> = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await supabase.from('customers')
        .select('id,phone').eq('shop_id', shopId).order('id').range(offset, offset + 499);
      if (error) return { ok: false, error: `Customers lookup: ${error.message}` };
      const page = data || [];
      cloudCustomers.push(...page);
      if (page.length < 500) break;
    }
    const cloudById = new Map(cloudCustomers.map(row => [row.id, row]));
    const cloudByExactPhone = new Map<string, { id: string; phone: string | null }>();
    const cloudByNormalizedPhone = new Map<string, { id: string; phone: string | null }>();
    for (const row of cloudCustomers) {
      const exact = String(row.phone || '').trim();
      if (exact && !cloudByExactPhone.has(exact)) cloudByExactPhone.set(exact, row);
      const normalized = normalizeWhatsAppPhone(exact);
      if (normalized && !cloudByNormalizedPhone.has(normalized)) cloudByNormalizedPhone.set(normalized, row);
    }
    const remoteForPhone = (phone: string | null) => {
      const exact = String(phone || '').trim();
      if (!exact) return undefined;
      return cloudByExactPhone.get(exact) || cloudByNormalizedPhone.get(normalizeWhatsAppPhone(exact));
    };

    // De-duplicate the local upload batch by canonical phone. Keep blank and
    // placeholder numbers out of the phone map so they can be inserted by ID.
    const localPhoneOwner = new Map<string, string>();
    const uniqueRows: typeof customerRows = [];
    for (const row of customerRows) {
      const normalized = row.phone ? normalizeWhatsAppPhone(row.phone) : '';
      const remotePhone = remoteForPhone(row.phone);
      if (cloudById.has(row.id)) {
        // An existing cloud ID owns its transaction history. Keep that ID even
        // if a differently formatted phone matches another cloud customer;
        // never merge credit/history implicitly.
        customerIdMap[row.id] = row.id;
        if (normalized && !localPhoneOwner.has(normalized)) localPhoneOwner.set(normalized, row.id);
        uniqueRows.push(row);
        continue;
      }
      if (normalized && localPhoneOwner.has(normalized)) {
        customerIdMap[row.id] = remotePhone?.id || customerIdMap[localPhoneOwner.get(normalized)!] || localPhoneOwner.get(normalized)!;
        continue;
      }
      if (normalized) localPhoneOwner.set(normalized, row.id);
      if (remotePhone) {
        customerIdMap[row.id] = remotePhone.id;
        continue;
      }
      customerIdMap[row.id] = row.id;
      uniqueRows.push(row);
    }

    const existingRows = uniqueRows.filter(row => cloudById.has(row.id));
    const missingRows = uniqueRows.filter(row => !cloudById.has(row.id) && customerIdMap[row.id] === row.id);
    // Only update editable fields. Avoid changing a phone onto one already
    // owned by a different cloud ID; preserve the existing customer's history.
    for (const row of existingRows) {
      const phoneOwner = remoteForPhone(row.phone);
      const phoneCanUpdate = !phoneOwner || phoneOwner.id === row.id;
      const updates = {
        name: row.name, email: row.email, nic: row.nic,
        address: row.address, credit_limit: row.credit_limit, updated_at: row.updated_at,
        ...(phoneCanUpdate ? { phone: row.phone } : {}),
      };
      const { error } = await supabase.from('customers').update(updates).eq('id', row.id).eq('shop_id', shopId);
      if (error) return { ok: false, error: `Customers update: ${error.message}` };
    }

    if (missingRows.length) {
      const { error } = await supabase.from('customers').insert(missingRows);
      if (error) {
        // A concurrent customer create can race the lookup. Re-read and recover
        // any phone-unique conflict; only fail if the row cannot be reconciled.
        const uniqueConflict = error.code === '23505' || /duplicate key|unique constraint/i.test(error.message);
        if (!uniqueConflict) return { ok: false, error: `Customers: ${error.message}` };
        for (const row of missingRows) {
          const current = await supabase.from('customers').select('id,phone').eq('shop_id', shopId).eq('id', row.id).maybeSingle();
          if (current.error) return { ok: false, error: `Customers conflict recovery lookup: ${current.error.message}` };
          if (current.data?.id) { customerIdMap[row.id] = current.data.id; continue; }
          const byPhone = remoteForPhone(row.phone);
          if (byPhone) { customerIdMap[row.id] = byPhone.id; continue; }
          const retry = await supabase.from('customers').insert(row);
          if (retry.error) {
            if (retry.error.code === '23505' || /duplicate key|unique constraint/i.test(retry.error.message)) {
              const latest = await supabase.from('customers').select('id,phone').eq('shop_id', shopId).eq('phone', row.phone).maybeSingle();
              if (latest.data?.id) { customerIdMap[row.id] = latest.data.id; continue; }
            }
            return { ok: false, error: `Customers insert could not be recovered: ${retry.error.message}` };
          }
          customerIdMap[row.id] = row.id;
        }
      }
    }
  }

  const unitRows = (state.units || []).filter(u => u.status === 'in_stock').map(u => {
    const requestedBranch = u.branchId || state.settings.branchId || 'local-main';
    const resolvedBranch = requestedBranch === 'local-main'
      ? defaultBranch?.id
      : (activeBranches || []).some(branch => branch.id === requestedBranch) ? requestedBranch : undefined;
    return {
      id: u.id, shop_id: shopId, branch_id: resolvedBranch, product_id: u.productId, imei: u.imei || null, serial: u.serial || null,
      expiry_date: u.expiryDate || null, cost: u.cost ?? null, warranty_expires_at: u.warrantyExpiresAt || null,
      note: u.note || null, created_at: u.createdAt || new Date().toISOString(),
    };
  });
  if (unitRows.some(row => !row.branch_id)) return { ok: false, error: 'An in-stock IMEI/serial unit has no valid branch. Open Settings and assign this device before cloud sync.' };
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
  return { ok: true, customerIdMap };
}

export async function deleteInventoryUnitAtomic(input: {
  shopId: string; branchId?: string; deviceId: string; unitId: string;
}): Promise<{ ok: boolean; productId?: string; productStock?: number; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud is not configured' };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { ok: false, error: sessionError.message };
  if (!sessionData.session) return { ok: false, error: 'Cloud session is not available' };
  const branch = await resolveCloudBranchId(input.shopId, input.branchId);
  if (!branch.ok || !branch.branchId) return { ok: false, error: branch.error || 'Branch is required' };
  const { data, error } = await supabase.rpc('delete_inventory_unit_atomic', {
    p_shop_id: input.shopId, p_branch_id: branch.branchId, p_device_id: input.deviceId, p_unit_id: input.unitId,
  });
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) return { ok: false, error: row?.error || 'Tracked unit was not deleted' };
  try { await refreshCloudBranchStock(input.shopId, branch.branchId); } catch { /* refresh can retry on next Settings open */ }
  return { ok: true, productId: row.product_id, productStock: Number(row.product_stock) || 0 };
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
  shopId: string; branchId?: string; deviceId?: string; saleId: string; customerId?: string; shipping?: number; discount?: number; taxPct?: number;
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
  const branch = await resolveCloudBranchId(input.shopId, input.branchId);
  if (!branch.ok || !branch.branchId) return { ok: false, error: branch.error || 'Branch is required' };
  const { data, error } = await supabase.rpc('complete_sale_atomic_for_device_branch', { p_shop_id: input.shopId, p_branch_id: branch.branchId, p_device_id: input.deviceId || deviceId(), p_sale_id: input.saleId, p_customer_id: input.customerId || null, p_shipping: input.shipping ?? 0, p_discount: input.discount ?? 0, p_tax_pct: input.taxPct ?? 0, p_points_redeemed: input.pointsRedeemed ?? 0, p_note: input.note || null, p_salesman_id: input.salesmanId || null, p_lines: input.lines, p_payments: input.payments });
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok || !row.sale) return { ok: false, error: String(row?.error || row?.message || 'Cloud sale was not committed') };
  void refreshCloudBranchStock(input.shopId, branch.branchId).catch(() => {});
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
  const { data: saleBranch } = await supabase.from('sales').select('branch_id').eq('shop_id', input.shopId).eq('id', input.saleId).maybeSingle();
  if (saleBranch?.branch_id) { try { await refreshCloudBranchStock(input.shopId, saleBranch.branch_id); } catch { /* retry on the next branch refresh */ } }
  return { ok: true, alreadyCommitted: row.already_committed === true, unitId: String(row.unit_id || input.unitId) };
}

export async function resolveCloudSaleIdByBillNo(input: {
  shopId?: string;
  billNo: string;
}): Promise<{ ok: boolean; saleId?: string; shopId?: string; error?: string }> {
  if (!supabaseConfigured || !supabase) return { ok: false, error: 'Cloud is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, error: 'offline' };
  const billNo = input.billNo.trim().toUpperCase();
  if (!billNo) return { ok: false, error: 'Bill number is required' };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { ok: false, error: sessionError.message };
  if (!sessionData.session) return { ok: false, error: 'Cloud session is not available' };

  const { data, error } = await supabase.rpc('resolve_sale_return_target', { p_bill_no: billNo });
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok || !row.sale_id || !row.shop_id) return { ok: false, error: row?.error || 'Sale not found' };

  // If a caller supplied a shop, reject a cross-shop resolution rather than
  // silently processing a bill from a different active shop.
  if (input.shopId && String(row.shop_id) !== input.shopId) {
    return { ok: false, error: 'Bill belongs to a different shop' };
  }
  return { ok: true, saleId: String(row.sale_id), shopId: String(row.shop_id) };
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
  if (row.sale_id) {
    const { data: saleBranch } = await supabase.from('sales').select('branch_id').eq('shop_id', input.shopId).eq('id', row.sale_id).maybeSingle();
    if (saleBranch?.branch_id) { try { await refreshCloudBranchStock(input.shopId, saleBranch.branch_id); } catch { /* retry on the next branch refresh */ } }
  }
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
  const { data: saleBranch } = await supabase.from('sales').select('branch_id').eq('shop_id', input.shopId).eq('id', input.saleId).maybeSingle();
  if (saleBranch?.branch_id) { try { await refreshCloudBranchStock(input.shopId, saleBranch.branch_id); } catch { /* retry on the next branch refresh */ } }
  return { ok: true, alreadyCommitted: row.already_committed === true, returnId: row.return_id, returnNo: row.return_no, refundAmount: Number(row.refund_amount), additionalPayment: Number(row.additional_payment), saleId: row.sale_id };
}

export async function receivePurchaseAtomic(input: {
  shopId: string; branchId?: string; purchaseId: string; deviceId: string; purchase: Purchase;
}): Promise<{ok:boolean; alreadyCommitted?:boolean; purchaseId?:string; total?:number; error?:string}> {
  if (!supabaseConfigured || !supabase) return { ok:false, error:'Cloud is not configured' };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { ok:false, error:'offline' };
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) return { ok:false, error:sessionError.message };
  if (!sessionData.session) return { ok:false, error:'Cloud session is not available' };
  if (!input.shopId || !input.purchaseId || !input.deviceId) return { ok:false, error:'Missing GRN identifiers' };
  const branch = await resolveCloudBranchId(input.shopId, input.branchId);
  if (!branch.ok || !branch.branchId) return { ok:false, error:branch.error || 'Branch is required' };
  const { data, error } = await supabase.rpc('receive_purchase_atomic_for_device_branch', {
    p_shop_id: input.shopId, p_branch_id: branch.branchId,
    p_purchase_id: input.purchaseId, p_device_id: input.deviceId, p_purchase: input.purchase,
  });
  if (error) return { ok:false, error:error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) return { ok:false, error:'Cloud GRN receive was not committed' };
  void refreshCloudBranchStock(input.shopId, branch.branchId).catch(() => {});
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
  const { data: purchaseBranch } = await supabase.from('purchases').select('branch_id').eq('shop_id', input.shopId).eq('id', input.purchaseId).maybeSingle();
  if (purchaseBranch?.branch_id) { try { await refreshCloudBranchStock(input.shopId, purchaseBranch.branch_id); } catch { /* retry on the next branch refresh */ } }
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