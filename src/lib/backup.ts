/**
 * Auto + Manual backup helpers for Nexfix POS.
 * Local JSON backup works offline; cloud backup is optional when configured.
 */

import type { POSState } from './types';
import { idbGetMeta, idbSetMeta } from './db';
import { downloadFile, dkey } from './utils';
import { backupStateToGoogle, isGoogleSyncEnabled } from './driveSync';
import { isValidInventoryTransaction } from './inventoryLedger';

export interface BackupEnvelope {
  _meta: { app: 'Nexfix POS'; version: 2; exportedAt: string; kind: 'manual' | 'auto' };
  state: POSState;
}

export function buildBackupFilename(prefix = 'nexfix-backup'): string {
  const d = new Date();
  const stamp = `${dkey(d)}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `${prefix}_${stamp}.json`;
}

function isValidIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function hasPlainObjectShape(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasArray(value: unknown): value is unknown[] { return Array.isArray(value); }

function hasUniqueStringIds(value: unknown[]): boolean {
  const ids = new Set<string>();
  for (const item of value) {
    if (!hasPlainObjectShape(item) || typeof item.id !== 'string' || item.id.length === 0 || ids.has(item.id)) return false;
    ids.add(item.id);
  }
  return true;
}

function hasValidCounters(value: Record<string, unknown>): boolean {
  const keys = ['bill', 'po', 'ex', 'job', 'quote', 'claim'];
  if (value.grn !== undefined) keys.push('grn');
  if (value.dn !== undefined) keys.push('dn');
  return keys.every((key) => {
    const n = value[key];
    return typeof n === 'number' && Number.isInteger(n) && n >= 0;
  });
}

/** Strictly validate the top-level POS collections before any restore can occur. */
function hasValidStateShape(value: unknown): value is POSState {
  if (!hasPlainObjectShape(value)) return false;
  const state = value as Record<string, unknown>;
  const requiredArrays = ['products', 'customers', 'suppliers', 'sales', 'purchases', 'expenses', 'exchanges', 'users', 'audit', 'held', 'sessions', 'units', 'repairs'];
  if (!requiredArrays.every((key) => hasArray(state[key]))) return false;
  if (!hasPlainObjectShape(state.settings) || !hasPlainObjectShape(state.permissions)) return false;
  if (!hasPlainObjectShape(state.counters) || !hasValidCounters(state.counters)) return false;
  if ('kitItems' in state && !hasArray(state.kitItems)) return false;
  if ('quotations' in state && !hasArray(state.quotations)) return false;
  if ('warrantyClaims' in state && !hasArray(state.warrantyClaims)) return false;
  if ('purchaseReturns' in state && !hasArray(state.purchaseReturns)) return false;
  if ('supplierPayments' in state && !hasArray(state.supplierPayments)) return false;
  if ('inventoryTransactions' in state && !hasArray(state.inventoryTransactions)) return false;
  if ('grns' in state && !hasArray(state.grns)) return false;
  const idCollections = ['products', 'customers', 'suppliers', 'sales', 'purchases', 'expenses', 'exchanges', 'users', 'audit', 'held', 'sessions', 'units', 'repairs', 'kitItems', 'quotations', 'warrantyClaims', 'purchaseReturns', 'supplierPayments', 'grns'];
  for (const key of idCollections) {
    const collection = state[key];
    if (collection !== undefined && (!hasArray(collection) || !hasUniqueStringIds(collection))) return false;
  }
  if (state.inventoryTransactions !== undefined) {
    const ledger = state.inventoryTransactions;
    if (!hasArray(ledger) || !ledger.every(isValidInventoryTransaction) || !hasUniqueStringIds(ledger)) return false;
  }
  const users = state.users as unknown[];
  if (!users.every((u) => {
    if (!hasPlainObjectShape(u)) return false;
    return typeof u.id === 'string' && u.id.length > 0
      && typeof u.name === 'string'
      && typeof u.email === 'string'
      && typeof u.password === 'string'
      && (u.role === 'admin' || u.role === 'cashier' || u.role === 'manager' || u.role === 'technician')
      && typeof u.active === 'boolean'
      && typeof u.createdAt === 'string'
      && isValidIsoDate(u.createdAt);
  })) return false;
  return true;
}

function normalizeRestoredState(state: POSState): POSState {
  return {
    ...state,
    kitItems: state.kitItems ?? [],
    quotations: state.quotations ?? [],
    warrantyClaims: state.warrantyClaims ?? [],
    purchaseReturns: state.purchaseReturns ?? [],
    supplierPayments: state.supplierPayments ?? [],
    inventoryTransactions: state.inventoryTransactions ?? [],
    grns: state.grns ?? [],
  };
}

export function validateBackup(input: unknown): input is BackupEnvelope {
  if (!hasPlainObjectShape(input)) return false;
  const value = input as Partial<BackupEnvelope>;
  const meta = value._meta;
  if (!hasPlainObjectShape(meta)) return false;
  return meta.app === 'Nexfix POS' && meta.version === 2 &&
    isValidIsoDate(meta.exportedAt) &&
    (meta.kind === 'manual' || meta.kind === 'auto') &&
    hasValidStateShape(value.state);
}

export function parseBackup(raw: string): BackupEnvelope | null {
  try { const parsed: unknown = JSON.parse(raw); return validateBackup(parsed) ? parsed : null; } catch { return null; }
}

export function validateBackupForRestore(input: unknown): BackupEnvelope {
  if (!validateBackup(input)) throw new Error('Invalid or unsupported Nexfix POS backup. Restore was not performed.');
  return { ...input, state: normalizeRestoredState(input.state) };
}

export interface BackupOptions { download?: boolean; cloud?: boolean; }

export async function downloadBackup(state: POSState, kind: 'manual' | 'auto' = 'manual', options: BackupOptions = {}): Promise<{ local: boolean; cloud: boolean }> {
  const wantDownload = options.download !== false;
  const wantCloud = options.cloud !== false && isGoogleSyncEnabled();
  let local = false;
  let cloud = false;
  const payload: BackupEnvelope = { _meta: { app: 'Nexfix POS', version: 2, exportedAt: new Date().toISOString(), kind }, state };
  if (wantDownload) {
    try {
      downloadFile(buildBackupFilename(kind === 'auto' ? 'nexfix-auto' : 'nexfix-backup'), JSON.stringify(payload, null, 2), 'application/json');
      local = true;
    } catch { /* metadata must not claim local success */ }
  }
  if (wantCloud && typeof navigator !== 'undefined' && navigator.onLine) {
    try { cloud = await backupStateToGoogle(payload, kind); } catch { cloud = false; }
  }
  const successful = local || cloud;
  if (successful) {
    const now = new Date().toISOString();
    const meta = await idbGetMeta();
    await idbSetMeta(kind === 'auto'
      ? { lastAutoBackupAt: now, backupCount: (meta.backupCount || 0) + 1, ...(cloud ? { lastCloudBackupAt: now } : {}) }
      : { lastManualBackupAt: now, backupCount: (meta.backupCount || 0) + 1, ...(cloud ? { lastCloudBackupAt: now } : {}) });
  }
  return { local, cloud };
}

export function startAutoBackup(getState: () => POSState, onBackup?: (at: string) => void): () => void {
  let running = false;
  const tick = async (force = false) => {
    if (running) return;
    try {
      const meta = await idbGetMeta();
      const online = typeof navigator === 'undefined' || navigator.onLine;
      const intervalHours = Number(meta.autoBackupHours) || 0;
      if (intervalHours <= 0) return;
      const last = meta.lastAutoBackupAt ? new Date(meta.lastAutoBackupAt).getTime() : 0;
      const due = Date.now() - last >= intervalHours * 60 * 60 * 1000;
      if (!force && !due) return;
      if (!online) return;
      running = true;
      const result = await downloadBackup(getState(), 'auto', { download: false, cloud: true });
      const cloudRequired = isGoogleSyncEnabled();
      const successful = cloudRequired ? result.cloud : false;
      if (successful) onBackup?.(new Date().toISOString());
    } catch { /* retry on next tick */ } finally { running = false; }
  };
  const onOnline = () => { void tick(true); };
  window.addEventListener('online', onOnline);
  const t0 = window.setTimeout(() => { void tick(false); }, 5_000);
  const interval = window.setInterval(() => { void tick(false); }, 15_000);
  return () => { window.removeEventListener('online', onOnline); clearTimeout(t0); clearInterval(interval); };
}